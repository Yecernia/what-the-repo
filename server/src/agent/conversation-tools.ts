import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runAbortCode } from '../services/execution-error.js';
import { failureMessage } from './provider-error.js';
import { buildSnapshotQueryDirectory, querySnapshotQueryDirectory, type SnapshotQueryInput } from '../domain/snapshot-query.js';
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  LearnerProfile,
  EvidenceRef,
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
import { learningStatusText } from "./prompts.js";
import { readSourcePage } from "./source-read.js";
import { STATIC_FILE_INPUT, staticFilePage } from "./static-file-facts.js";
import { MAX_REPLY_SUBMISSIONS, questionIsCurrent, questionWasDisplayed, repeatsQuestion, validateTeachingTurn, type ReplySubmissionBudget, type TeachingTurnPart, type ConversationReply } from './conversation-reply.js';
import { reviewReplyContent } from './reply-content-review.js';
import type { TeachingQuestion } from './teaching-question.js';
import type { AssessmentReviewContext } from './assessment-review-context.js';
import type { TeachingTurnCandidates } from './teaching-turn-candidate.js';
import { assessmentStatusText } from './assessment-feedback.js';
import { validateAnswerCitations } from './citations.js';
import { applyTargetAssessment, hasValidTargetPass, normalizeQuestionTargets, targetsForStep } from './target-coverage.js';

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
  component_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Original architecture component ID, not a query node_key. Specify only one selector.' })),
  relation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Original architecture relation ID; fact relations are not architecture relations. Specify only one selector.' })),
  node_key: Type.Optional(Type.String({ minLength: 1, maxLength: 266, description: 'Exact node_key or relation source_node_key/target_node_key from query_code_evidence. Only architecture component keys are supported; fact keys are rejected. Specify only one selector.' })),
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
const TEACHING_TURN_INPUT = Type.Object({
  parts: Type.Array(Type.Object({
    kind: Type.Union(['answer', 'replace', 'explain', 'control', 'other'].map(kind => Type.Literal(kind))),
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
  }), { minItems: 1, maxItems: 20 }),
});
const REPLY_INPUT = Type.Object({
  kind: Type.Union(['answer', 'lesson', 'assessment', 'action', 'unavailable'].map(value => Type.Literal(value))),
  text: Type.Optional(Type.String({ maxLength: 20_000, description: 'Required for answer/lesson prose. OMIT for assessment/action/unavailable; the program supplies their authoritative text. An empty string is also accepted.' })),
  supplement: Type.Optional(Type.String({ maxLength: 12_000, description: 'For assessment/action only: answer an independent request identified in interpret_teaching_turn. Omit when there is no current explanation/follow-up request. Do not repeat the assessment, expand future lessons, or describe action state. Self-initiated extras may be removed during repair; requested answers must remain.' })),
  question: Type.Optional(QUESTION_INPUT),
  question_id: Type.Optional(Type.String({ maxLength: 256 })),
  question_policy: Type.Optional(Type.Literal('defer', { description: 'Use only with kind=answer when the learner explicitly requests explanation without a formal question. Preserve any existing question.' })),
});
const LEARNING_ACTION_INPUT = Type.Object({
  advance_mode: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("skip")], { description: "Required only for advance_learning_step. Choose skip only when the learner wants to skip this current step; choose complete for normal advancement after verified mastery. Both present a confirmation card, never execute immediately." })),
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
  reply?: { value: ConversationReply | null };
  /** Server-validated follow-up to an executed action; contains no learner answer. */
  confirmedLesson?: boolean;
  prepareReply?: (reply: ConversationReply, signal?: AbortSignal, attempt?: number) => Promise<ReplyPreparation>;
  submissionDiagnostics?: Array<Record<string, unknown>>;
  submissionBudget?: ReplySubmissionBudget;
  assessment: {
    value: null | {
      verdict: string;
      masteredItems: string[];
      evidenceIds: string[];
      feedback?: string;
      /** Program projection rendered only after the assessment is adopted. */
      statusText?: string;
      evidence?: EvidenceRef[];
      reviewContext?: AssessmentReviewContext;
    };
  };
  candidates?: TeachingTurnCandidates;
  currentUserMessage: string;
  source_message_id?: string;
  modelRuntime: PiModelRuntime;
  workerRuns: TeachingWorkerTrace[];
  workerServices?: {
    assess?: typeof runUnderstandingAssessment;
    reviewReplyContent?: typeof reviewReplyContent;
  };
}

export interface ReplyEvidenceRepair {
  block_kind: 'assessment' | 'explanation' | 'question';
  issues?: Array<{ claim: string; reason: string; kind: string }>;
  [key: string]: unknown;
}

