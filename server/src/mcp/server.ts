import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import { QuotaExceededError, type ProductStore } from "../persistence/store.js";
import type { ConversationService } from "../services/conversation-service.js";
import { ProductServiceError } from "../services/errors.js";
import type { RepositoryService } from "../services/repository-service.js";
import { McpTokenVerifier } from "./auth.js";
import { OwnerRateLimiter, RepositoryMcpGateway } from "./gateway.js";

export const MCP_TOOL_NAMES = [
  "start_repository_analysis",
  "get_analysis_status",
  "list_value_points",
  "query_code_evidence",
  "get_learning_plan",
  "explain_learning_topic",
] as const;

interface McpDependencies {
  config: ServerConfig;
  store: ProductStore;
  repository: RepositoryService;
  conversation: ConversationService;
}

export function registerMcpRoutes(app: FastifyInstance, dependencies: McpDependencies): void {
  const verifier = new McpTokenVerifier(dependencies.store, dependencies.config.mcpTokens);
  const gateway = new RepositoryMcpGateway(
    dependencies.repository,
    dependencies.conversation,
    new OwnerRateLimiter(dependencies.config.mcpRequestsPerMinute),
  );

  app.post("/mcp", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const owner = await verifier.authenticate(request.headers.authorization);
    if (!owner) return authenticationRequired(reply);
    const server = createMcpServer(gateway, owner);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    reply.hijack();
    reply.raw.once("close", () => void cleanup());
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify(jsonRpcError(-32603, "MCP 请求处理失败")));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } finally {
      if (reply.raw.writableEnded) await cleanup();
    }
    return undefined;
  });
  app.get("/mcp", async (_request, reply) => methodNotAllowed(reply));
  app.delete("/mcp", async (_request, reply) => methodNotAllowed(reply));
}

function createMcpServer(
  gateway: RepositoryMcpGateway,
  owner: { owner_id: string; kind: "guest" | "github" },
): McpServer {
  const server = new McpServer({
    name: "what-the-repo",
    title: "what-the-repo",
    version: "1.0.0",
  });

  server.registerTool(MCP_TOOL_NAMES[0], {
    description: "创建公开 GitHub 仓库分析项目，或用 project_id 重新分析已有项目。不会执行仓库代码。",
    inputSchema: {
      project_id: z.string().min(1).max(128).optional(),
      kind: z.literal("github").optional(),
      value: z.string().url().max(2048).optional(),
      title: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => invoke(() => gateway.startRepositoryAnalysis(owner, input)));

  server.registerTool(MCP_TOOL_NAMES[1], {
    description: "读取一个所属项目的持久化分析任务和快照状态。",
    inputSchema: { project_id: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ project_id }) => invoke(() => gateway.getAnalysisStatus(owner, project_id)));

  server.registerTool(MCP_TOOL_NAMES[2], {
    description: "列出精确当前分析快照中有证据支持的项目价值点。",
    inputSchema: {
      project_id: z.string().min(1).max(128),
      snapshot_id: z.string().min(1).max(256),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ project_id, snapshot_id }) => invoke(() =>
    gateway.listValuePoints(owner, project_id, snapshot_id)));

  server.registerTool(MCP_TOOL_NAMES[3], {
    description: "用有界文本、路径、语言、符号、组件和关系条件查询可信代码证据图。",
    inputSchema: {
      project_id: z.string().min(1).max(128),
      snapshot_id: z.string().min(1).max(256),
      text: z.string().max(500).optional(),
      paths: z.array(z.string().max(500)).max(20).optional(),
      languages: z.array(z.string().max(100)).max(12).optional(),
      symbol_ids: z.array(z.string().max(256)).max(30).optional(),
      component_ids: z.array(z.string().max(256)).max(20).optional(),
      entity_ids: z.array(z.string().max(256)).max(30).optional(),
      entity_kinds: z.array(z.enum(["repository", "system", "subsystem", "domain", "module", "component", "fact"])).max(8).optional(),
      scope: z.enum(["self", "subtree", "ancestors", "neighbors"]).optional(),
      depth: z.number().int().min(0).max(100).optional(),
      projection: z.enum(["human", "agent"]).optional(),
      personalized_entity_ids: z.array(z.string().max(256)).max(20).optional(),
      evidence_budget_tokens: z.number().int().min(256).max(16_000).optional(),
      relation_kinds: z.array(z.string().max(100)).max(20).optional(),
      cursor: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      expand_hops: z.number().int().min(0).max(2).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ project_id, snapshot_id, ...query }) => invoke(() =>
    gateway.queryCodeEvidence(owner, project_id, snapshot_id, query)));

  server.registerTool(MCP_TOOL_NAMES[4], {
    description: "读取学习路线；提供 selected_value_point 时选择该价值点并重置项目内学习进度。",
    inputSchema: {
      project_id: z.string().min(1).max(128),
      snapshot_id: z.string().min(1).max(256),
      selected_value_point: z.string().min(1).max(512).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ project_id, snapshot_id, selected_value_point }) => invoke(() =>
    gateway.getLearningPlan(owner, project_id, snapshot_id, selected_value_point)));

  server.registerTool(MCP_TOOL_NAMES[5], {
    description: "在精确仓库快照上运行一次 Pi 对话教学，并由产品校验引用和学习状态。",
    inputSchema: {
      project_id: z.string().min(1).max(128),
      snapshot_id: z.string().min(1).max(256),
      content: z.string().min(1).max(20_000),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ project_id, snapshot_id, content }) => invoke(() =>
    gateway.explainLearningTopic(owner, project_id, snapshot_id, content)));

  return server;
}

async function invoke(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const value = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (error) {
    const failure = publicFailure(error);
    return {
      isError: true,
      content: [{ type: "text", text: `${failure.code}: ${failure.message}` }],
      structuredContent: { error: failure },
    };
  }
}

function publicFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ProductServiceError) return { code: error.code, message: error.message };
  if (error instanceof QuotaExceededError) {
    return { code: error.code, message: "当前账户已达到项目分析配额，请稍后重试" };
  }
  return { code: "internal_error", message: "MCP 工具调用失败" };
}

function authenticationRequired(reply: FastifyReply): unknown {
  reply.header("www-authenticate", "Bearer");
  return reply.code(401).send(jsonRpcError(-32001, "需要有效的 MCP Bearer Token"));
}

function methodNotAllowed(reply: FastifyReply): unknown {
  reply.header("allow", "POST");
  return reply.code(405).send(jsonRpcError(-32000, "MCP 端点只接受 POST"));
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}
