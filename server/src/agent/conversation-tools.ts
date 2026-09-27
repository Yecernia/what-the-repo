import { randomUUID } from 'node:crypto';
import { runAbortCode } from '../services/execution-error.js';
import { failureMessage } from './provider-error.js';
import { buildSnapshotQueryDirectory, querySnapshotQueryDirectory, type SnapshotQueryInput } from '../domain/snapshot-query.js';
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  LearnerProfile,
  LearningActionCard,
  Project,
} from "../domain/conversation.js";
import { conversationSummaryFromSource, type ConversationSummary } from '../domain/conversation-summary.js';
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
import { createLearningActionProposal, currentLearningStep } from "./learning-actions.js";
import { isExplicitAdvanceRequest, learningStatusText } from "./prompts.js";
import { readSourcePage } from "./source-read.js";
import { STATIC_FILE_INPUT, staticFilePage } from "./static-file-facts.js";

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
const QUESTION_INPUT = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 1500 }),
  target_items: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 6 }),
  evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 10 }),
});
const ASSESSMENT_INPUT = Type.Object({
  question_id: Type.String({ minLength: 1, maxLength: 256 }),
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
  getSnapshot?: () => Promise<EvidenceSnapshot | null>;
  getSummary?: () => Promise<ConversationSummary | null>;
  snapshotId?: string | null;
  publicSnapshotKey?: string | null;
  assertSnapshotBinding?: () => Promise<void>;
  profile: LearnerProfile;
  agentMemories: PiMemoryRecord[];
  getLearner?: () => Promise<{ profile: LearnerProfile; memories: PiMemoryRecord[] }>;
  store: ProductStore;
  /** Graph objects the learner attached to the current message (possibly none). */
  selected: Array<{ snapshot_id: string; kind: string; stable_id: string; label: string }>;
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
  source_message_id?: string;
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
    description: "Submit a short candidate when the current message may be evaluating your previous answer. Do not call it for follow-up questions, topic changes or continued learning. Still answer the user normally afterwards.",
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
  snapshot: EvidenceSnapshot,
  node: SnapshotNode,
): Record<string, unknown> {
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
  const fullSnapshot = () => context.getSnapshot ? context.getSnapshot() : Promise.resolve(context.snapshot);
  const compactSummary = async () => context.getSummary
    ? context.getSummary() : conversationSummaryFromSource(await fullSnapshot());
  const snapshotId = context.snapshotId ?? context.snapshot?.snapshot_id ?? context.project.analysis.snapshot_id;
  const publicSnapshotKey = context.publicSnapshotKey === undefined
    ? context.project.analysis.canonical_snapshot_key : context.publicSnapshotKey;
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
        if (signal?.aborted) { const code=runAbortCode(signal.reason); throw new ToolExecutionError(failureMessage(code),code); }
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
    "Read the project's size, language coverage, components and discovered value points. Not needed for ordinary chat.",
    EMPTY_INPUT,
    async () => {
      const summary = await compactSummary();
      if (!summary) return errorResult("get_project_overview", "The project analysis has not finished.");
      const points = bounded(summary.value_points, 8).map((point) => ({
        stable_id: point.stable_id,
        title: point.title,
        claim: point.claim,
        certainty: point.certainty,
        evidence: expose(context, bounded(point.evidence, 4)),
      }));
      const components = summary.components;
      return textResult(
        "get_project_overview",
        {
          ok: true,
          repository: context.project.source.display_name,
          summary: summary.summary,
          languages: summary.languages,
          source_completeness: summary.source_completeness,
          static_limitations: summary.static_limitations,
          components,
          value_points: points,
          semantic_mode: summary.semantic_mode,
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
    "List every value point discovered in the analysis snapshot; the number depends on the repository.",
    VALUE_POINT_INPUT,
    async (_id, params, signal) => {
      const summary = await compactSummary();
      if (!summary) return errorResult("list_value_points", "The project analysis has not finished.");
      const limit = Number((params as { limit?: number }).limit ?? (summary.value_points.length || 1));
      const rows = bounded(summary.value_points, Math.min(limit, 8)).map((point) => ({
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
    "Query the evidence graph by keyword, path, language, component or relation. Call it before stating repository facts.",
    EVIDENCE_QUERY_INPUT,
    async (_id, params, signal) => {
      const snapshot = publicSnapshotKey && snapshotId ? null : await fullSnapshot();
      if (!(publicSnapshotKey && snapshotId) && !snapshot) {
        return errorResult("query_code_evidence", "The full evidence graph is not available right now.");
      }
      if (publicSnapshotKey && snapshotId) await context.assertSnapshotBinding?.();
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
      const queryInput: SnapshotQueryInput = {
        ...input, include_metadata:false, include_payload:false, evidence_per_owner:{node:8,edge:4},
        evidence_budget_tokens:input.evidence_budget_tokens ?? 4000,
        entity_kinds:input.entity_kinds as SnapshotQueryInput['entity_kinds'],limit:Math.min(Number(input.limit??8),12),
      };
      const result = publicSnapshotKey && snapshotId
        ? await context.store.queryPublicSnapshot({publicKey:publicSnapshotKey,
          snapshotId,query:queryInput,signal})
        : querySnapshotQueryDirectory(buildSnapshotQueryDirectory('local:'+context.project.project_id,
          snapshot!.snapshot_id,snapshot!,{fact_graph:snapshot!.fact_graph}),queryInput);
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
        const linked = (ownerKind: "node" | "edge", ownerKey: string) => [...new Set(result.evidence_links
          .filter(link => link.owner_kind === ownerKind && link.owner_key === ownerKey).map(link => link.evidence_id))]
          .map(id => evidenceById.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
        const nodes = result.nodes.map((row) => ({
          id: row.node_id,
          name: row.name,
          responsibility: row.responsibility,
          layer: row.layer_name,
          certainty: row.certainty,
          evidence: expose(context, linked("node", row.node_key).slice(0, 8)),
        }));
        const relations = result.edges.map((row) => ({
          id: row.edge_id,
          source: row.source_node_key,
          target: row.target_node_key,
          relation_kind: row.relation_kind,
          label: row.label,
          description: row.description,
          certainty: row.certainty,
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
            evidence_truncated:result.evidence_truncated,
            truncation_reason: result.truncation_reason,
          },
          {
            evidence_ids: [...nodes, ...relations].flatMap((row) => row.evidence.map((item) => item.stable_id)),
          },
        );
    },
  );

  const component = call(
    "get_component_context",
    "正在查询组件职责和相邻关系",
    "Read a component or an exact relation, defaulting to the first one the learner attached. It does not read arbitrary source.",
    COMPONENT_INPUT,
    async (_id, params) => {
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("get_component_context", "The project analysis has not finished.");
      const input = params as { component_id?: string; relation_id?: string };
      const selected = context.selected.filter((item) => item.snapshot_id === snapshot.snapshot_id);
      // Without an explicit id, fall back to the attached component or relation (the first, if several).
      const componentId = input.component_id
        ?? selected.find((item) => item.kind === "component")?.stable_id;
      const relationId = input.relation_id
        ?? selected.find((item) => item.kind === "relation")?.stable_id;
      if (componentId) {
        const node = nodeById(snapshot, componentId);
        if (!node) return errorResult("get_component_context", "No such component in this snapshot.");
        return textResult(
          "get_component_context",
          { ok: true, component: componentPayload(context, snapshot, node) },
          { evidence_ids: nodeEvidence(node).map((row) => row.stable_id) },
        );
      }
      if (relationId) {
        const edge = edgeById(snapshot, relationId);
        if (!edge) return errorResult("get_component_context", "No such relation in this snapshot.");
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
              certainty: edge.certainty,
              source: source ? { id: source.id, name: source.name } : null,
              target: target ? { id: target.id, name: target.name } : null,
              evidence,
            },
          },
          { evidence_ids: evidence.map((row) => row.stable_id) },
        );
      }
      return errorResult("get_component_context", "Provide a component or relation ID, or have the learner attach one.");
    },
  );

  const source = call(
    "read_source_excerpt",
    "正在读取有限源码片段",
    "Read source that an evidence tool has already exposed, using a 1-based offset and limit. When truncated, continue from next_offset only if needed.",
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
          "Expose this file path with an evidence or component tool first.",
        );
      }
      const currentSnapshotId = publicSnapshotKey && snapshotId
        ? snapshotId : (await fullSnapshot())?.snapshot_id;
      if (!currentSnapshotId) return errorResult("read_source_excerpt", "The source snapshot is not available right now.");
      if (publicSnapshotKey) await context.assertSnapshotBinding?.();
      try {
        const result = await readSourcePage({
          path: normalized,
          offset: input.offset,
          limit: input.limit,
          readLines: async (sourcePath, start, end) => (
            await context.store.readSourceLines(
              context.project.project_id,
              currentSnapshotId,
              sourcePath,
              start,
              end,
            )
          ).lines,
        });
        const evidence = result.content ? expose(context, [{
          stable_id: 'source:' + currentSnapshotId + ':' + normalized + ':' + result.start_line + '-' + result.end_line,
          label: normalized + ':' + result.start_line + '-' + result.end_line,
          path: normalized, start_line: result.start_line, end_line: result.end_line, kind: 'source_excerpt',
        }]) : [];
        return textResult(
          "read_source_excerpt",
          { ok: true, ...result, evidence },
          { evidence_ids: evidence.map((row) => row.stable_id), paths: [normalized] },
        );
      } catch {
        return errorResult("read_source_excerpt", "This source range cannot be read safely right now.");
      }
    },
    "sequential",
  );

  const staticFacts = call(
    "get_static_file_facts",
    "正在查询文件的静态调用与导入",
    "Page through call sites, imports or exports of a file already exposed by an evidence or component tool. Unresolved, candidate, external and standard-library states are preserved; a static binding does not prove a unique runtime target. query is a literal substring match on an expression or module name. offset starts at 0.",
    STATIC_FILE_INPUT,
    async (_id, params) => {
      const input = params as Static<typeof STATIC_FILE_INPUT>;
      const path = input.path.replaceAll("\\", "/");
      if (!context.exposedPaths.has(path) || path.startsWith("/") || path.split("/").includes("..")) {
        return errorResult("get_static_file_facts", "Expose this file path with an evidence or component tool first.");
      }
      const snapshot = publicSnapshotKey && snapshotId ? null : await fullSnapshot();
      const currentSnapshotId = publicSnapshotKey && snapshotId ? snapshotId : snapshot?.snapshot_id;
      if (!currentSnapshotId) return errorResult("get_static_file_facts", "Expose this file path with an evidence or component tool first.");
      if (publicSnapshotKey) await context.assertSnapshotBinding?.();
      const indexed = snapshot?.static_analysis?.files.find(file => file.path === path)
        ?? await context.store.readStaticFile(context.project.project_id, currentSnapshotId, path);
      // Legacy published views may hold inline facts that predate the per-file index.
      const file = indexed ?? (publicSnapshotKey
        ? (await fullSnapshot())?.static_analysis?.files.find(file => file.path === path) ?? null
        : null);
      return textResult("get_static_file_facts", staticFilePage(file, { ...input, path }), { paths: [path] });
    },
  );

  const learning = call(
    "get_learning_context",
    "正在读取学习路线和进度",
    "Read the saved learning route and progress. Reading changes nothing. Describe the result to the learner in plain words (see plain_status); never quote its field names or values.",
    EMPTY_INPUT,
    async () => {
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("get_learning_context", "No learning route has been generated yet.");
      const plan = {
        ...snapshot.learning_plan,
        steps: context.project.study.dynamic_learning_plan?.length
          ? context.project.study.dynamic_learning_plan
          : [],
      };
      const byId = evidenceIndex(snapshot);
      const current = plan.steps[context.project.study.current_step] ?? null;
      const refs = [...new Set(current?.evidence_refs ?? [])].slice(0, 10);
      const missing = refs.filter(id => !byId.has(id));
      if (missing.length && publicSnapshotKey) {
        const rows = await context.store.readPublicSnapshotEvidence({
          publicKey: publicSnapshotKey,
          snapshotId: snapshot.snapshot_id,
          evidenceIds: missing,
        });
        for (const row of rows) byId.set(row.stable_id, row);
      }
      const evidence = expose(
        context,
        refs
          .map((id) => byId.get(id))
          .filter((row): row is SnapshotEvidence => Boolean(row))
          .slice(0, 10),
      );
      return textResult(
        "get_learning_context",
        {
          ok: true,
          plain_status: learningStatusText(context.project.study),
          study: context.project.study,
          learning_plan: { ...plan, steps: plan.steps.slice(0, 8) },
          has_active_route: plan.steps.length > 0 && context.project.study.phase !== "completed",
          route_changes_require_confirmation: true,
          current_step: current,
          current_step_evidence: evidence,
          // After a repository update: steps whose code changed. Re-verify them
          // against current evidence; never claim an earlier explanation still holds.
          code_changed_steps: context.project.study.migration?.to_snapshot_id === context.project.analysis.snapshot_id
            ? context.project.study.migration.items.map((item) => ({ step_id: item.step_id, title: item.title,
              reason: item.reason, paths: item.paths, previously: item.previously,
              awaiting_learner_decision: item.needs_decision && !item.resolution, resolution: item.resolution }))
            : [],
        },
        { evidence_ids: evidence.map((row) => row.stable_id) },
      );
    },
  );

  const profile = call(
    "get_learner_profile",
    "正在读取学习画像",
    "Read the learner's explicit profile and sourced inferences, when the learner has enabled the profile.",
    EMPTY_INPUT,
    async () => {
      const current = context.getLearner ? await context.getLearner() : { profile: context.profile, memories: context.agentMemories };
      if (!current.profile.enabled) {
        return textResult("get_learner_profile", {
          ok: true,
          enabled: false,
          message: "The learner has turned the profile off; do not use profile content this turn.",
        });
      }
      return textResult("get_learner_profile", {
        ok: true,
        enabled: true,
        memory_summary: current.profile.memory_summary,
        memory_summary_is_projection: current.profile.memory_summary_mode !== 'edited',
        explicit: {
          languages: current.profile.languages,
          goals: current.profile.goals,
          experience_level: current.profile.experience_level,
          explanation_preference: current.profile.explanation_preference,
        },
        inferred: current.profile.inferred.slice(-5),
        memories: current.memories.slice(-10).map((row) => ({
          key: row.key,
          value: row.value,
          confidence: row.confidence,
        })),
      });
    },
  );

  const registerQuestion = call(
    'register_teaching_question',
    '正在记录本次理解检查问题',
    'Before asking a check question, register its exact text, target_items copied from current_step.learning_targets (legacy: completion_check), and exposed evidence. Relay that exact question to the learner. This never evaluates the current message. Register a new question when changing scope.',
    QUESTION_INPUT,
    async (_id, params) => {
      const snapshot = await fullSnapshot();
      const step = currentLearningStep(context.project);
      if (!snapshot || !step) return errorResult('register_teaching_question', 'No active learning step.');
      const input = params as Static<typeof QUESTION_INPUT>;
      const targets = step.learning_targets?.length ? step.learning_targets : [step.completion_check];
      if (!step.learning_targets?.length && input.prompt.trim() !== step.completion_check.trim()) {
        return errorResult('register_teaching_question', 'This legacy step has no independent targets. Ask its exact completion_check, or create a new route with explicit targets; a narrow question cannot certify the whole step.');
      }
      if (input.target_items.some(item => !targets.includes(item))) return errorResult('register_teaching_question', 'Use only the current step learning_targets.');
      const evidence = selectedEvidence(context, input.evidence_ids);
      if (evidence.length !== new Set(input.evidence_ids).size) return errorResult('register_teaching_question', 'Read every requested evidence ID first.');
      const question = {
        question_id: 'question:' + randomUUID(), snapshot_id: snapshot.snapshot_id,
        route_revision: context.project.study.route_revision ?? 0, step_id: step.step_id,
        prompt: input.prompt, target_items: [...new Set(input.target_items)], evidence,
        answers: [], answer_message_ids: [], created_message_id: context.source_message_id ?? context.project.messages.at(-1)?.message_id ?? '', assessment_sequence: 0,
      };
      context.project.study.teaching_question = question;
      return textResult('register_teaching_question', { ok: true, question, state_changed: true }, { state_changed: true });
    },
    'sequential',
  );

  const assessment = call(
    "assess_understanding",
    "正在判断当前理解和遗漏",
    "Call only when the learner is answering the current step's check question. The program binds their original answer; the assessment returns a judgment and never advances the course.",
    ASSESSMENT_INPUT,
    async (_id, params, signal) => {
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("assess_understanding", "No learning route has been generated yet.");
      if (
        !context.project.study.dynamic_learning_plan?.length
        || context.project.study.current_step >= context.project.study.dynamic_learning_plan.length
      ) {
        return errorResult(
          "assess_understanding",
          "There is no current learning step to assess; progress is unchanged.",
        );
      }
      const input = params as { question_id: string; evidence_ids?: string[] };
      const question = context.project.study.teaching_question;
      const step = currentLearningStep(context.project);
      const messageId = context.source_message_id ?? context.project.messages.at(-1)?.message_id ?? '';
      if (!question || question.question_id !== input.question_id || question.step_id !== step?.step_id
        || question.snapshot_id !== snapshot.snapshot_id || question.route_revision !== (context.project.study.route_revision ?? 0)
        || question.created_message_id === messageId) {
        return errorResult('assess_understanding', 'Ask a registered current question and wait for the learner answer before assessing.');
      }
      const rows = question.evidence;
      if (!rows.length) {
        return errorResult(
          "assess_understanding",
          "Read the current learning step and its evidence before assessing.",
        );
      }
      const result = await (context.workerServices?.assess ?? runUnderstandingAssessment)({
        answer: context.currentUserMessage,
        question,
        earlierAnswers: question.answers.filter((_answer, index) => question.answer_message_ids[index] !== messageId),
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
          "The assessment did not produce a reliable result; progress is unchanged.",
        );
      }
      context.assessment.value = {
        verdict: result.verdict,
        masteredItems: result.masteredItems,
        evidenceIds: result.acceptedEvidenceIds,
      };
      if (result.verdict !== 'unclear') {
        const answerIndex = question.answer_message_ids.indexOf(messageId);
        if (answerIndex >= 0) question.answers[answerIndex] = context.currentUserMessage.slice(0, 2000);
        else {
          question.answers.push(context.currentUserMessage.slice(0, 2000));
          question.answer_message_ids.push(messageId);
        }
        question.answers = question.answers.slice(-12);
        question.answer_message_ids = question.answer_message_ids.slice(-12);
      }
      question.assessment_sequence += 1;
      const previous = context.project.study.latest_assessment;
      const sameStep = previous?.step_id === step?.step_id && previous?.route_revision === question.route_revision && previous?.snapshot_id === snapshot.snapshot_id;
      const targetEvidence = sameStep ? { ...context.project.study.mastered_target_evidence } : {};
      const mastered = new Set(sameStep ? context.project.study.mastered_target_items ?? [] : []);
      if (result.verdict === 'mastered') for (const item of question.target_items) { mastered.add(item); targetEvidence[item] = result.acceptedEvidenceIds; }
      if (result.verdict === 'misconception' || result.verdict === 'partial') for (const item of question.target_items) { mastered.delete(item); delete targetEvidence[item]; }
      const allTargets = step?.learning_targets?.length ? step.learning_targets : [step!.completion_check];
      const stepCompleted = result.verdict === 'mastered' && allTargets.every(item => mastered.has(item));
      if (result.verdict !== 'unclear') {
        context.project.study.mastered_target_items = [...mastered];
        context.project.study.mastered_target_evidence = targetEvidence;
        context.project.study.latest_assessment = {
          question_id: question.question_id, step_id: step!.step_id, snapshot_id: snapshot.snapshot_id,
          route_revision: question.route_revision, sequence: (previous?.sequence ?? 0) + 1,
          verdict: result.verdict, step_completed: stepCompleted,
        };
        context.project.study.step_passed = stepCompleted ? {
          step_id: step!.step_id, mastered_items: [...mastered], evidence_ids: [...new Set(Object.values(targetEvidence).flat())],
          snapshot_id: snapshot.snapshot_id, route_revision: question.route_revision,
          assessment_sequence: context.project.study.latest_assessment.sequence,
        } : null;
      }
      if (result.verdict === 'misconception') context.project.study.misconceptions = [...new Set([
        ...context.project.study.misconceptions, ...(result.misconceptions.length ? result.misconceptions : [result.feedback]),
      ])].slice(-20);
      return textResult(
        "assess_understanding",
        {
          ok: true,
          verdict: result.verdict,
          feedback: result.feedback,
          mastered_items: result.masteredItems,
          misconceptions: result.misconceptions,
          evidence_ids: result.acceptedEvidenceIds,
          question_correct: result.verdict === "mastered",
          step_completed: stepCompleted,
          remaining_targets: allTargets.filter(item => !mastered.has(item)),
          may_propose_advance: stepCompleted,
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
    "Propose starting a route, switching the target, advancing to the next step or stopping guided learning. Starting, switching and stopping always show the learner a confirmation card; a normal advance after mastery does too. When the current message explicitly asks to go straight to the next step, the program records the proposal as a skipped step after the turn. The tool itself never builds a route, assesses understanding or changes state.",
    LEARNING_ACTION_INPUT,
    async (_id, params) => {
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("propose_learning_action", "The project analysis has not finished.");
      if (context.pendingLearningAction.value) {
        return errorResult(
          "propose_learning_action",
          "A learning action was already proposed this turn; only one card per turn.",
        );
      }
      const sourceMessage = context.project.messages.find(message => message.message_id === context.source_message_id);
      if (sourceMessage?.learning_action_result) return errorResult('propose_learning_action', 'This message already applied a learning action. Regeneration cannot authorize another state change.');
      const input = params as {
        action: "start_learning_route" | "advance_learning_step" | "switch_learning_target" | "stop_guided_learning";
        target_kind?: "repository" | "value_point" | "component" | "layer" | "learning_step";
        target_id?: string;
      };
      const step = currentLearningStep(context.project);
      const stored = context.project.study.step_passed;
      const latest = context.project.study.latest_assessment;
      const passed = step && stored?.step_id === step.step_id
        && stored.snapshot_id === snapshot.snapshot_id && stored.route_revision === (context.project.study.route_revision ?? 0)
        && (!latest || (latest.verdict === 'mastered' && latest.step_completed && latest.sequence === stored.assessment_sequence
          && latest.step_id === step.step_id && latest.snapshot_id === snapshot.snapshot_id && latest.route_revision === stored.route_revision))
        ? stored : null;
      if (input.action === "advance_learning_step" && !passed && !isExplicitAdvanceRequest(context.currentUserMessage)) {
        return errorResult(
          "propose_learning_action",
          "This step's check has not been passed and the learner did not ask to skip it. Assess their answer first, or ask what they want to do.",
        );
      }
      const skipUnderstandingCheck = input.action === "advance_learning_step" && !passed;
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
            progress: input.action === "advance_learning_step" && passed
              ? { mastered_items: passed.mastered_items, evidence_ids: passed.evidence_ids }
              : null,
          },
        );
      } catch {
        return errorResult(
          "propose_learning_action",
          "This action or target does not match the current snapshot or route.",
        );
      }
      // An explicit "go straight to the next step" in this message is applied after the turn without a card
      // confirmation; every other proposal waits for the learner.
      const appliedAfterTurn = Boolean(context.pendingLearningAction.value.skip_understanding_check)
        && isExplicitAdvanceRequest(context.currentUserMessage);
      return textResult(
        "propose_learning_action",
        {
          ok: true,
          proposal: {
            action: context.pendingLearningAction.value.action,
            target_label: context.pendingLearningAction.value.target?.label ?? null,
            skipped_understanding_check: context.pendingLearningAction.value.skip_understanding_check ?? false,
          },
          state_changed: false,
          confirmation_required: !appliedAfterTurn,
          for_reply: appliedAfterTurn
            ? "The step will be recorded as skipped (not mastered) once this reply completes; the learner can revisit it. "
              + "Say so in plain words. Do not mention this tool, the action name or any ID."
            : "The interface shows a confirmation card under your reply. In one or two plain sentences, say what confirming "
              + "will do and that nothing changes until the learner confirms. Do not repeat the card title, action name or any ID.",
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
    staticFacts,
    learning,
    profile,
    registerQuestion,
    assessment,
    proposeLearningAction,
  ];
}
