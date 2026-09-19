import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore } from "../agent/session-store.js";
import { buildApp } from "../api/app.js";
import type { ServerConfig } from "../config.js";
import { FileStore } from "../persistence/file-store.js";
import { MCP_TOOL_NAMES } from "./server.js";

const TOKEN = "mcp-test-token-123456789012345678901234567890";

function testConfig(dataDir: string): ServerConfig {
  return {
    root: dataDir,
    host: "127.0.0.1",
    port: 0,
    dataDir,
    sessionDir: join(dataDir, "pi-sessions"),
    memoryDir: join(dataDir, "pi-memory"),
    skillVersionsRoot: join(dataDir, "skill-versions"),
    nodeEnv: "test",
    sessionSecret: "test-session-secret",
    freeProviderBaseUrl: null,
    freeProviderModel: null,
    freeProviderApiKey: null,
    githubClientId: null,
    githubClientSecret: null,
    githubCallbackUrl: null,
    webUrl: "http://127.0.0.1:5307",
    databaseUrl: null,
    retentionEnabled: true,
    keyEncryptionSecret: "test-session-secret",
    quotaMaxProjects: 20,
    quotaCreationsPerHour: 30,
    quotaStorageBytes: 4 * 1024 * 1024 * 1024,
    mcpTokens: [{ token: TOKEN, ownerId: "github:test-owner" }],
    mcpRequestsPerMinute: 60,
  };
}

test("MCP exposes the six shared TypeScript product tools behind Bearer auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-mcp-"));
  const store = new FileStore(root);
  await store.init();
  await store.saveUser("github:test-owner", {
    owner_id: "github:test-owner",
    login: "test-owner",
    display_name: "Test Owner",
    avatar_url: null,
    kind: "github",
  });
  const app = buildApp({
    config: testConfig(root),
    store,
    sessions: new PiSessionStore(join(root, "pi-sessions")),
    memories: new PiMemoryStore(join(root, "pi-memory")),
  });
  let client: Client | null = null;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const unauthorized = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    client = new Client({ name: "what-the-repo-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());

    const created = await client.callTool({
      name: "start_repository_analysis",
      arguments: {
        kind: "github",
        value: "https://github.com/example/repository",
        title: "MCP 项目",
      },
    });
    assert.equal("isError" in created ? created.isError : false, false);
    const createdContent = "structuredContent" in created
      ? created.structuredContent as Record<string, unknown> | undefined
      : undefined;
    const projectId = String(createdContent?.project_id ?? "");
    assert.ok(projectId);

    const status = await client.callTool({
      name: "get_analysis_status",
      arguments: { project_id: projectId },
    });
    assert.equal("isError" in status ? status.isError : false, false);
    const statusContent = "structuredContent" in status
      ? status.structuredContent as Record<string, unknown> | undefined
      : undefined;
    assert.equal(statusContent?.project_id, projectId);
  } finally {
    await client?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
