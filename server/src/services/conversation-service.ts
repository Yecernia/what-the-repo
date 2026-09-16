import { acquireRepositoryReadLease, type RepositoryReadLease } from '../persistence/repository-read-lease.js';
import { runtimeConfig } from '../admin/runtime-config.js';
import { assertChatHistoryCapacity } from './chat-history-limits.js';
import { isDeepStrictEqual } from 'node:util';
import type { UsageAttribution } from '../agent/provider-budget.js';
import { randomUUID } from "node:crypto";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import type { ServerConfig } from "../config.js";
import {
  createMessage,
  nowIso,
  type LearningActionCard,
  type Message,
  type MessageFeedback,
  type MessageFeedbackVote,
  type MessageThinkingSummaryEvent,
  type Project,
} from "../domain/conversation.js";
import { asEvidenceSnapshot } from "../domain/snapshot.js";
import { createModelRuntime } from "../agent/model-runtime.js";
import { runtimeForSkill } from "../agent/role-models.js";
import type { ProviderGateFactory } from "../agent/provider-gate.js";
import type { ProviderUsageBudget } from "../agent/provider-budget.js";
import { PiConversationRuntime } from "../agent/runtime.js";
import { failureMessage } from "../agent/provider-error.js";
import type {
  AgentMessage,
  PiRunEvent,
  PiRunResult,
  PiUsageSummary,
} from "../agent/types.js";
import type { PiMemoryRepository } from "../agent/memory-store.js";
import {
  PiSessionStore,
  PiSessionWaitTimeoutError,
  projectSessionId,
} from "../agent/session-store.js";
import { createConversationTools } from "../agent/conversation-tools.js";
import { createFeedbackHintTool } from "../agent/conversation-tools.js";
import type { FeedbackHint } from "../agent/feedback-hint.js";
import type { TeachingWorkerTrace } from "../agent/teaching-workers.js";
import { generateLearningRoute } from "../agent/teaching-workers.js";
import {
  applyCompletedLearningRoute,
  applyConfirmedLearningAction,
  assertLearningActionStillCurrent,
  createLearningActionProposal,
  isRouteAction,
} from "../agent/learning-actions.js";
import {
  primarySystemPrompt,
  PRIMARY_SKILL_ID,
  isExplicitAdvanceRequest,
  type UiSelection,
} from "../agent/prompts.js";
import { validateAnswerCitations, withCitationNotice } from "../agent/citations.js";
import { MemoryMaintenance } from "../agent/memory-maintenance.js";
import { generateMemorySummary } from "../agent/memory-summary.js";
import { FeedbackAnalysisWorker } from "../agent/feedback.js";
import { reviewAnswerEvidence } from "../agent/citation-review.js";
import {
  effectiveModelSelector,
  FREE_SELECTOR,
  resolveDeploymentProvider,
  resolveProvider,
} from "../agent/provider-resolver.js";
import { assertProductSkillRun, loadProductSkill } from "../agent/skill-registry.js";
import type { ProductStore } from "../persistence/store.js";
import type { TaskQueue } from "../queue/task-queue.js";
import { serviceError } from "./errors.js";
import { defaultRuntimeMetrics, type RuntimeMetrics } from "../observability/metrics.js";
import { measureEvidenceQuality } from "../domain/evidence-quality.js";

export interface ConversationOwner {
  owner_id: string;
  kind: "guest" | "github";
}

export interface ConversationResult {
  /** Transient UI notice, not a separate persisted chat message. */
  error?: { code: string; message: string };
  user_message: Message;
  assistant_message: Message;
  teaching_phase: Project["study"]["phase"];
  validation_errors: string[];
  tools_used: string[];
  state_changed: boolean;
}

export interface ConversationRunInput {
  owner: ConversationOwner;
  projectId: string;
  content: string;
  /** Current UI language is a fallback, not a forced response language. */
  displayLanguage?: string;
  replaceMessageId?: string;
  /** A browser may lose the response before learning the persisted message ID. */
  retryRunId?: string;
  selection?: UiSelection | null;
  reviewEvidence?: boolean;
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: PiRunEvent) => void;
}

export type ConversationRunControl = "pause" | "cancel";
export type LearningActionDecision = "confirm" | "decline";

