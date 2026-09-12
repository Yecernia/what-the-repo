import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  LearnerProfile,
  LearningActionCard,
  Project,
} from "../domain/conversation.js";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotNode,
} from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import type { PiMemoryRecord, PiModelRuntime } from "./types.js";
import {
  acceptFeedbackHint,
  FEEDBACK_HINT_SCHEMA,
  type FeedbackHintHolder,
} from "./feedback-hint.js";
import {
  runUnderstandingAssessment,
  type TeachingWorkerTrace,
} from "./teaching-workers.js";
import { createLearningActionProposal } from "./learning-actions.js";
import { readSourcePage } from "./source-read.js";

const EMPTY_INPUT = Type.Object({});
const VALUE_POINT_INPUT = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});
const EVIDENCE_QUERY_INPUT = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 500 })),
  paths: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 8 })),
  languages: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 8 })),
  component_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8 })),
  entity_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 12 })),
  entity_kinds: Type.Optional(Type.Array(Type.Union([
    Type.Literal("repository"), Type.Literal("system"), Type.Literal("subsystem"),
    Type.Literal("domain"), Type.Literal("module"), Type.Literal("component"), Type.Literal("fact"),
  ]), { maxItems: 8 })),
  scope: Type.Optional(Type.Union([
    Type.Literal("self"), Type.Literal("subtree"), Type.Literal("ancestors"), Type.Literal("neighbors"),
  ])),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  projection: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("agent")])),
  personalized_entity_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8 })),
  evidence_budget_tokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 16_000 })),
  relation_kinds: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 5 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 8 })),
});
const COMPONENT_INPUT = Type.Object({
  component_id: Type.Optional(Type.String({ maxLength: 256 })),
  relation_id: Type.Optional(Type.String({ maxLength: 256 })),
});
const SOURCE_INPUT = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 400 }),
  offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 120 })),
});
const ASSESSMENT_INPUT = Type.Object({
  evidence_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 10 })),
});
const LEARNING_ACTION_INPUT = Type.Object({
  action: Type.Union([
    Type.Literal("start_learning_route"),
    Type.Literal("advance_learning_step"),
    Type.Literal("switch_learning_target"),
    Type.Literal("stop_guided_learning"),
  ]),
  target_kind: Type.Optional(Type.Union([
    Type.Literal("repository"),
    Type.Literal("value_point"),
    Type.Literal("component"),
    Type.Literal("layer"),
    Type.Literal("learning_step"),
  ])),
  target_id: Type.Optional(Type.String({ maxLength: 256 })),
});

type ToolDetails = {
  tool_name: string;
  evidence_ids: string[];
  paths: string[];
  state_changed?: boolean;
  worker_run_id?: string;
  error?: string;
};

export interface ConversationToolContext {
  project: Project;
  snapshot: EvidenceSnapshot | null;
  profile: LearnerProfile;
  agentMemories: PiMemoryRecord[];
  store: ProductStore;
  selected: { snapshot_id: string; kind: string; stable_id: string; label: string } | null;
  exposedEvidence: Map<string, SnapshotEvidence>;
  exposedPaths: Set<string>;
  toolsUsed: string[];
  pendingLearningAction: { value: LearningActionCard | null };
  assessment: {
    value: null | {
      verdict: string;
      masteredItems: string[];
      evidenceIds: string[];
    };
  };
  currentUserMessage: string;
  modelRuntime: PiModelRuntime;
  workerRuns: TeachingWorkerTrace[];
  workerServices?: {
    assess?: typeof runUnderstandingAssessment;
  };
}

/**
 * A private side-channel from the Primary Agent to the platform feedback
 * analyser. It is deliberately separate from domain tools and never changes
 * user-visible state.
 */
export function createFeedbackHintTool(holder: FeedbackHintHolder): AgentTool {
  return {
    name: "report_feedback_hint",
    label: "记录反馈候选",
    description: "当当前用户消息可能是在评价上一条回答时，提交一个简短候选；普通追问、换话题或继续学习不要调用。调用后仍要正常回答用户。",
    parameters: FEEDBACK_HINT_SCHEMA,
    execute: async (_toolCallId, params) => {
      acceptFeedbackHint(holder, params as Static<typeof FEEDBACK_HINT_SCHEMA>);
      return textResult("report_feedback_hint", { recorded: true });
    },
  };
}

