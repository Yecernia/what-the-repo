import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { FEEDBACK_TARGET_SKILL_IDS } from "./skill-registry.js";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime } from "./types.js";
import type {
  FeedbackSignal,
  MessageFeedbackVote,
  Project,
} from "../domain/conversation.js";
import { nowIso } from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";
import { KeyedMutex } from "./mutex.js";
import type { FeedbackHint } from "./feedback-hint.js";

const FEEDBACK_RESULT = Type.Object({
  is_feedback: Type.Boolean(),
  sentiment: Type.Union([
    Type.Literal("positive"),
    Type.Literal("negative"),
    Type.Literal("mixed"),
    Type.Literal("neutral"),
  ]),
  strengths: Type.Array(Type.String({ maxLength: 240 }), { maxItems: 5 }),
  issues: Type.Array(Type.String({ maxLength: 240 }), { maxItems: 5 }),
  skill_hypotheses: Type.Array(Type.String({ maxLength: 120 }), { maxItems: 5 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

type FeedbackWorkerOutput = Static<typeof FEEDBACK_RESULT>;

const FEEDBACK_TARGET_SKILL_SET = new Set<string>(FEEDBACK_TARGET_SKILL_IDS);

function boundedMessages(project: Project): Array<{ message_id: string; role: string; content: string }> {
  return project.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-10)
    .map((message) => ({
      message_id: message.message_id,
      role: message.role,
      content: message.content.slice(0, 3_000),
    }));
}

function targetAssistant(project: Project, userMessageId?: string, explicitId?: string): string | null {
  if (explicitId) {
    return project.messages.some((message) => message.message_id === explicitId && message.role === "assistant")
      ? explicitId
      : null;
  }
  const userIndex = userMessageId
    ? project.messages.findIndex((message) => message.message_id === userMessageId)
    : project.messages.length;
  if (userIndex < 0) return null;
  return [...project.messages.slice(0, userIndex)].reverse()
    .find((message) => message.role === "assistant")?.message_id ?? null;
}

function normalizeSignal(
  value: FeedbackWorkerOutput,
  source: "button" | "language",
  explicitFeedback: boolean,
): FeedbackSignal | null {
  if (!explicitFeedback && !value.is_feedback) return null;
  const skills = value.skill_hypotheses
    .map((skill) => skill.trim())
    .filter((skill) => FEEDBACK_TARGET_SKILL_SET.has(skill));
  return {
    sentiment: value.sentiment,
    strengths: [...new Set(value.strengths.map((item) => item.trim()).filter(Boolean))].slice(0, 5),
    issues: [...new Set(value.issues.map((item) => item.trim()).filter(Boolean))].slice(0, 5),
    skill_hypotheses: [...new Set(skills)].slice(0, 5),
    confidence: Math.max(0, Math.min(1, value.confidence)),
    source,
    observed_at: nowIso(),
  };
}

function feedbackDedupeKey(signal: FeedbackSignal): string {
  const normalized = {
    skills: [...signal.skill_hypotheses].sort(),
    issues: signal.issues.map((item) => item.toLocaleLowerCase()).sort(),
    strengths: signal.strengths.map((item) => item.toLocaleLowerCase()).sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function traceEvolutionGate(trace: Record<string, unknown> | undefined): {
  eligible: boolean;
  reasons: string[];
} | null {
  if (!trace || trace.evidence_quality === undefined) return null;
  const quality = trace.evidence_quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) {
    return { eligible: false, reasons: ["evidence_quality_invalid"] };
  }
  const row = quality as Record<string, unknown>;
  return {
    eligible: row.evolution_eligible === true,
    reasons: Array.isArray(row.quality_gate_reasons)
      ? row.quality_gate_reasons.filter((value): value is string => typeof value === "string").slice(0, 12)
      : ["evidence_quality_gate_missing"],
  };
}

export interface FeedbackScheduleInput {
  ownerId: string;
  projectId: string;
  userMessageId?: string;
  targetAssistantMessageId?: string;
  vote?: MessageFeedbackVote;
  /** Primary Agent's untrusted first-pass candidate for language feedback. */
  hint?: FeedbackHint;
  modelRuntime?: PiModelRuntime;
}

/**
 * Turns a one-click reaction or an explicit natural-language reaction into a
 * small, reviewable signal. It never edits a Skill or publishes an evolution
 * candidate; it only records a privacy-bounded global request for the evolution lane.
 */
export class FeedbackAnalysisWorker {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly store: ProductStore,
    private readonly enqueueEvolution?: (requestId: string) => Promise<void>,
  ) {}

  schedule(input: FeedbackScheduleInput): Promise<void> {
    return this.mutex.runExclusive(input.ownerId, async () => {
      const project = await this.store.loadProject(input.projectId, input.ownerId);
      if (!project) return;
      const userMessage = input.userMessageId
        ? project.messages.find((message) => message.message_id === input.userMessageId && message.role === "user")
        : null;
      if (input.vote === undefined && (!userMessage || !input.hint)) return;
      const assistantId = targetAssistant(project, input.userMessageId, input.targetAssistantMessageId);
      if (!assistantId) return;
      const assistant = project.messages.find((message) => message.message_id === assistantId);
      if (!assistant || assistant.role !== "assistant" || assistant.error) return;
      const traceId = `feedback-${randomUUID().replaceAll("-", "")}`;
      if (!input.modelRuntime) {
        await this.store.saveTrace(traceId, {
          trace_id: traceId,
          event_type: "feedback_signal",
          project_id: input.projectId,
          owner_id: input.ownerId,
          source_message_id: input.userMessageId ?? null,
          target_message_id: assistantId,
          vote: input.vote ?? null,
          feedback_hint: input.hint ?? null,
          worker: "feedback-analysis",
          stop_reason: "model_unavailable",
          signal: null,
        });
        return;
      }
      const traceRows = await this.store.listTraces(input.projectId);
      const targetTrace = traceRows.find((trace) => trace.trace_id === assistant.trace_id);
      const targetTraceGate = traceEvolutionGate(targetTrace);
      const traces = traceRows
        .filter((trace) => trace.event_type !== "run_event")
        .slice(-6)
        .map((trace) => ({
          trace_id: typeof trace.trace_id === "string" ? trace.trace_id : null,
          skill_id: typeof trace.skill_id === "string" ? trace.skill_id : null,
          model: typeof trace.model === "string" ? trace.model : null,
          tools_used: Array.isArray(trace.tools_used) ? trace.tools_used.slice(0, 12) : [],
          stop_reason: typeof trace.stop_reason === "string" ? trace.stop_reason : null,
          validation_errors: Array.isArray(trace.validation_errors) ? trace.validation_errors.slice(0, 8) : [],
        }));
      const result = await runStructuredWorker({
        skillId: "feedback-analysis",
        inputSchemaId: "feedback-analysis-input-v2",
        outputSchemaId: "feedback-analysis-output-v2",
        contextBuilderId: "feedback-analysis-context-v2",
        modelRuntime: input.modelRuntime,
        thinkingLevel: "low",
        schema: FEEDBACK_RESULT,
        systemPrompt: [
          "程序已经绑定目标回答、相邻对话、脱敏 Trace、按钮投票和 Skill 白名单；当前 Skill 负责反馈语义判断方法。",
          "输出必须符合 feedback-analysis Schema，不能复述源码、API Key 或完整对话；结果只作为诊断候选，不是修改 Skill 的授权。必须调用 submit_result。",
        ].join("\n"),
        userPrompt: JSON.stringify({
          vote: input.vote ?? null,
          feedback_hint: input.hint ?? null,
          user_reaction: userMessage?.content ?? null,
          target_answer: assistant.content.slice(0, 8_000),
          recent_messages: boundedMessages(project).slice(-6),
          recent_traces: traces.slice(-3),
          allowed_skill_ids: FEEDBACK_TARGET_SKILL_IDS,
        }),
      });
      const signal = result.value
        ? normalizeSignal(result.value, input.vote ? "button" : "language", input.vote !== undefined)
        : null;
      if (signal || input.vote !== undefined) {
        await this.store.updateProject(input.projectId, input.ownerId, (row) => {
          const message = row.messages.find((item) => item.message_id === assistantId);
          if (!message || message.role !== "assistant") return;
          message.feedback = {
            vote: input.vote ?? message.feedback?.vote ?? null,
            updated_at: nowIso(),
            signal,
          };
        });
      }
      let evolutionTaskRequest: Record<string, unknown> | null = null;
      let evolutionQueueError: string | null = null;
      if (
        signal
        && signal.confidence >= 0.65
        && signal.skill_hypotheses.length > 0
        && (signal.issues.length > 0 || signal.strengths.length > 0)
      ) {
        if (targetTraceGate && !targetTraceGate.eligible) {
          evolutionTaskRequest = {
            status: "quality_gate_blocked",
            reasons: targetTraceGate.reasons,
          };
        } else {
          try {
            const observedAt = nowIso();
            const queued = await this.store.upsertEvolutionFeedbackRequest({
              request_id: `feedback-request-${randomUUID().replaceAll("-", "")}`,
              dedupe_key: feedbackDedupeKey(signal),
              trigger: "human_feedback",
              skill_ids: signal.skill_hypotheses,
              reasons: signal.issues.slice(0, 5),
              strengths: signal.strengths.slice(0, 5),
              source_trace_ids: [assistant.trace_id, traceId].filter((value): value is string => Boolean(value)),
              source_message_ids: [assistantId],
              sample_count: 1,
              owner_ids: [input.ownerId],
              owner_id: input.ownerId,
              status: "pending",
              task_ids: [],
              task_id: null,
              created_at: observedAt,
              updated_at: observedAt,
            });
            evolutionTaskRequest = {
              request_id: queued.request_id,
              trigger: queued.trigger,
              status: "pending_triage",
              target_skill_ids: queued.skill_ids,
              sample_count: queued.sample_count,
            };
            await this.enqueueEvolution?.(queued.request_id);
          } catch (error) {
            evolutionQueueError = error instanceof Error ? error.name : "unknown";
          }
        }
      }
      await this.store.saveTrace(traceId, {
        trace_id: traceId,
        event_type: "feedback_signal",
        project_id: input.projectId,
        owner_id: input.ownerId,
        source_message_id: input.userMessageId ?? null,
        target_message_id: assistantId,
        vote: input.vote ?? null,
        feedback_hint: input.hint ?? null,
        worker: "feedback-analysis",
        skill_id: result.skillId,
        skill_version: result.skillVersion,
        stop_reason: result.stopReason,
        usage: result.usage,
        signal,
        evolution_quality_gate: targetTraceGate,
        evolution_task_request: evolutionTaskRequest,
        evolution_queue_error: evolutionQueueError,
      });
    }).catch(async (error: unknown) => {
      const traceId = `feedback-${randomUUID().replaceAll("-", "")}`;
      await this.store.saveTrace(traceId, {
        trace_id: traceId,
        event_type: "feedback_signal",
        project_id: input.projectId,
        owner_id: input.ownerId,
        source_message_id: input.userMessageId ?? null,
        target_message_id: input.targetAssistantMessageId ?? null,
        vote: input.vote ?? null,
        worker: "feedback-analysis",
        stop_reason: "worker_failed",
        error_type: error instanceof Error ? error.name : "unknown",
      }).catch(() => undefined);
    });
  }
}

/** Backwards-compatible name for older integrations; new code should use the
 * platform-side FeedbackAnalysisWorker name. */
export { FeedbackAnalysisWorker as FeedbackMaintenance };