export class ConversationService {
  private readonly runtime: PiConversationRuntime;
  private readonly memoryMaintenance: MemoryMaintenance;
  private readonly feedbackWorker: FeedbackAnalysisWorker;
  private readonly runOwners = new Map<string, { ownerId: string; projectId: string }>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store: ProductStore,
    sessions: PiSessionStore,
    private readonly memories: PiMemoryRepository,
    taskQueue?: TaskQueue,
    private readonly providerGateFactory?: ProviderGateFactory,
    private readonly metrics: RuntimeMetrics = defaultRuntimeMetrics,
    private readonly providerBudget?: ProviderUsageBudget,
  ) {
    this.runtime = new PiConversationRuntime(sessions, config.sessionLockWaitTimeoutMs ?? 10 * 60_000);
    this.memoryMaintenance = new MemoryMaintenance(store, memories);
    this.feedbackWorker = new FeedbackAnalysisWorker(
      store,
      taskQueue ? (requestId) => taskQueue.enqueueEvolution(requestId) : undefined,
    );
  }

  private async feedbackRuntime(taskId: string) {
    const config = await runtimeConfig(this.config, this.store);
    const feedbackProvider = resolveDeploymentProvider({
      providerId: config.feedbackProviderId,
      baseUrl: config.feedbackProviderBaseUrl,
      model: config.feedbackProviderModel,
      apiKey: config.feedbackProviderApiKey,
      connectionId: config.feedbackConnectionId ?? "platform-feedback",
    });
    return feedbackProvider
      ? createModelRuntime(feedbackProvider, {
        providerGate: this.providerGateFactory?.(feedbackProvider),
        providerBudget: this.providerBudget,
        ownerId: "system:runtime",
        attribution: { business: "evolution", payer: "platform", agentRole: "feedback-analysis", configVersion: config.adminConfigVersion, taskId },
        metrics: this.metrics,
      })
      : undefined;
  }

  controlRun(input: {
    owner: ConversationOwner;
    projectId: string;
    runId: string;
    action: ConversationRunControl;
  }): boolean {
    const owner = this.runOwners.get(input.runId);
    if (!owner || owner.ownerId !== input.owner.owner_id || owner.projectId !== input.projectId) return false;
    return input.action === "pause"
      ? this.runtime.pause(input.runId)
      : this.runtime.cancel(input.runId);
  }

  async recordFeedback(input: {
    owner: ConversationOwner;
    projectId: string;
    messageId: string;
    vote: MessageFeedbackVote;
  }): Promise<{ message_id: string; feedback: MessageFeedback }> {
    const project = await this.store.loadProject(input.projectId, input.owner.owner_id);
    if (!project) throw serviceError("not_found", "项目不存在", 404);
    const existing = project.messages.find((message) => message.message_id === input.messageId);
    if (!existing || existing.role !== "assistant" || existing.error) {
      throw serviceError("invalid_feedback_target", "只能评价已经生成的回答", 409);
    }
    const updated = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
      const message = row.messages.find((item) => item.message_id === input.messageId);
      if (!message || message.role !== "assistant") return;
      message.feedback = {
        vote: input.vote,
        updated_at: nowIso(),
        signal: message.feedback?.signal ?? null,
      };
    });
    if (!updated) throw serviceError("not_found", "项目不存在", 404);
    const message = updated.messages.find((item) => item.message_id === input.messageId);
    if (!message?.feedback) throw serviceError("invalid_feedback_target", "回答反馈未能保存", 409);

    this.feedbackWorker.schedule({
      ownerId: input.owner.owner_id,
      projectId: input.projectId,
      targetAssistantMessageId: input.messageId,
      vote: input.vote,
      modelRuntime: await this.feedbackRuntime(`feedback:${input.projectId}:${input.messageId}`),
    });
    return { message_id: input.messageId, feedback: message.feedback };
  }

  async resolveLearningAction(input: {
    owner: ConversationOwner;
    projectId: string;
    actionId: string;
    decision: LearningActionDecision;
    signal?: AbortSignal;
  }): Promise<{ project: Project; action: LearningActionCard; state_changed: boolean }> {
    const project = await this.store.loadProject(input.projectId, input.owner.owner_id);
    if (!project) throw serviceError("not_found", "项目不存在", 404);
    const snapshot = asEvidenceSnapshot(await this.store.loadSnapshot(input.projectId));
    if (!snapshot) throw serviceError("snapshot_unavailable", "项目图谱尚未完成", 404);
    const existing = findLearningAction(project, input.actionId);
    if (!existing || existing.status !== "pending") {
      throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
    }
    try {
      assertLearningActionStillCurrent(project, snapshot, existing);
    } catch {
      const expired = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || action.status !== "pending") return;
        action.status = "expired";
        action.resolved_at = nowIso();
        action.error = "学习目标或分析快照已经变化。";
      });
      const action = expired ? findLearningAction(expired, input.actionId) : null;
      if (!expired || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: expired, action, state_changed: false };
    }

    if (input.decision === "decline") {
      const declined = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || action.status !== "pending") {
          throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
        }
        action.status = "declined";
        action.resolved_at = nowIso();
      });
      const action = declined ? findLearningAction(declined, input.actionId) : null;
      if (!declined || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: declined, action, state_changed: false };
    }

    if (!isRouteAction(existing)) {
      const completed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || action.status !== "pending") {
          throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
        }
        assertLearningActionStillCurrent(row, snapshot, action);
        applyConfirmedLearningAction(row, action);
        const timestamp = nowIso();
        action.status = "executed";
        action.resolved_at = timestamp;
        action.executed_at = timestamp;
      });
      const action = completed ? findLearningAction(completed, input.actionId) : null;
      if (!completed || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: completed, action, state_changed: true };
    }

    const reserved = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
      const action = findLearningAction(row, input.actionId);
      if (!action || action.status !== "pending") {
        throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
      }
      assertLearningActionStillCurrent(row, snapshot, action);
      action.status = "confirmed";
      action.resolved_at = nowIso();
    });
    const reservedAction = reserved ? findLearningAction(reserved, input.actionId) : null;
    if (!reserved || !reservedAction?.target) throw serviceError("learning_action_invalid", "学习目标无效", 409);

    const fail = async (message: string): Promise<{ project: Project; action: LearningActionCard; state_changed: false }> => {
      const failed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || action.status !== "confirmed") return;
        action.status = "failed";
        action.error = message;
      });
      const action = failed ? findLearningAction(failed, input.actionId) : null;
      if (!failed || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: failed, action, state_changed: false };
    };

    const config = await runtimeConfig(this.config, this.store);
    const settings = await this.store.loadSettings(input.owner.owner_id);
    const selectedModel = reserved.model_override || effectiveModelSelector(config, this.store, input.owner, settings);
    const selectedProvider = resolveProvider({
      config: config,
      store: this.store,
      owner: input.owner,
      settings,
      selectedModel,
    });
    const userPaid = selectedModel !== FREE_SELECTOR && input.owner.kind !== "guest";
    const provider = selectedProvider;
    if (!provider) return fail("当前没有可用模型，路线尚未生成。");
    const profile = await this.store.loadProfile(input.owner.owner_id);
    const route = await generateLearningRoute({
      project: reserved,
      snapshot,
      target: reservedAction.target,
      request: reservedAction.request,
      profile,
      store: this.store,
      modelRuntime: createModelRuntime(provider, {
        providerGate: this.providerGateFactory?.(provider),
        providerBudget: this.providerBudget,
        ownerId: input.owner.owner_id,
        attribution: { business: "chat", payer: userPaid ? "user" : "platform", agentRole: "learning-route", configVersion: config.adminConfigVersion, taskId: input.actionId },
        metrics: this.metrics,
      }),
      signal: input.signal,
    });
    const traceId = `learning-action-run:${randomUUID()}`;
    await this.store.saveTrace(traceId, {
      trace_id: traceId,
      project_id: input.projectId,
      owner_id: input.owner.owner_id,
      snapshot_id: snapshot.snapshot_id,
      action_id: input.actionId,
      skill_id: route.trace.skill_id,
      skill_version: route.trace.skill_version,
      stop_reason: route.trace.stop_reason,
      evidence_ids: route.trace.evidence_ids,
      usage: route.trace.usage,
      model: route.trace.model,
      provider: route.trace.provider,
      state_changed: route.completed && route.steps.length > 0,
      created_at: nowIso(),
    });
    if (!route.completed) return fail("路线 Agent 暂时没有形成可靠结果，现有学习状态没有改变。");
    if (!route.steps.length) return fail("当前代码证据不足以生成可靠路线，现有学习状态没有改变。");

    const completed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
      const action = findLearningAction(row, input.actionId);
      if (!action || action.status !== "confirmed") {
        throw serviceError("learning_action_not_confirmed", "学习路线请求已经失效", 409);
      }
      assertLearningActionStillCurrent(row, snapshot, action);
      applyCompletedLearningRoute(row, action, route.steps);
      const timestamp = nowIso();
      action.status = "executed";
      action.executed_at = timestamp;
      action.error = null;
    });
    const action = completed ? findLearningAction(completed, input.actionId) : null;
    if (!completed || !action) throw serviceError("not_found", "项目不存在", 404);
    return { project: completed, action, state_changed: true };
  }

  async run(input: ConversationRunInput): Promise<ConversationResult | null> {
    const content = input.content.trim().slice(0, 20_000);
    if (!content) throw serviceError("invalid_request", "content 不能为空", 400);
    if ([...this.runOwners.values()].some(run => run.projectId === input.projectId && run.ownerId === input.owner.owner_id)) {
      throw serviceError("session_busy", "上一轮仍在处理，请等待它结束或取消后再试", 409);
    }
    const runId = input.runId ?? randomUUID();
    this.runOwners.set(runId, { ownerId: input.owner.owner_id, projectId: input.projectId });
    this.runtime.prepareRun(runId);
    let releaseRepository: RepositoryReadLease | null = null;
    try {
    releaseRepository = await acquireRepositoryReadLease(this.store);
    if(releaseRepository) input={...input,signal:input.signal ? AbortSignal.any([input.signal,releaseRepository.signal]) : releaseRepository.signal};
    const project = await this.store.loadProject(input.projectId, input.owner.owner_id);
    if (!project) throw serviceError("not_found", "项目不存在", 404);
    if(project.analysis.removed_by_admin) throw serviceError('snapshot_unavailable','此仓库的分析资料已由管理员清理，请重新分析后继续对话。',409);
    if (!input.replaceMessageId && input.retryRunId) {
      const prior = project.messages.find(message => message.role === "user" && message.trace_id === input.retryRunId);
      if (prior) input = { ...input, replaceMessageId: prior.message_id };
    }
    const previousUser = [...project.messages].reverse().find(message => message.role === "user");
    if (input.replaceMessageId && previousUser?.message_id !== input.replaceMessageId) {
      throw serviceError("last_message_changed", "只能编辑最后一条消息，请刷新后重试。", 409);
    }
    const beforeTurn = input.replaceMessageId
      ? project.messages.slice(0, project.messages.findIndex(message => message.message_id === input.replaceMessageId))
      : project.messages;
    assertChatHistoryCapacity(project.messages, content, input.replaceMessageId, this.config);
    const originalStudy = structuredClone(project.study);
    const config = await runtimeConfig(this.config, this.store);
    const settings = await this.store.loadSettings(input.owner.owner_id);
    const selectedModel = project.model_override || effectiveModelSelector(config, this.store, input.owner, settings);
    const provider = resolveProvider({
      config: config,
      store: this.store,
      owner: input.owner,
      settings,
      selectedModel,
    });
    if (!provider) {
      throw selectedModel === FREE_SELECTOR || input.owner.kind === "guest"
        ? serviceError("provider_unavailable", "免费体验模型尚未配置", 503)
        : serviceError("provider_key_required", "请先在设置中填写 API Key", 409);
    }
    const userPaid = selectedModel !== FREE_SELECTOR && input.owner.kind !== "guest";
    const attribution: UsageAttribution = { business: "chat", payer: userPaid ? "user" : "platform", agentRole: "primary-chat", configVersion: config.adminConfigVersion, taskId: runId };
    const runtimeOptions = {
      attribution,
      providerGate: this.providerGateFactory?.(provider),
      providerBudget: this.providerBudget,
      ownerId: input.owner.owner_id,
      metrics: this.metrics,
    };
    // Chat helpers always follow this conversation's selected model and payer.
    const modelRuntime = createModelRuntime(provider, runtimeOptions);
    const primarySkill = await loadProductSkill(PRIMARY_SKILL_ID);
    const snapshot = asEvidenceSnapshot(await this.store.loadSnapshot(input.projectId));
    const analysisResult = await this.store.loadAnalysisResult<{
      fact_graph?: { nodes?: unknown[]; edges?: unknown[] };
    }>(input.projectId);
    if (
      snapshot
      && analysisResult?.fact_graph
      && Array.isArray(analysisResult.fact_graph.nodes)
      && Array.isArray(analysisResult.fact_graph.edges)
    ) {
      snapshot.fact_graph = analysisResult.fact_graph as NonNullable<typeof snapshot.fact_graph>;
    }
    const agentMemories = await this.memories.list(input.owner.owner_id);
    const profile = await this.store.loadProfile(input.owner.owner_id);
    if (profile.memory_summary_mode !== "edited") {
      profile.memory_summary = generateMemorySummary(profile, agentMemories);
    }
    const selection = input.selection?.snapshot_id === project.analysis.snapshot_id
      ? input.selection
      : null;
    const userMessage = createMessage("user", content, {
      trace_id: runId,
      analysis_snapshot_id: project.analysis.snapshot_id,
      analysis_commit_sha: project.source.commit_sha,
    });
    if (input.replaceMessageId) userMessage.message_id = input.replaceMessageId;
    project.messages = [...beforeTurn, userMessage];

    const startedAt = Date.now();
    let turnStarted = false;
    const exposedEvidence = new Map();
    const exposedPaths = new Set<string>();
    const toolsUsed: string[] = [];
    const workerRuns: TeachingWorkerTrace[] = [];
    let stateChanged = false;
    const pendingLearningAction = { value: null as LearningActionCard | null };
    const assessment = { value: null as null | { verdict: string; masteredItems: string[]; evidenceIds: string[] } };
    const feedbackHint: { value: FeedbackHint | null } = { value: null };
    const tools = [
      ...createConversationTools({
      project,
      snapshot,
      profile,
      agentMemories,
      store: this.store,
      selected: selection,
      exposedEvidence,
      exposedPaths,
      toolsUsed,
      pendingLearningAction,
      assessment,
      currentUserMessage: content,
      modelRuntime,
      workerRuns,
      }),
      createFeedbackHintTool(feedbackHint),
    ];
    assertProductSkillRun(primarySkill, {
      toolNames: tools.map((tool) => tool.name),
      inputSchemaId: "conversation-turn-v1",
      outputSchemaId: "natural-answer-v1",
      contextBuilderId: "primary-conversation-context-v3",
    });

    const finalize = async (result: PiRunResult) => {
      if (!turnStarted) throw serviceError(result.stopReason === "cancelled" ? "cancelled" : "server_error", failureMessage(result.stopReason), 503);
      const explicitAdvance = isExplicitAdvanceRequest(content);
      if (explicitAdvance && snapshot && pendingLearningAction.value?.action !== "advance_learning_step") {
        try {
          pendingLearningAction.value = createLearningActionProposal(project, snapshot, {
            action: "advance_learning_step",
            targetKind: "learning_step",
            request: content,
            skipUnderstandingCheck: true,
            progress: null,
          });
          if (!toolsUsed.includes("propose_learning_action")) toolsUsed.push("propose_learning_action");
        } catch {
          // There is no current route step to advance; leave the model's answer intact.
        }
      }
      const action = pendingLearningAction.value?.action === "advance_learning_step"
        && pendingLearningAction.value.skip_understanding_check
        ? pendingLearningAction.value
        : null;
      let directSkipApplied = false;
      if (action && explicitAdvance && result.stopReason === "completed") {
        try {
          applyConfirmedLearningAction(project, action);
          const timestamp = nowIso();
          action.status = "executed";
          action.resolved_at = timestamp;
          action.executed_at = timestamp;
          action.error = null;
          directSkipApplied = true;
          stateChanged = true;
        } catch {
          // Keep the action pending when the route changed during the turn.
        }
      }
      const refusal = /不能跳过|按研学协议|只有本轮理解|需要先回答|只有掌握才/u.test(result.text);
      const skipNotice = action
        ? directSkipApplied
          ? `你明确选择跳过“${action.target?.label ?? "当前步骤"}”的理解检查。已记录为主动跳过（不计入已掌握），现在进入下一步；之后仍可回看本步。`
          : `你明确选择跳过“${action.target?.label ?? "当前步骤"}”的理解检查。${action.description} 请确认卡片后继续。`
        : "";
      const visibleText = action && refusal
        ? skipNotice
        : [result.stopReason === "paused"
        ? [result.text.trim(), "已暂停本轮处理。已经完成的查询结果会保留，你可以直接继续提问。"]
          .filter(Boolean).join("\n\n")
        : result.text, skipNotice].filter(Boolean).join("\n\n");
      const validation = await validateAnswerCitations({
        text: visibleText,
        snapshot,
        exposed: exposedEvidence,
        projectId: input.projectId,
        store: this.store,
      });
      const validationErrors = [...validation.errors];
      let acceptedEvidence = validation.evidence;
      let reviewStatus: Record<string, unknown> | null = null;
      let reviewUsage = combinedUsage();
      if (
        input.reviewEvidence === true
        && result.stopReason === "completed"
        && toolsUsed.some((name) => ![
          "get_learning_context",
          "get_learner_profile",
          "propose_learning_action",
        ].includes(name))
      ) {
        const review = await reviewAnswerEvidence({
          text: result.text,
          evidence: validation.evidence,
          projectId: input.projectId,
          snapshotId: project.analysis.snapshot_id ?? "",
          store: this.store,
          modelRuntime,
          signal: input.signal,
        });
        reviewStatus = {
          usage: review.usage,
          model: runtimeForSkill(modelRuntime, "citation-review").model.id,
          provider: runtimeForSkill(modelRuntime, "citation-review").model.provider,
          completed: review.completed,
          supported: review.supported,
          stop_reason: review.stopReason,
          unsupported_claim_count: review.unsupportedClaims.length,
        };
        reviewUsage = review.usage;
        if (!review.completed) {
          validationErrors.push("citation_review_unavailable");
          acceptedEvidence = [];
        } else if (!review.supported) {
          validationErrors.push("citation_review_not_supported");
          acceptedEvidence = [];
        } else {
          const acceptedIds = new Set(review.acceptedEvidenceIds);
          acceptedEvidence = validation.evidence.filter((row) => acceptedIds.has(row.stable_id));
        }
      }
      const totalUsage = combinedUsage(
        result.usage,
        ...workerRuns.map((worker) => worker.usage),
        reviewUsage,
      );
      const assistantMessage = answerMessage(
        project,
        withCitationNotice(validation.text, validationErrors),
        provider.model,
        result.stopReason,
        Date.now() - startedAt,
        totalUsage,
        runId,
        messageThinkingSummary(result.events),
      );
      assistantMessage.evidence = acceptedEvidence;
      assistantMessage.unresolved_references = validation.unresolved;
      assistantMessage.context_eligible = result.stopReason === "completed" && validationErrors.length === 0;
      if ((assistantMessage.context_eligible || directSkipApplied) && pendingLearningAction.value) {
        assistantMessage.learning_action = pendingLearningAction.value;
      }
      const evidenceQuality = measureEvidenceQuality({
        events: result.events.map((event) => ({
          type: event.type,
          elapsed_ms: event.elapsedMs ?? null,
          tool_call_id: event.toolCallId ?? null,
        })),
        observed_evidence_ids: [
          ...acceptedEvidence.map((row) => row.stable_id),
          ...workerRuns.flatMap((worker) => worker.evidence_ids),
        ],
        valid_evidence_ids: acceptedEvidence.map((row) => row.stable_id),
        referenced_evidence_ids: validation.evidence.map((row) => row.stable_id),
        validation_errors: validationErrors,
        usage: totalUsage,
        model_calls: result.events.filter((event) => event.type === "model_started").length
          + workerRuns.length
          + (reviewStatus ? 1 : 0),
        first_valid_evidence_ms: acceptedEvidence.length
          ? result.events.find((event) => event.type === "tool_result_received")?.elapsedMs ?? null
          : null,
      });
      // Merge into the current row: feedback, analysis and settings may have
      // changed while the model was running. Never replay an old transcript.
      const saved = await this.store.updateProject(input.projectId, input.owner.owner_id, row => {
        const currentUser = [...row.messages].reverse().find(message => message.role === 'user');
        if (currentUser?.message_id !== userMessage.message_id || currentUser.trace_id !== runId) {
          throw serviceError('last_message_changed', '只能编辑最后一条消息，请刷新后重试。', 409);
        }
        row.messages.push(assistantMessage);
        if (!isDeepStrictEqual(originalStudy, project.study) && isDeepStrictEqual(row.study, originalStudy)) {
          row.study = project.study;
        }
      });
      if (!saved) throw serviceError('not_found', '项目不存在', 404);
      project.messages = saved.messages;
      project.study = saved.study;
      await this.store.saveTrace(runId, {
        trace_id: runId,
        run_id: runId,
        project_id: input.projectId,
        owner_id: input.owner.owner_id,
        snapshot_id: project.analysis.snapshot_id,
        skill_id: PRIMARY_SKILL_ID,
        skill_version: primarySkill.version,
        model: provider.model,
        provider: provider.provider,
        primary_usage: result.usage,
        tools_used: toolsUsed,
        evidence_ids: acceptedEvidence.map((row) => row.stable_id),
        validation_errors: validationErrors,
        review_requested: input.reviewEvidence === true,
        review: reviewStatus,
        state_changed: stateChanged,
        learning_action_id: assistantMessage.learning_action?.action_id ?? null,
        worker_runs: workerRuns,
        evidence_quality: evidenceQuality,
        stop_reason: result.stopReason,
        usage: totalUsage,
        latency_ms: Date.now() - startedAt,
        events: result.events
          .filter((event) => !["assistant_delta", "assistant_commentary", "usage_updated"].includes(event.type))
          .slice(-128)
          .map((event) => ({
            sequence: event.sequence,
            timestamp: event.timestamp,
            type: event.type,
            summary: event.summary,
            elapsed_ms: event.elapsedMs ?? 0,
            tool_name: event.toolName,
            error_code: event.errorCode,
            ...(event.display ? {
              kind: event.display.kind,
              display_stage: event.display.stage,
              label: event.display.label,
              ...(event.display.text ? { text: event.display.text } : {}),
              status: event.display.status,
              visible: event.display.visible,
            } : {}),
          })),
      });
      if (assistantMessage.context_eligible) {
        this.memoryMaintenance.schedule({
          ownerId: input.owner.owner_id,
          projectId: input.projectId,
          modelRuntime,
        });
      }
      if (["completed", "paused"].includes(result.stopReason)) this.feedbackWorker.schedule({
        ownerId: input.owner.owner_id,
        projectId: input.projectId,
        userMessageId: userMessage.message_id,
        hint: feedbackHint.value ?? undefined,
        modelRuntime: await this.feedbackRuntime(`feedback:${input.projectId}:${"messageId" in input ? input.messageId : runId}`),
      });
      const publicErrorCode = selectedModel === FREE_SELECTOR && result.stopReason === "provider_balance_insufficient" ? "platform_provider_balance_insufficient"
        : selectedModel === FREE_SELECTOR && ["provider_authentication_failed", "provider_permission_denied"].includes(result.stopReason) ? "provider_unavailable" : result.stopReason;
      return {
        assistantText: assistantMessage.content,
        value: {
          ...(!["completed", "paused"].includes(result.stopReason) ? { error: {
            code: publicErrorCode,
            message: failureMessage(publicErrorCode),
          } } : {}),
          user_message: userMessage,
          assistant_message: assistantMessage,
          teaching_phase: project.study.phase,
          validation_errors: validationErrors,
          tools_used: toolsUsed,
          state_changed: stateChanged,
        },
        sessionCommit: result.stopReason === "paused"
          ? "accepted" as const
          : result.stopReason !== "completed"
            ? "discard" as const
          : "accepted" as const,
      };
    };

    return await this.runtime.run({
      identity: {
        sessionId: projectSessionId(
          input.owner.owner_id,
          input.projectId,
          project.analysis.snapshot_id,
        ),
        ownerId: input.owner.owner_id,
        projectId: input.projectId,
        snapshotId: project.analysis.snapshot_id,
        skillId: PRIMARY_SKILL_ID,
        skillVersion: primarySkill.version,
      },
      systemPrompt: formatSkillInvocation(primarySkill.skill, primarySystemPrompt({
        project,
        profile,
        selection,
        currentUserMessage: content,
        displayLanguage: input.displayLanguage,
      })),
      userMessage: content,
      turn: {
        messageId: userMessage.message_id,
        replace: Boolean(input.replaceMessageId),
        previousMessages: visibleContextMessages(beforeTurn),
      },
      beforePrompt: async () => {
        const saved = await this.store.updateProject(input.projectId, input.owner.owner_id, row => {
          if (input.replaceMessageId) {
            const latest = [...row.messages].reverse().find(message => message.role === "user");
            if (latest?.message_id !== input.replaceMessageId || latest.content !== previousUser?.content) {
              throw serviceError("last_message_changed", "只能编辑最后一条消息，请刷新后重试。", 409);
            }
          }
          // Recheck under the store's project lock before changing any history.
          assertChatHistoryCapacity(row.messages, content, input.replaceMessageId, this.config);
          if (input.replaceMessageId) row.messages = row.messages.slice(0, row.messages.findIndex(message => message.message_id === input.replaceMessageId));
          row.messages.push(userMessage);
        });
        if (!saved) throw serviceError("not_found", "项目不存在", 404);
        turnStarted = true;
      },
      modelRuntime,
      thinkingLevel: provider.thinkingLevel ?? "medium",
      tools,
      runId,
      signal: input.signal,
      onEvent: input.onEvent,
      }, async (result) => {
        return finalize(result);
      });
    } catch (error) {
      if (error instanceof PiSessionWaitTimeoutError) {
        throw serviceError("session_busy", "上一轮仍在处理，请等待它结束或取消后再试", 409);
      }
      throw error;
    } finally {
      this.runOwners.delete(runId);
      this.runtime.releaseRun(runId);
      await releaseRepository?.();
    }
  }
}