function textResult(
  toolName: string,
  payload: unknown,
  details: Partial<ToolDetails> = {},
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: {
      tool_name: toolName,
      evidence_ids: details.evidence_ids ?? [],
      paths: details.paths ?? [],
      ...details,
    },
  };
}

export class ToolExecutionError extends Error {
  readonly code: string;

  constructor(message: string, code = "tool_request_rejected") {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

function errorResult(_toolName: string, message: string): never {
  // Pi Core turns thrown tool failures into an isError tool result and lets the
  // model decide whether to correct the arguments or choose another tool.
  throw new ToolExecutionError(message);
}

function bounded<T>(rows: T[], limit: number): T[] {
  return rows.slice(0, Math.max(1, Math.min(limit, 20)));
}

function expose(
  context: ConversationToolContext,
  rows: SnapshotEvidence[],
): SnapshotEvidence[] {
  const result: SnapshotEvidence[] = [];
  for (const row of rows) {
    if (!row?.stable_id || result.some((item) => item.stable_id === row.stable_id)) continue;
    context.exposedEvidence.set(row.stable_id, row);
    context.exposedPaths.add(row.path);
    result.push(row);
  }
  return result;
}

function nodeEvidence(node: SnapshotNode): SnapshotEvidence[] {
  return [...(node.evidence ?? []), ...(node.members ?? [])];
}

function nodeById(snapshot: EvidenceSnapshot, id: string): SnapshotNode | undefined {
  return snapshot.graph.nodes.find((node) => node.id === id);
}

function edgeById(snapshot: EvidenceSnapshot, id: string): SnapshotEdge | undefined {
  return snapshot.graph.edges.find((edge) => edge.id === id);
}

function evidenceIndex(snapshot: EvidenceSnapshot): Map<string, SnapshotEvidence> {
  const rows = [
    ...snapshot.graph.nodes.flatMap((node) => [...node.evidence, ...node.members]),
    ...snapshot.graph.edges.flatMap((edge) => edge.evidence),
    ...snapshot.graph.layers.flatMap((layer) => layer.evidence),
    ...snapshot.value_points.flatMap((point) => point.evidence),
    ...(snapshot.fact_graph?.nodes
      .filter((node) => node.lifecycle_status !== "tombstoned" && node.lifecycle_status !== "superseded")
      .flatMap((node) => [...node.evidence, ...node.members]) ?? []),
    ...(snapshot.fact_graph?.edges
      .filter((edge) => edge.lifecycle_status !== "tombstoned" && edge.lifecycle_status !== "superseded")
      .flatMap((edge) => edge.evidence) ?? []),
  ];
  return new Map(rows.filter((row) => row?.stable_id).map((row) => [row.stable_id, row]));
}

function selectedEvidence(
  context: ConversationToolContext,
  requestedIds: string[] | undefined,
): SnapshotEvidence[] {
  const requested = requestedIds?.length
    ? requestedIds
    : [...context.exposedEvidence.keys()];
  return requested
    .map((id) => context.exposedEvidence.get(id))
    .filter((row): row is SnapshotEvidence => Boolean(row))
    .filter((row, index, all) => all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index)
    .slice(0, 10);
}

function makeTool<T extends typeof EMPTY_INPUT>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  executionMode: ToolExecutionMode | undefined,
  execute: (
    id: string,
    params: Static<T>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<ToolDetails>>,
): AgentTool<T, ToolDetails> {
  return {
    name,
    label,
    description,
    parameters,
    executionMode,
    execute,
  };
}

function componentPayload(
  context: ConversationToolContext,
  node: SnapshotNode,
): Record<string, unknown> {
  const snapshot = context.snapshot;
  if (!snapshot) return {};
  const evidence = expose(context, bounded(nodeEvidence(node), 12));
  const adjacent = snapshot.graph.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .slice(0, 12);
  const adjacentIds = new Set(adjacent.flatMap((edge) => [edge.source, edge.target]));
  const neighbors = [...adjacentIds]
    .filter((id) => id !== node.id)
    .map((id) => nodeById(snapshot, id))
    .filter((item): item is SnapshotNode => Boolean(item))
    .slice(0, 12)
    .map((item) => ({
      id: item.id,
      name: item.name,
      responsibility: item.responsibility,
    }));
  return {
    id: node.id,
    name: node.name,
    responsibility: node.responsibility,
    layer: node.architecture_layer_name,
    certainty: node.certainty,
    member_count: node.member_count,
    members: node.members.slice(0, 12).map((item) => ({
      path: item.path,
      label: item.label,
      evidence_id: item.stable_id,
    })),
    adjacent_relations: adjacent.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.relation_kind,
      label: edge.label,
      description: edge.description,
      evidence: expose(context, bounded(edge.evidence, 4)),
    })),
    neighbors,
    evidence,
  };
}