export type ReplyPreparation = { outcome: 'ready' | 'finalize' }
  | { outcome: 'repair'; repairs: ReplyEvidenceRepair[] };

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
  const candidateProject = structuredClone(context.project);
  if (context.candidates) context.candidates.project = candidateProject;
  // Preparation never changes the assessable study state. Only the service can
  // commit a submitted, displayed lesson together with its assistant message.
  let questionCandidate: TeachingQuestion | null = null;
  let teachingTurn: TeachingTurnPart[] | null = null;
  const initialStudy = structuredClone(candidateProject.study);
  let assessedInput: Parameters<typeof runUnderstandingAssessment>[0] | null = null;
  let assessedResult: Awaited<ReturnType<typeof runUnderstandingAssessment>> | null = null;
  let assessmentAttempted = false;
  let assessmentIrrelevant = false;
  let feedbackRepairUsed = false;
  let replyReviewRuns = 0;
  const submissionBudget = context.submissionBudget ?? { used: 0 };
  let explanationNeedsRepair = false;
  const repairAssessmentFeedback = async (input: { offendingSpans?: string[]; repair?: ReplyEvidenceRepair }, signal?: AbortSignal): Promise<boolean> => {
    if (feedbackRepairUsed || !assessedInput || !assessedResult || !context.assessment.value) return false;
    feedbackRepairUsed = true;
    const fixed = assessedResult;
    const repaired = await (context.workerServices?.assess ?? runUnderstandingAssessment)({ ...assessedInput, signal,
      feedbackRepair: { feedback: fixed.feedback!, offendingSpans: input.offendingSpans ?? [], verdict: fixed.verdict!,
        answerRelevant: fixed.answerRelevant ?? true, masteredItems: fixed.masteredItems,
        misconceptions: fixed.misconceptions, evidenceIds: fixed.acceptedEvidenceIds, targetResults: fixed.targetResults,
        feedbackScope: fixed.feedbackScope!, questionResult: fixed.questionResult,
        ...(input.repair ? { evidenceIssues: input.repair.issues ?? [],
          validationErrors: input.repair.validation_errors as string[] | undefined } : {}) } }).catch(() => null);
    if (!repaired) return false;
    repaired.trace.feedback_repair = true;
    repaired.trace.reply_submission_attempt = submissionBudget.used;
    context.workerRuns.push(repaired.trace);
    if (!repaired.completed || !repaired.feedback || repaired.verdict !== fixed.verdict
      || (repaired.answerRelevant ?? true) !== (fixed.answerRelevant ?? true)
      || !isDeepStrictEqual(repaired.masteredItems, fixed.masteredItems)
      || !isDeepStrictEqual(repaired.misconceptions, fixed.misconceptions)
      || !isDeepStrictEqual(repaired.acceptedEvidenceIds, fixed.acceptedEvidenceIds)
      || !isDeepStrictEqual(repaired.targetResults, fixed.targetResults)
      || !isDeepStrictEqual(repaired.feedbackScope, fixed.feedbackScope)
      || !isDeepStrictEqual(repaired.questionResult, fixed.questionResult)
      || !isDeepStrictEqual(repaired.reviewContext, fixed.reviewContext)) return false;
    context.assessment.value.feedback = repaired.feedback ?? undefined;
    if (fixed.verdict === 'misconception' && !fixed.misconceptions.length) {
      candidateProject.study.misconceptions = candidateProject.study.misconceptions.map(item => item === fixed.feedback ? repaired.feedback! : item);
    }
    return true;
  };
  const unavailable = () => {
    candidateProject.study = structuredClone(initialStudy);
    context.pendingLearningAction.value = null;
    context.assessment.value = null;
    questionCandidate = null;
    if (context.reply) context.reply.value = { kind: 'unavailable',
      text: context.confirmedLesson ? '本次讲解尚未完成，已确认的学习步骤保留。可以重试这次讲解。'
        : '本轮回答尚未完成，学习进度没有改变。' + (activeQuestion() ? '原题仍然有效，可以继续作答或重试换题。' : '当前没有生效的题目，可以重试本次请求。'),
      question: null, evidenceBlocks: [] };
    return textResult('submit_conversation_reply', { ok: true, terminal: 'unavailable',
      for_reply: 'The turn is unfinished. Its assessment, candidate question and unexecuted action are discarded; the original user message remains available for retry.' });
  };
  const activeQuestion = () => {
    const question = candidateProject.study.teaching_question;
    return question && questionIsCurrent(candidateProject, question)
      && questionWasDisplayed(candidateProject, question, context.source_message_id ?? '') ? question : null;
  };
  const needsInterpretation = () => Boolean(activeQuestion() && !context.confirmedLesson
    && !context.pendingLearningAction.value
    && !candidateProject.messages.find(message => message.message_id === context.source_message_id)?.learning_action_result);
  const requireInterpretation = (forAction = false) => {
    if (context.confirmedLesson) return;
    if ((forAction || needsInterpretation()) && !teachingTurn) errorResult('interpret_teaching_turn', 'First call interpret_teaching_turn with a lossless partition of the original message. Separate current explanation/follow-up requests from control instructions about route, pace or future lessons. An answer and auxiliary requests may coexist.');
  };
  const hasAnswer = () => teachingTurn?.some(part => part.kind === 'answer') ?? false;
  // Unknown/other spans are conservatively required. Only exact answer/control/
  // replacement spans can establish that an optional expansion is dispensable.
  const requiredExplanation = () => Boolean(teachingTurn?.some(part => part.kind === 'explain' || part.kind === 'other'));
  const mayOmitExpansion = () => Boolean(teachingTurn && !requiredExplanation());
  const requestsReplacement = () => Boolean(activeQuestion() && teachingTurn?.some(part => part.kind === 'replace'));
  const fullSnapshot = () => context.getSnapshot ? context.getSnapshot() : Promise.resolve(context.snapshot);
  const compactSummary = async () => context.getSummary
    ? context.getSummary() : conversationSummaryFromSource(await fullSnapshot());
  const snapshotId = context.snapshotId ?? context.snapshot?.snapshot_id ?? candidateProject.analysis.snapshot_id;
  const publicSnapshotKey = context.publicSnapshotKey === undefined
    ? candidateProject.analysis.canonical_snapshot_key : context.publicSnapshotKey;
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
      if (context.reply?.value) return errorResult(name, 'The reply is already submitted; no further tool changes are allowed.');
      if (!context.toolsUsed.includes(name)) context.toolsUsed.push(name);
      try {
        return await fn(id, params, signal);
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          if (name === 'submit_conversation_reply' && context.submissionDiagnostics && context.submissionDiagnostics.length < 12) {
            const value = params as Record<string, unknown>;
            context.submissionDiagnostics.push({ attempt: submissionBudget.used, code: error.code,
              reason: error.message.split('Offending original spans:')[0]!.split('\nRepair details:')[0]!.slice(0, 1000),
              kind: ['answer', 'lesson', 'assessment', 'action', 'unavailable'].includes(String(value.kind)) ? value.kind : 'invalid',
              has_text: typeof value.text === 'string' && Boolean(value.text.trim()),
              has_supplement: typeof value.supplement === 'string' && Boolean(value.supplement.trim()),
              has_question: Boolean(value.question || value.question_id),
              required_explanation: requiredExplanation(),
              turn_partition: teachingTurn?.map(part => ({ kind: part.kind, characters: part.text.length,
                source_sha256: createHash('sha256').update(part.text).digest('hex') })) ?? null,
              candidate_sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
          }
          if (name === 'submit_conversation_reply') {
            throw new ToolExecutionError(`Submission budget: ${submissionBudget.used}/${MAX_REPLY_SUBMISSIONS} used, ${Math.max(0, MAX_REPLY_SUBMISSIONS - submissionBudget.used)} remaining (schema and content failures share this allowance).\n` + error.message, error.code);
          }
          throw error;
        }
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
          repository: candidateProject.source.display_name,
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
    "Query the evidence graph by keyword, path, language, component or relation. Nodes retain their original id and typed node_key; relation source_node_key/target_node_key refer to those keys, even across pages. Pass an architecture endpoint unchanged as get_component_context({node_key}). Fact nodes and relations are separate from architecture components and relations. Call it before stating repository facts.",
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
        : querySnapshotQueryDirectory(buildSnapshotQueryDirectory('local:'+candidateProject.project_id,
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
          node_key: row.node_key,
          kind: row.node_kind,
          name: row.name,
          responsibility: row.responsibility,
          layer: row.layer_name,
          certainty: row.certainty,
          evidence: expose(context, linked("node", row.node_key).slice(0, 8)),
        }));
        const relations = result.edges.map((row) => ({
          id: row.edge_id,
          kind: row.edge_kind,
          source_node_key: row.source_node_key,
          target_node_key: row.target_node_key,
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
    "Read an architecture component or exact relation using exactly one of component_id, relation_id or node_key. Explicit selection overrides attachments. With no selector, use the first attached component, otherwise the first attached relation, in the current snapshot. It does not read fact nodes or arbitrary source.",
    COMPONENT_INPUT,
    async (_id, params) => {
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("get_component_context", "The project analysis has not finished.");
      const input = params as { component_id?: string; relation_id?: string; node_key?: string };
      const explicit = [input.component_id, input.relation_id, input.node_key].filter(id => id !== undefined);
      if (explicit.length > 1) return errorResult("get_component_context", "Provide exactly one of component_id, relation_id or node_key.");
      const selected = context.selected.filter((item) => item.snapshot_id === snapshot.snapshot_id);
      // Attachments are defaults for the whole selection, never for an unrequested type.
      const componentId = input.component_id
        ?? (explicit.length === 0 ? selected.find((item) => item.kind === "component")?.stable_id : undefined);
      const relationId = input.relation_id
        ?? (explicit.length === 0 ? selected.find((item) => item.kind === "relation")?.stable_id : undefined);
      if (input.node_key?.startsWith('fact:')) {
        return errorResult("get_component_context", "This is a fact node key, not an architecture component. Use its query evidence with read_source_excerpt.");
      }
      if (input.node_key !== undefined && !input.node_key.startsWith('component:')) {
        return errorResult("get_component_context", "Unknown node key namespace. Use the exact node_key returned by query_code_evidence.");
      }
      if (componentId !== undefined || input.node_key !== undefined) {
        // Compare complete typed keys; component IDs may themselves contain any prefix.
        const node = input.node_key !== undefined
          ? snapshot.graph.nodes.find(node => `component:${node.id}` === input.node_key)
          : nodeById(snapshot, componentId!);
        if (!node) return errorResult("get_component_context", "No such component in this snapshot.");
        return textResult(
          "get_component_context",
          { ok: true, component: componentPayload(context, snapshot, node) },
          { evidence_ids: nodeEvidence(node).map((row) => row.stable_id) },
        );
      }
      if (relationId !== undefined) {
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
      return errorResult("get_component_context", "Provide a component or relation ID, a query node_key, or have the learner attach one.");
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
              candidateProject.project_id,
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
        ?? await context.store.readStaticFile(candidateProject.project_id, currentSnapshotId, path);
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
        steps: candidateProject.study.dynamic_learning_plan?.length
          ? candidateProject.study.dynamic_learning_plan
          : [],
      };
      const byId = evidenceIndex(snapshot);
      const current = plan.steps[candidateProject.study.current_step] ?? null;
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
          plain_status: learningStatusText(candidateProject.study),
          study: candidateProject.study,
          learning_plan: { ...plan, steps: plan.steps.slice(0, 8) },
          has_active_route: plan.steps.length > 0 && candidateProject.study.phase !== "completed",
          route_changes_require_confirmation: true,
          current_step: current,
          current_step_evidence: evidence,
          // After a repository update: steps whose code changed. Re-verify them
          // against current evidence; never claim an earlier explanation still holds.
          code_changed_steps: candidateProject.study.migration?.to_snapshot_id === candidateProject.analysis.snapshot_id
            ? candidateProject.study.migration.items.map((item) => ({ step_id: item.step_id, title: item.title,
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

  const interpretTurn = call(
    'interpret_teaching_turn', '正在区分作答与辅助请求',
    'Before assessing a displayed question or proposing an action, partition the ENTIRE original user message exactly in order. Labels: answer (answer to the displayed question), replace (new/different question), explain (any current hint, explanation or independent factual question), control (only route/pace/stay instructions or how future lessons should work), other (uncertain/context, conservatively still requires a response). Never label an independent question control to omit it. A plan for future explanation is not a request to teach every topic now. This tool never grades or changes progress. Ordinary chat without an action or question does not require it.',
    TEACHING_TURN_INPUT,
    async (_id, params) => {
      if (context.confirmedLesson) return errorResult('interpret_teaching_turn', 'This is a program-initiated lesson. There is no learner message to partition. Read the current step and submit its lesson and check question.');
      if (assessmentAttempted || context.assessment.value || questionCandidate || context.reply?.value) return errorResult('interpret_teaching_turn', 'Interpret the message before assessment or replacement; it cannot change after that.');
      const parts = (params as { parts: TeachingTurnPart[] }).parts;
      const error = validateTeachingTurn(context.currentUserMessage, parts);
      if (error) return errorResult('interpret_teaching_turn', error);
      if (!activeQuestion() && parts.some(part => part.kind === 'answer' || part.kind === 'replace')) {
        return errorResult('interpret_teaching_turn', 'There is no displayed question. Use explain for current questions and control for route/pace instructions; do not invent an answer or replacement.');
      }
      teachingTurn = structuredClone(parts);
      return textResult('interpret_teaching_turn', { ok: true, has_answer: hasAnswer(), replacement_requested: requestsReplacement(),
        required_explanation_spans: parts.filter(part => part.kind === 'explain' || part.kind === 'other').map(part => part.text),
        optional_expansion_may_be_omitted: mayOmitExpansion(),
        answer_to_current_question: parts.filter(part => part.kind === 'answer').map(part => part.text).join('\n'),
        for_reply: hasAnswer() ? 'Assess the original displayed question before fulfilling auxiliary requests.' : 'Do not assess this request. Preserve the current question for hints/explanations; replace it only when requested.' });
    }, 'sequential',
  );

  const registerQuestion = call(
    'register_teaching_question',
    '正在记录本次理解检查问题',
    'Optionally prepare a formal check question before submit_conversation_reply(kind=lesson). Use its exact text, current learning_targets (legacy: exact completion_check), and exposed evidence. This never evaluates the current message. A saved displayed question is recovered by the program; never register a retroactive question to grade an answer or ask for a resend.',
    QUESTION_INPUT,
    async (_id, params) => {
      const snapshot = await fullSnapshot();
      const step = currentLearningStep(candidateProject);
      if (!snapshot || !step) return errorResult('register_teaching_question', 'No active learning step.');
      const input = params as Static<typeof QUESTION_INPUT>;
      requireInterpretation();
      const previous = candidateProject.study.teaching_question;
      if (previous && questionIsCurrent(candidateProject, previous)
        && previous.created_message_id !== context.source_message_id && !context.assessment.value && !context.confirmedLesson
        && (hasAnswer() || !requestsReplacement())) {
        return errorResult('register_teaching_question', 'A previously displayed question is still active. Assess the original learner answer with that question_id before replacing it. Do not register a retroactive question or ask for a resend.');
      }
      const sourceMessage = candidateProject.messages.find(message => message.message_id === context.source_message_id);
      if (sourceMessage?.learning_action_result || context.pendingLearningAction.value) {
        return errorResult('register_teaching_question', 'This turn changes the route or replays an action. Start the current lesson in a later turn.');
      }
      const targets = targetsForStep(step).map(target => target.label);
      if (!step.learning_target_defs?.length && !step.learning_targets?.length && input.prompt.trim() !== step.completion_check.trim()) {
        return errorResult('register_teaching_question', 'This legacy step has no independent targets. Ask its exact completion_check, or create a new route with explicit targets; a narrow question cannot certify the whole step.');
      }
      if (input.target_items.some(item => !targets.includes(item))) return errorResult('register_teaching_question', 'Use only the current step learning_targets.');
      const evidence = selectedEvidence(context, input.evidence_ids);
      if (evidence.length !== new Set(input.evidence_ids).size) return errorResult('register_teaching_question', 'Read every requested evidence ID first.');
      const question = normalizeQuestionTargets({
        question_id: 'question:' + randomUUID(), snapshot_id: snapshot.snapshot_id,
        route_revision: candidateProject.study.route_revision ?? 0, step_id: step.step_id,
        prompt: input.prompt, target_items: [...new Set(input.target_items)], evidence,
        answers: [], answer_message_ids: [], created_message_id: context.source_message_id ?? candidateProject.messages.at(-1)?.message_id ?? '', assessment_sequence: 0,
      }, step);
      questionCandidate = question;
      return textResult('register_teaching_question', { ok: true, question, state_changed: false, for_reply: 'Prepared only. Submit a valid lesson to display and save this question; it cannot be assessed yet.' });
    },
    'sequential',
  );

  const assessment = call(
    "assess_understanding",
    "正在判断当前理解和遗漏",
    "Call only when the learner is answering the current step's check question. The program binds their original answer; the assessment returns a judgment and never advances the course.",
    ASSESSMENT_INPUT,
    async (_id, params, signal) => {
      if (context.confirmedLesson) return errorResult('assess_understanding', 'A program-initiated lesson contains no learner answer and cannot receive an assessment.');
      if (assessedResult) return errorResult('assess_understanding', 'This original answer already has a prepared assessment. Its judgment is locked for this turn; submit the prepared feedback or use unavailable.');
      if (assessmentAttempted) return errorResult('assess_understanding', 'The assessment attempt for this original message and displayed question is locked for this turn. Handle its actual requests without reassessing, or submit unavailable.');
      const sourceMessage = candidateProject.messages.find(message => message.message_id === context.source_message_id);
      requireInterpretation();
      if ((teachingTurn && !hasAnswer()) || sourceMessage?.learning_action_result) {
        return errorResult('assess_understanding', 'This turn requests a lesson, skips or replays a learning action, not a learner answer. Do not assess it.');
      }
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("assess_understanding", "No learning route has been generated yet.");
      if (
        !candidateProject.study.dynamic_learning_plan?.length
        || candidateProject.study.current_step >= candidateProject.study.dynamic_learning_plan.length
      ) {
        return errorResult(
          "assess_understanding",
          "There is no current learning step to assess; progress is unchanged.",
        );
      }
      const input = params as { question_id: string; evidence_ids?: string[] };
      const question = candidateProject.study.teaching_question;
      const step = currentLearningStep(candidateProject);
      const messageId = context.source_message_id ?? candidateProject.messages.at(-1)?.message_id ?? '';
      if (!question || question.question_id !== input.question_id || question.step_id !== step?.step_id
        || question.snapshot_id !== snapshot.snapshot_id || question.route_revision !== (candidateProject.study.route_revision ?? 0)
        || question.created_message_id === messageId || !questionWasDisplayed(candidateProject, question, messageId)) {
        return errorResult('assess_understanding', 'Ask a registered current question and wait for the learner answer before assessing.');
      }
      const rows = question.evidence;
      if (!rows.length) {
        return errorResult(
          "assess_understanding",
          "Read the current learning step and its evidence before assessing.",
        );
      }
      const assessmentInput: Parameters<typeof runUnderstandingAssessment>[0] = {
        answer: teachingTurn!.filter(part => part.kind === 'answer').map(part => part.text).join('\n'),
        originalMessage: context.currentUserMessage,
        answerParts: teachingTurn!.filter(part => part.kind === 'answer').map(part => part.text),
        question: structuredClone(question),
        sourceMessageId: messageId,
        evidence: structuredClone(rows),
        project: structuredClone(candidateProject),
        snapshot,
        store: context.store,
        modelRuntime: context.modelRuntime,
        signal,
      };
      assessmentAttempted = true;
      assessedInput = assessmentInput;
      const result = await (context.workerServices?.assess ?? runUnderstandingAssessment)(assessmentInput);
      context.workerRuns.push(result.trace);
      if (!result.completed || !result.feedback || !result.verdict) {
        return errorResult(
          "assess_understanding",
          "The assessment did not produce a reliable result; progress is unchanged.",
        );
      }
      if (result.answerRelevant === false) {
        assessmentIrrelevant = true;
        return errorResult('assess_understanding', 'The message does not answer the displayed question. No assessment or progress was saved. Correct the turn interpretation and handle its requests.');
      }
      if (!result.targetResults) return errorResult('assess_understanding', 'The assessment lacks target-specific proof; progress is unchanged.');
      const answerParts = teachingTurn!.filter(part => part.kind === 'answer').map(part => part.text);
      const reviewContext = result.reviewContext;
      if (!reviewContext) return errorResult('assess_understanding', 'The assessment lacks bound review context; progress is unchanged.');
      const applied = result.verdict === 'unclear' ? null
        : applyTargetAssessment(candidateProject, question, messageId, answerParts, result.targetResults, undefined, result.questionResult ?? undefined);
      assessedInput = assessmentInput;
      assessedResult = structuredClone(result);
      context.assessment.value = {
        verdict: result.verdict,
        masteredItems: result.masteredItems,
        evidenceIds: result.acceptedEvidenceIds,
        feedback: result.feedback ?? undefined,
        statusText: assessmentStatusText(result, context.currentUserMessage),
        // The owner and reviewer share the original question's source boundary.
        // Learner proof IDs stay in the locked judgments; they do not limit
        // which bound source the tutor may use to explain an unanswered part.
        evidence: assessmentInput.evidence.map(row => ({ ...row, snapshot_id: snapshot.snapshot_id })),
        reviewContext,
      };
      const stepCompleted = applied?.stepPassed ?? hasValidTargetPass(candidateProject, step!, snapshot.snapshot_id);
      if (applied) candidateProject.study.latest_assessment = {
        question_id: question.question_id, step_id: step!.step_id, snapshot_id: snapshot.snapshot_id,
        route_revision: question.route_revision, sequence: applied.sequence,
        verdict: result.verdict, step_completed: stepCompleted,
      };
      const allTargets = targetsForStep(step!);
      const mastered = new Set(candidateProject.study.mastered_target_items ?? []);
      if (applied && result.targetResults.some(target => target.outcome === 'contradicted')) {
        candidateProject.study.misconceptions = [...new Set([
          ...candidateProject.study.misconceptions, ...result.targetResults.filter(target => target.outcome === 'contradicted').map(target => target.reason),
        ])].slice(-20);
      }
      return textResult(
        "assess_understanding",
        {
          ok: true,
          verdict: result.verdict,
          feedback: result.feedback,
          mastered_items: result.masteredItems,
          misconceptions: result.misconceptions,
          evidence_ids: result.acceptedEvidenceIds,
          feedback_scope: result.feedbackScope,
          question_result: result.questionResult,
          question_correct: result.questionResult?.complete ?? result.verdict === "mastered",
          step_completed: stepCompleted,
          remaining_targets: allTargets.filter(item => !mastered.has(item.label)),
          target_results: result.targetResults,
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
    "Propose a learning action only when the current message and context express that intent. For advancing, explicitly choose advance_mode=complete or skip; a skip requires the learner wanting to leave this step without its check, not a mere mention, negation, quotation or unrelated use. Every proposal uses the existing confirmation card; no progress changes until the learner confirms. The tool never builds a route, assesses understanding or changes state.",
    LEARNING_ACTION_INPUT,
    async (_id, params) => {
      if (context.confirmedLesson) return errorResult('propose_learning_action', 'The learning action is already confirmed. Teach its current step; this program-initiated lesson cannot propose another action.');
      const snapshot = await fullSnapshot();
      if (!snapshot) return errorResult("propose_learning_action", "The project analysis has not finished.");
      const input = params as Static<typeof LEARNING_ACTION_INPUT>;
      requireInterpretation(true);
      if (hasAnswer() && !context.assessment.value) return errorResult('propose_learning_action', 'Assess the current answer before proposing any learning action.');
      if (input.action === 'advance_learning_step' ? !input.advance_mode : input.advance_mode !== undefined) {
        return errorResult('propose_learning_action', 'Specify advance_mode=complete or skip only for advance_learning_step. Interpret the learner intent in context; the program does not infer it from wording.');
      }
      const skipUnderstandingCheck = input.action === 'advance_learning_step' && input.advance_mode === 'skip';
      const existing = context.pendingLearningAction.value;
      if (existing && (existing.action !== input.action || Boolean(existing.skip_understanding_check) !== skipUnderstandingCheck
        || (input.target_kind && existing.target?.kind !== input.target_kind)
        || (input.target_id && existing.target?.stable_id !== input.target_id))) {
        return errorResult(
          "propose_learning_action",
          "A learning action was already proposed this turn; only one card per turn.",
        );
      }
      const sourceMessage = candidateProject.messages.find(message => message.message_id === context.source_message_id);
      if (sourceMessage?.learning_action_result) return errorResult('propose_learning_action', 'This message already applied a learning action. Regeneration cannot authorize another state change.');
      const step = currentLearningStep(candidateProject);
      const stored = candidateProject.study.step_passed;
      const passed = step && hasValidTargetPass(candidateProject, step, snapshot.snapshot_id) ? stored : null;

      if (input.action === "advance_learning_step" && !passed && !skipUnderstandingCheck) {
        return errorResult(
          "propose_learning_action",
          "Normal completion requires verified mastery of this step. Use skip only when the learner actually wants to skip; otherwise continue the current task.",
        );
      }
      try {
        context.pendingLearningAction.value ??= createLearningActionProposal(
          candidateProject,
          snapshot,
          {
            action: input.action,
            targetKind: input.target_kind,
            targetId: input.target_id,
            request: context.currentUserMessage,
            skipUnderstandingCheck,

            progress: input.action === "advance_learning_step" && passed && !skipUnderstandingCheck
              ? { mastered_items: passed.mastered_items, evidence_ids: passed.evidence_ids, qualification_sequence: passed.assessment_sequence }
              : null,
          },
        );
      } catch {
        return errorResult(
          "propose_learning_action",
          "This action or target does not match the current snapshot or route.",
        );
      }
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
          confirmation_required: true,
          for_reply: 'Submit kind=action and omit text. The program receipt supplies actual state and confirmation instructions. Omit supplement when this message only arranges a route or future teaching: the requested topics and pacing are retained in the proposal request. Answer any independently requested current explanation in supplement; never expand the whole course just to present a card.',
        },
        {
          state_changed: false,
        },
      );
    },
  );

  const submitReply = call(
    'submit_conversation_reply',
    '正在核对回答与学习状态',
    'Finish every reply with this tool. For answer, text is ordinary conversation. For lesson, text is explanation only: put the formal check solely in question, or reference a prepared question_id; never echo it in text. For assessment/action, OMIT text and use supplement only for a current independent explanation request; the program supplies assessment and receipt. Minimal examples: {kind:"assessment"} after grading an answer with no follow-up, {kind:"action"} after proposing a route. Never omit a requested answer or replace the assessment judgment. Schema and content failures share three submissions per turn. Never ask for a resend to repair registration.',
    REPLY_INPUT,
    async (_id, params, signal) => {
      const supplied = params as { kind: ConversationReply['kind']; text?: string; supplement?: string; question?: Static<typeof QUESTION_INPUT>; question_id?: string; question_policy?: 'defer' };
      const input = { ...supplied, text: supplied.text ?? '' };
      if (context.reply?.value) return errorResult('submit_conversation_reply', 'The reply was already submitted.');
      // Terminal fallback is available even when interpretation/assessment/action preparation failed.
      if (input.kind === 'unavailable') return unavailable();
      if (submissionBudget.used >= MAX_REPLY_SUBMISSIONS) return unavailable();
      submissionBudget.used++;
      if (context.confirmedLesson && input.kind !== 'lesson') {
        return errorResult('submit_conversation_reply', 'A program-initiated lesson must submit kind=lesson with its formal question, or unavailable. It cannot defer the question or supply an assessment or action.');
      }
      requireInterpretation(Boolean(context.pendingLearningAction.value));
      if (needsInterpretation() && hasAnswer() && !context.assessment.value && !(assessmentIrrelevant && input.kind === 'answer')) {
        return errorResult('submit_conversation_reply', 'Assess the answer to the displayed question before submitting the reply, including when another question or explanation was also requested.');
      }
      if (requestsReplacement() && !context.pendingLearningAction.value && !['lesson', 'unavailable'].includes(input.kind)) {
        return errorResult('submit_conversation_reply', 'Starting this step requires a submitted lesson and registered question. If it cannot be prepared, submit unavailable.');
      }
      if (context.pendingLearningAction.value && input.kind !== 'action') {
        return errorResult('submit_conversation_reply', 'An action was proposed. Submit kind=action; the program will describe its actual status.');
      }
      if (input.kind === 'action' && !context.pendingLearningAction.value) {
        return errorResult('submit_conversation_reply', 'No learning action is available. Propose it successfully first, or accurately answer without claiming a card is supplied.');
      }
      if (input.kind === 'assessment' && !context.assessment.value) {
        return errorResult('submit_conversation_reply', 'No reliable assessment is available. Read the saved question and assess the original answer; do not ask for a resend.');
      }
      if (context.assessment.value && input.kind === 'answer') {
        return errorResult('submit_conversation_reply', 'Preserve the assessment in an assessment, lesson or action reply. Put independent follow-up content in its appropriate slot.');
      }
      if (input.supplement && !['assessment', 'action'].includes(input.kind)) {
        return errorResult('submit_conversation_reply', 'Use text for an ordinary answer or lesson explanation. supplement belongs to assessment/action replies.');
      }
      if (['assessment', 'action'].includes(input.kind) && input.text.trim()
        && input.text.trim() !== context.assessment.value?.feedback?.trim()) {
        return errorResult('submit_conversation_reply', 'Do not put assessment or action prose in text. Leave text empty and preserve independent follow-up answers in supplement. The program supplies the authoritative result.');
      }
      let question = null;
      let originalPrompt = '';
      if (input.kind === 'lesson') {
        if (input.question) {
          questionCandidate = null;
          await registerQuestion.execute('reply-question', input.question, signal);
        }
        question = questionCandidate ? structuredClone(questionCandidate) : null;
        if (!question || !questionIsCurrent(candidateProject, question)
          || question.created_message_id !== context.source_message_id
          || (input.question_id && input.question_id !== question.question_id)) {
          return errorResult('submit_conversation_reply', 'A lesson must submit a valid exact check question with current targets and exposed evidence.');
        }
        originalPrompt = question.prompt;
        const checked = await validateAnswerCitations({ text: question.prompt, snapshot: null, getSnapshot: fullSnapshot,
          snapshotId, exposed: context.exposedEvidence, projectId: candidateProject.project_id, store: context.store });
        if (checked.errors.length) return errorResult('submit_conversation_reply', 'The check question contains unverified file references. Correct it using the exposed evidence before displaying it.');
        question.prompt = checked.text;
        if (repeatsQuestion(input.text, originalPrompt) || repeatsQuestion(checked.text === originalPrompt ? input.text : input.text.replaceAll(originalPrompt, checked.text), checked.text)) {
          return errorResult('submit_conversation_reply', 'The explanation repeats the check question. Resubmit explanation only in text; the question is rendered once from its own field.');
        }
      } else if (input.question || input.question_id) {
        return errorResult('submit_conversation_reply', 'Only a lesson can display a new formal check question.');
      }
      const explanation = ['action', 'assessment'].includes(input.kind) ? input.supplement?.trim() ?? '' : input.text.trim();
      if (!explanation && (requiredExplanation() || (explanationNeedsRepair && !mayOmitExpansion()))) {
        return errorResult('submit_conversation_reply', 'Repair the independent explanation; do not discard a requested answer to execute the action. Only self-initiated expansion may be omitted when the exact turn partition has no explain/other spans. Or submit unavailable to abandon the entire turn without changing progress.');
      }
      let text = ['action', 'assessment'].includes(input.kind) ? [context.assessment.value?.feedback, input.supplement?.trim()].filter(Boolean).join('\n\n')
          : question && originalPrompt ? [context.assessment.value?.feedback, input.text.trim()].filter(Boolean).join('\n\n') : input.text.trim();
      if (!text && !question && input.kind !== 'action') return errorResult('submit_conversation_reply', 'A nonempty reply is required.');
      while (text && (context.assessment.value || context.pendingLearningAction.value)) {
        if (replyReviewRuns >= 3) return unavailable();
        replyReviewRuns++;
        const blocks = [
          ...(context.assessment.value?.feedback ? [{ kind: 'assessment' as const, text: context.assessment.value.feedback }] : []),
          ...(explanation ? [{ kind: 'explanation' as const, text: explanation }] : []),
        ];
        const action = context.pendingLearningAction.value;
        const checked = await (context.workerServices?.reviewReplyContent ?? reviewReplyContent)({ text, blocks,
          replyKind: input.kind, action: action ? { action: action.action, execution_policy: action.execution_policy, status: action.status } : null,
          questionContext: question ? 'new_question' : activeQuestion() ? 'current_question' : 'none',
          modelRuntime: context.modelRuntime, signal }).catch(() => null);
        if (!checked) {
          return unavailable();
        }
        checked.trace.reply_submission_attempt = submissionBudget.used;
        context.workerRuns.push(checked.trace);
        if (!checked.completed) {
          return unavailable();
        }
        const assessmentSpans = checked.findings.filter(finding => finding.block_kind === 'assessment').map(finding => finding.span);
        if (assessmentSpans.length) {
          // Only the assessment owner can repair its prose, with its judgment locked.
          if (!await repairAssessmentFeedback({ offendingSpans: assessmentSpans }, signal)) return unavailable();
          text = [context.assessment.value!.feedback, explanation].filter(Boolean).join('\n\n');
          continue;
        }
        if (checked.findings.length) {
          explanationNeedsRepair ||= Boolean(explanation);
          return errorResult('submit_conversation_reply', 'explanation: Current-action instructions/status belong only to the program receipt. Revise the supplement without discarding its substantive explanation; assessment feedback is unchanged. Or submit unavailable. Offending original spans: ' + JSON.stringify(checked.findings));
        }
        break;
      }
      const candidate: ConversationReply = { kind: input.kind, text, question, evidenceBlocks: [
        ...(context.assessment.value?.feedback ? [{ kind: 'assessment' as const, text: context.assessment.value.feedback,
          evidence: context.assessment.value.evidence ?? [], assessment_context: context.assessment.value.reviewContext }] : []),
        ...(explanation ? [{ kind: 'explanation' as const, text: explanation, evidence: [] }] : []),
        ...(question ? [{ kind: 'question' as const, text: question.prompt, evidence: question.evidence.map(row => ({ ...row, snapshot_id: question.snapshot_id })) }] : []),
      ] };
      const preparation = await context.prepareReply?.(candidate, signal, submissionBudget.used) ?? { outcome: 'ready' };
      if (preparation.outcome === 'finalize') {
        // An incomplete review is not a finding the author can fix. Preserve
        // the exact candidate for partition adoption; changing it must not
        // turn an unavailable review into another semantic sample.
        if (context.reply) context.reply.value = candidate;
        context.submissionDiagnostics?.push({ attempt: submissionBudget.used, code: 'review_unavailable_terminal' });
        return textResult('submit_conversation_reply', { ok: true,
          for_reply: 'Review could not complete. Final adoption will retain only independently eligible partitions. Do not revise or resubmit this turn.' });
      }
      const repairs = preparation.outcome === 'repair' ? preparation.repairs : [];
      if (repairs.length && submissionBudget.used < MAX_REPLY_SUBMISSIONS) {
        const assessmentRepair = repairs.find(repair => repair.block_kind === 'assessment');
        let assessmentRepaired = false;
        if (assessmentRepair?.feedback_repair_allowed === true && !feedbackRepairUsed) {
          const repaired = await repairAssessmentFeedback({ repair: assessmentRepair }, signal);
          assessmentRepaired = repaired;
          context.submissionDiagnostics?.push({ attempt: submissionBudget.used,
            code: repaired ? 'assessment_feedback_repaired' : 'assessment_feedback_repair_failed',
            judgment_locked: true, evidence_locked: true });
          // Repair never commits. A new bounded submission checks the changed feedback.
          // On failure retain the original candidate for the final fail-closed gate.
        }
        // A judgment failure cannot be repaired by changing its prose. Keep the
        // immutable candidate for the final partition commit decision.
        if (assessmentRepair && !assessmentRepaired && (assessmentRepair.feedback_repair_allowed !== true || feedbackRepairUsed)
          && repairs.every(repair => repair.block_kind === 'assessment')) {
          if (context.reply) context.reply.value = candidate;
          return textResult('submit_conversation_reply', { ok: true, for_reply: 'The failed assessment candidate is saved for final adoption checks. Do not reassess or resubmit it.' });
        }
        explanationNeedsRepair ||= Boolean(explanation);
        const assessmentInstruction = assessmentRepair?.feedback_repair_allowed === false
          ? 'The assessment candidate cannot be adopted and is locked. Do not reassess it or rewrite its feedback to rescue it; repair only the other identified reply partitions. '
          : 'Assessment feedback is owned and repaired only by the assessment worker; resubmit to check its prepared feedback, never rewrite or reassess it. ';
        throw new ToolExecutionError('The candidate needs evidence repair before submission. ' + assessmentInstruction
          + 'Preserve the requested explanation and question; repair their claims/ranges using source reads, then resubmit. Do not rewrite the assessment or remove a requested follow-up. '
          + (mayOmitExpansion()
            ? assessmentRepair?.feedback_repair_allowed === false
              ? 'The exact turn partition contains no current independent explanation request: you may omit self-initiated supplement; finalization will discard the locked assessment candidate.'
              : 'The exact turn partition contains no current independent explanation request: you may omit self-initiated supplement and submit the prepared assessment/action alone.'
            : 'The current explanation is required or not yet classified; do not discard it.')
          + ' If repair cannot complete, submit unavailable.\nRepair details: ' + JSON.stringify(repairs), 'reply_evidence_repair_required');
      }
      if (explanationNeedsRepair && !explanation && mayOmitExpansion() && context.submissionDiagnostics
        && context.submissionDiagnostics.length < 12) {
        context.submissionDiagnostics.push({ attempt: submissionBudget.used, code: 'optional_expansion_omitted',
          kind: input.kind, required_explanation: false, assessment_preserved: Boolean(context.assessment.value) });
      }
      if (context.reply) context.reply.value = candidate;
      return textResult('submit_conversation_reply', { ok: true, for_reply: 'The reply is saved as a candidate. Do not produce another final text.' });
    },
    'sequential',
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
    interpretTurn,
    registerQuestion,
    assessment,
    proposeLearningAction,
    submitReply,
  ];
}