function visibleContextMessages(messages: Message[]): AgentMessage[] {
  return messages.flatMap((message, index): AgentMessage[] => {
    if ((message.error && message.error !== "paused") || message.placeholder || !message.content.trim()) return [];
    if (message.role === "user") {
      const answer = messages[index + 1];
      // Legacy sessions have no turn marker. Do not reintroduce unanswered failed turns.
      if (answer?.role !== "assistant" || (answer.error && answer.error !== "paused") || answer.placeholder || !answer.content.trim()) return [];
    }
    if (message.role === "user") return [{ role: "user", content: message.content, timestamp: Date.parse(message.created_at) }];
    if (message.role !== "assistant") return [];
    return [{ role: "assistant", content: [{ type: "text", text: message.content }],
      api: "openai-completions", provider: "history", model: message.model ?? "history",
      stopReason: "stop", timestamp: Date.parse(message.created_at),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  });
}

function answerMessage(
  project: Project,
  text: string,
  model: string,
  stopReason: string,
  latencyMs: number,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
  traceId: string,
  thinkingSummary: MessageThinkingSummaryEvent[],
): Message {
  return createMessage("assistant", text, {
    model,
    analysis_snapshot_id: project.analysis.snapshot_id,
    analysis_commit_sha: project.source.commit_sha,
    error: stopReason === "completed" ? null : stopReason,
    latency_ms: latencyMs,
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
    trace_id: traceId,
    thinking_summary: thinkingSummary,
  });
}

export function messageThinkingSummary(events: PiRunEvent[]): MessageThinkingSummaryEvent[] {
  return events
    .flatMap((event) => {
      const display = event.display;
      if (!display || !display.visible || display.kind !== "summary") return [];
      return [{
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "summary" as const,
        stage: display.stage,
        label: display.label,
        status: display.status,
        elapsed_ms: Math.max(0, event.elapsedMs ?? 0),
      }];
    })
    .slice(-32);
}

function findLearningAction(project: Project, actionId: string): LearningActionCard | null {
  for (const message of project.messages) {
    if (message.learning_action?.action_id === actionId) return message.learning_action;
  }
  return null;
}

function combinedUsage(...values: PiUsageSummary[]): PiUsageSummary {
  return values.reduce<PiUsageSummary>((total, value) => ({
    inputTokens: total.inputTokens + value.inputTokens,
    outputTokens: total.outputTokens + value.outputTokens,
    cachedTokens: total.cachedTokens + value.cachedTokens,
    cacheWriteTokens: total.cacheWriteTokens + value.cacheWriteTokens,
    costUsd: total.costUsd + value.costUsd,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
}