export function createConversationTools(
  context: ConversationToolContext,
): AgentTool[] {
  const call = <T extends typeof EMPTY_INPUT>(
    name: string,
    label: string,
    description: string,
    parameters: T,
    fn: (
      id: string,
      params: Static<T>,
      signal?: AbortSignal,
    ) => Promise<AgentToolResult<ToolDetails>>,
    executionMode: ToolExecutionMode | undefined = undefined,
  ): AgentTool<T, ToolDetails> => makeTool(
    name,
    label,
    description,
    parameters,
    executionMode,
    async (id, params, signal) => {
      if (!context.toolsUsed.includes(name)) context.toolsUsed.push(name);
      try {
        return await fn(id, params, signal);
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        if (signal?.aborted) throw new ToolExecutionError("这次工具调用已取消。", "cancelled");
        // Pi Core converts unexpected tool failures to isError messages. Keep
        // the original error so the model can correct a bad call or choose a
        // different tool; HTTP/SSE projections still hide internal details.
        throw error;
      }
    },
  );

  const overview = call(
    "get_project_overview",
    "正在读取项目概览",
    "读取项目规模、语言质量、组件和已有价值点。普通聊天不需要调用。",
    EMPTY_INPUT,
    async () => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("get_project_overview", "项目分析尚未完成。");
      const points = bounded(snapshot.value_points, 8).map((point) => ({
        stable_id: point.stable_id,
        title: point.title,
        claim: point.claim,
        certainty: point.certainty,
        evidence: expose(context, bounded(point.evidence, 4)),
      }));
      const components = snapshot.graph.nodes
        .filter((node) => node.id.startsWith("component:"))
        .slice(0, 20)
        .map((node) => ({
          id: node.id,
          name: node.name,
          responsibility: node.responsibility,
          layer: node.architecture_layer_name,
        }));
      return textResult(
        "get_project_overview",
        {
          ok: true,
          repository: context.project.source.display_name,
          summary: snapshot.summary,
          languages: snapshot.languages,
          components,
          value_points: points,
          semantic_mode: snapshot.graph.semantic_mode,
        },
        {
          evidence_ids: points.flatMap((item) => item.evidence.map((row) => row.stable_id)),
        },
      );
    },
  );

  const values = call(
    "list_value_points",
    "正在整理值得学习的项目价值点",
    "列出分析快照中全部已发现的价值点；数量由仓库内容决定。",
    VALUE_POINT_INPUT,
    async (_id, params, signal) => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("list_value_points", "项目分析尚未完成。");
      const limit = Number((params as { limit?: number }).limit ?? (snapshot.value_points.length || 1));
      const rows = bounded(snapshot.value_points, Math.min(limit, 8)).map((point) => ({
        ...point,
        evidence: expose(context, bounded(point.evidence, 6)),
      }));
      return textResult(
        "list_value_points",
        { ok: true, value_points: rows },
        { evidence_ids: rows.flatMap((row) => row.evidence.map((item) => item.stable_id)) },
      );
    },
  );

  const query = call(
    "query_code_evidence",
    "正在检索代码证据",
    "按关键词、路径、语言、组件或关系查询证据图谱。回答仓库事实前先调用。",
    EVIDENCE_QUERY_INPUT,
    async (_id, params) => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("query_code_evidence", "完整证据图谱暂不可用。");
      const input = params as {
        text?: string;
        paths?: string[];
        languages?: string[];
        component_ids?: string[];
        entity_ids?: string[];
        entity_kinds?: string[];
        scope?: "self" | "subtree" | "ancestors" | "neighbors";
        depth?: number;
        projection?: "human" | "agent";
        personalized_entity_ids?: string[];
        evidence_budget_tokens?: number;
        relation_kinds?: string[];
        cursor?: string;
        limit?: number;
      };
      if (context.project.analysis.canonical_snapshot_key) {
        const result = await context.store.queryPublicSnapshot({
          publicKey: context.project.analysis.canonical_snapshot_key,
          snapshotId: snapshot.snapshot_id,
          query: {
            text: input.text,
            paths: input.paths,
            languages: input.languages,
            component_ids: input.component_ids,
            entity_ids: input.entity_ids,
            entity_kinds: input.entity_kinds as any,
            scope: input.scope,
            depth: input.depth,
            projection: input.projection,
            personalized_entity_ids: input.personalized_entity_ids,
            evidence_budget_tokens: input.evidence_budget_tokens,
            relation_kinds: input.relation_kinds,
            cursor: input.cursor,
            limit: Math.min(Number(input.limit ?? 8), 12),
          },
        });
        const evidenceById = new Map(result.evidence.map((row) => [row.evidence_id, {
          stable_id: row.evidence_id,
          label: row.label,
          path: row.path,
          start_line: row.start_line,
          end_line: row.end_line,
          kind: row.kind,
          source_id: row.source_id ?? undefined,
          target_id: row.target_id ?? undefined,
        }]));
        const linked = (ownerKind: "node" | "edge", ownerKey: string) => result.evidence_links
          .filter((link) => link.owner_kind === ownerKind && link.owner_key === ownerKey)
          .map((link) => evidenceById.get(link.evidence_id))
          .filter((row): row is NonNullable<typeof row> => Boolean(row));
        const nodes = result.nodes.map((row) => ({
          id: row.node_id,
          name: row.name,
          responsibility: row.responsibility,
          layer: row.layer_name,
          evidence: expose(context, linked("node", row.node_key).slice(0, 8)),
        }));
        const relations = result.edges.map((row) => ({
          id: row.edge_id,
          source: row.source_node_key,
          target: row.target_node_key,
          relation_kind: row.relation_kind,
          label: row.label,
          description: row.description,
          evidence: expose(context, linked("edge", row.edge_key).slice(0, 4)),
        }));
        return textResult(
          "query_code_evidence",
          {
            ok: true,
            nodes,
            relations,
            matched: nodes.length + relations.length,
            next_cursor: result.next_cursor,
            truncated: result.truncated,
            estimated_tokens: result.estimated_tokens,
            budget_tokens: result.budget_tokens,
            returned_evidence_count: result.returned_evidence_count,
            truncation_reason: result.truncation_reason,
          },
          {
            evidence_ids: [...nodes, ...relations].flatMap((row) => row.evidence.map((item) => item.stable_id)),
          },
        );
      }
      const text = (input.text ?? "").toLowerCase().trim();
      const paths = input.paths ?? [];
      const languages = input.languages ?? [];
      const componentIds = new Set(input.component_ids ?? []);
      const searchableNodes = [
        ...snapshot.graph.nodes,
        ...(snapshot.fact_graph?.nodes.filter((node) =>
          node.lifecycle_status !== "tombstoned" && node.lifecycle_status !== "superseded") ?? []),
      ];
      const searchableEdges = [
        ...snapshot.graph.edges,
        ...(snapshot.fact_graph?.edges.filter((edge) =>
          edge.lifecycle_status !== "tombstoned" && edge.lifecycle_status !== "superseded") ?? []),
      ];
      const nodes = searchableNodes.filter((node) => {
        const haystack = [
          node.id,
          node.name,
          node.label,
          node.responsibility,
          node.members.map((row) => row.path).join(" "),
        ].join(" ").toLowerCase();
        const pathOk = !paths.length || node.members.some((row) =>
          paths.some((path) => row.path.includes(path)));
        const languageOk = !languages.length || node.members.some((row) =>
          languages.some((language) =>
            row.path.toLowerCase().endsWith("." + language.toLowerCase())));
        const componentOk = !componentIds.size || componentIds.has(node.id);
        return pathOk && languageOk && componentOk && (!text || haystack.includes(text));
      });
      const edges = searchableEdges.filter((edge) => {
        const kindOk = !input.relation_kinds?.length
          || input.relation_kinds.includes(edge.relation_kind);
        const haystack = [edge.id, edge.label, edge.description, edge.source, edge.target]
          .join(" ").toLowerCase();
        return kindOk && (!text || haystack.includes(text));
      });
      const limit = Number(input.limit ?? 8);
      const nodeRows = bounded(nodes, limit).map((node) => ({
        id: node.id,
        name: node.name,
        responsibility: node.responsibility,
        layer: node.architecture_layer_name,
        evidence: expose(context, bounded(nodeEvidence(node), 8)),
      }));
      const edgeRows = bounded(edges, limit).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation_kind: edge.relation_kind,
        label: edge.label,
        description: edge.description,
        evidence: expose(context, bounded(edge.evidence, 4)),
      }));
      return textResult(
        "query_code_evidence",
        { ok: true, nodes: nodeRows, relations: edgeRows, matched: nodeRows.length + edgeRows.length },
        {
          evidence_ids: [...nodeRows, ...edgeRows]
            .flatMap((row) => row.evidence.map((item) => item.stable_id)),
        },
      );
    },
  );

  const component = call(
    "get_component_context",
    "正在查询组件职责和相邻关系",
    "读取当前图选择的组件或精确关系；不会读取任意源码。",
    COMPONENT_INPUT,
    async (_id, params) => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("get_component_context", "项目分析尚未完成。");
      const input = params as { component_id?: string; relation_id?: string };
      const selected = context.selected?.snapshot_id === snapshot.snapshot_id
        ? context.selected
        : null;
      const componentId = input.component_id
        ?? (selected?.kind === "component" ? selected.stable_id : undefined);
      const relationId = input.relation_id
        ?? (selected?.kind === "relation" ? selected.stable_id : undefined);
      if (componentId) {
        const node = nodeById(snapshot, componentId);
        if (!node) return errorResult("get_component_context", "找不到这个组件。");
        return textResult(
          "get_component_context",
          { ok: true, component: componentPayload(context, node) },
          { evidence_ids: nodeEvidence(node).map((row) => row.stable_id) },
        );
      }
      if (relationId) {
        const edge = edgeById(snapshot, relationId);
        if (!edge) return errorResult("get_component_context", "找不到这条关系。");
        const source = nodeById(snapshot, edge.source);
        const target = nodeById(snapshot, edge.target);
        const evidence = expose(context, bounded(edge.evidence, 8));
        return textResult(
          "get_component_context",
          {
            ok: true,
            relation: {
              id: edge.id,
              kind: edge.relation_kind,
              label: edge.label,
              description: edge.description,
              source: source ? { id: source.id, name: source.name } : null,
              target: target ? { id: target.id, name: target.name } : null,
              evidence,
            },
          },
          { evidence_ids: evidence.map((row) => row.stable_id) },
        );
      }
      return errorResult("get_component_context", "需要提供组件或关系 ID。");
    },
  );

  const source = call(
    "read_source_excerpt",
    "正在读取有限源码片段",
    "按 1-based offset/limit 读取已经由证据工具暴露的安全源码；truncated 时根据 next_offset 继续。",
    SOURCE_INPUT,
    async (_id, params) => {
      const input = params as { path: string; offset?: number; limit?: number };
      const path = input.path.replaceAll("\\\\", "/");
      const normalized = path.startsWith("./") ? path.slice(2) : path;
      if (
        normalized.startsWith("/")
        || normalized.split("/").includes("..")
        || !context.exposedPaths.has(normalized)
      ) {
        return errorResult(
          "read_source_excerpt",
          "请先通过证据或组件工具取得这个文件路径。",
        );
      }
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("read_source_excerpt", "源码快照暂不可用。");
      try {
        const result = await readSourcePage({
          path: normalized,
          offset: input.offset,
          limit: input.limit,
          readLines: async (sourcePath, start, end) => (
            await context.store.readSourceLines(
              context.project.project_id,
              snapshot.snapshot_id,
              sourcePath,
              start,
              end,
            )
          ).lines,
        });
        const evidence = [...context.exposedEvidence.values()]
          .filter((row) => row.path === normalized);
        return textResult(
          "read_source_excerpt",
          { ok: true, ...result },
          { evidence_ids: evidence.map((row) => row.stable_id), paths: [normalized] },
        );
      } catch {
        return errorResult("read_source_excerpt", "这段源码暂时无法安全读取。");
      }
    },
    "sequential",
  );

  const learning = call(
    "get_learning_context",
    "正在读取学习路线和进度",
    "读取持久化学习进度；读取本身不会修改状态。",
    EMPTY_INPUT,
    async () => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("get_learning_context", "学习路线尚未生成。");
      const plan = {
        ...snapshot.learning_plan,
        steps: context.project.study.dynamic_learning_plan?.length
          ? context.project.study.dynamic_learning_plan
          : [],
      };
      const byId = evidenceIndex(snapshot);
      const current = plan.steps[context.project.study.current_step] ?? null;
      const evidence = expose(
        context,
        (current?.evidence_refs ?? [])
          .map((id) => byId.get(id))
          .filter((row): row is SnapshotEvidence => Boolean(row))
          .slice(0, 10),
      );
      return textResult(
        "get_learning_context",
        {
          ok: true,
          study: context.project.study,
          learning_plan: { ...plan, steps: plan.steps.slice(0, 8) },
          has_active_route: plan.steps.length > 0 && context.project.study.phase !== "completed",
          route_changes_require_confirmation: true,
          current_step: current,
          current_step_evidence: evidence,
        },
        { evidence_ids: evidence.map((row) => row.stable_id) },
      );
    },
  );

  const profile = call(
    "get_learner_profile",
    "正在读取学习画像",
    "读取用户已启用的明确画像和带来源的推断画像。",
    EMPTY_INPUT,
    async () => {
      if (!context.profile.enabled) {
        return textResult("get_learner_profile", {
          ok: true,
          enabled: false,
          message: "用户已关闭学习画像，本轮不使用画像内容。",
        });
      }
      return textResult("get_learner_profile", {
        ok: true,
        enabled: true,
        memory_summary: context.profile.memory_summary,
        memory_summary_is_projection: true,
        explicit: {
          languages: context.profile.languages,
          goals: context.profile.goals,
          experience_level: context.profile.experience_level,
          explanation_preference: context.profile.explanation_preference,
        },
        inferred: context.profile.inferred.slice(-5),
        memories: context.agentMemories.slice(-10).map((row) => ({
          key: row.key,
          value: row.value,
          confidence: row.confidence,
        })),
      });
    },
  );

  const assessment = call(
    "assess_understanding",
    "正在判断当前理解和遗漏",
    "仅在用户回答当前学习步骤的理解检验时调用。原始回答由程序绑定；评估只返回判断，不推进课程。",
    ASSESSMENT_INPUT,
    async (_id, params, signal) => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("assess_understanding", "学习路线尚未生成。");
      if (
        !context.project.study.dynamic_learning_plan?.length
        || context.project.study.current_step >= context.project.study.dynamic_learning_plan.length
      ) {
        return errorResult(
          "assess_understanding",
          "当前没有可评估的学习步骤，学习进度没有改变。",
        );
      }
      const input = params as { evidence_ids?: string[] };
      const rows = selectedEvidence(context, input.evidence_ids);
      if (!rows.length) {
        return errorResult(
          "assess_understanding",
          "请先读取当前学习步骤和证据，再判断理解。",
        );
      }
      const result = await (context.workerServices?.assess ?? runUnderstandingAssessment)({
        answer: context.currentUserMessage,
        evidence: rows,
        project: context.project,
        snapshot,
        store: context.store,
        modelRuntime: context.modelRuntime,
        signal,
      });
      context.workerRuns.push(result.trace);
      if (!result.completed || !result.feedback || !result.verdict) {
        return errorResult(
          "assess_understanding",
          "这次理解判断没有形成可靠结果，学习进度保持不变。",
        );
      }
      context.assessment.value = {
        verdict: result.verdict,
        masteredItems: result.masteredItems,
        evidenceIds: result.acceptedEvidenceIds,
      };
      return textResult(
        "assess_understanding",
        {
          ok: true,
          verdict: result.verdict,
          feedback: result.feedback,
          mastered_items: result.masteredItems,
          misconceptions: result.misconceptions,
          evidence_ids: result.acceptedEvidenceIds,
          may_propose_advance: result.verdict === "mastered",
          state_changed: false,
        },
        {
          evidence_ids: result.acceptedEvidenceIds,
          state_changed: false,
          worker_run_id: result.trace.worker_run_id,
        },
      );
    },
    "sequential",
  );

  const proposeLearningAction = call(
    "propose_learning_action",
    "正在准备学习选择卡片",
    "提出开始路线、切换目标、进入下一步或停止引导的动作建议；开始路线、切换目标和停止引导需要确认卡。用户已经明确要求直接进入下一步时，Supervisor 会把该建议记录为 skipped_steps 并直接推进；工具本身不生成路线、不评估理解、不修改状态。",
    LEARNING_ACTION_INPUT,
    async (_id, params) => {
      const snapshot = context.snapshot;
      if (!snapshot) return errorResult("propose_learning_action", "项目分析尚未完成。");
      if (context.pendingLearningAction.value) {
        return errorResult(
          "propose_learning_action",
          "本轮已经提出一个学习选择，不能重复创建卡片。",
        );
      }
      const input = params as {
        action: "start_learning_route" | "advance_learning_step" | "switch_learning_target" | "stop_guided_learning";
        target_kind?: "repository" | "value_point" | "component" | "layer" | "learning_step";
        target_id?: string;
      };
      const skipUnderstandingCheck = input.action === "advance_learning_step"
        && context.assessment.value?.verdict !== "mastered";
      try {
        context.pendingLearningAction.value = createLearningActionProposal(
          context.project,
          snapshot,
          {
            action: input.action,
            targetKind: input.target_kind,
            targetId: input.target_id,
            request: context.currentUserMessage,
            skipUnderstandingCheck,
            progress: input.action === "advance_learning_step" && context.assessment.value?.verdict === "mastered"
              ? {
                  mastered_items: context.assessment.value.masteredItems,
                  evidence_ids: context.assessment.value.evidenceIds,
                }
              : null,
          },
        );
      } catch {
        return errorResult(
          "propose_learning_action",
          "这个学习动作或目标与当前快照、路线不匹配。",
        );
      }
      return textResult(
        "propose_learning_action",
        {
          ok: true,
          proposal: {
            action_id: context.pendingLearningAction.value.action_id,
            action: context.pendingLearningAction.value.action,
            target: context.pendingLearningAction.value.target,
            title: context.pendingLearningAction.value.title,
            skipped_understanding_check: context.pendingLearningAction.value.skip_understanding_check ?? false,
          },
          state_changed: false,
          confirmation_required: true,
        },
        {
          state_changed: false,
        },
      );
    },
  );

  return [
    overview,
    values,
    query,
    component,
    source,
    learning,
    profile,
    assessment,
    proposeLearningAction,
  ];
}
