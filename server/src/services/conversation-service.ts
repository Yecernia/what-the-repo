import { runAbortCode, executionErrorCode } from './execution-error.js';
import { normalizeDisplayLanguage, projectDisplayLanguage } from '../domain/display-language.js';
import { CONFIRMED_LESSON_TASK, currentConfirmedLesson, confirmedLessonSourceId, isConfirmedLessonSource } from '../domain/confirmed-lesson.js';
import { acquireRepositoryReadLease, type RepositoryReadLease } from '../persistence/repository-read-lease.js';
import { runtimeConfig } from '../admin/runtime-config.js';
import { assertChatHistoryCapacity } from './chat-history-limits.js';
import { isDeepStrictEqual } from 'node:util';
import { CapacityScheduler, permitStoreFor, type CapacityPermit } from '../scheduling/permits.js';
import type { UsageAttribution } from '../agent/provider-budget.js';
import { randomUUID } from "node:crypto";
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
import { createConversationSnapshotReader, createConversationSummaryReader } from "./conversation-snapshot.js";
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
import type { reviewReplyContent } from '../agent/reply-content-review.js';
import type { ConversationToolContext, ReplyEvidenceRepair } from '../agent/conversation-tools.js';
import { distinctEvidence, combineBlockReviews, type ReplyEvidenceBlock } from '../agent/reply-evidence.js';
import { generateLearningRoute, runUnderstandingAssessment } from "../agent/teaching-workers.js";
import {
  applyCompletedLearningRoute,
  applyConfirmedLearningAction,
  assertLearningActionStillCurrent,
  completeLearningAction,
  learningActionReceipt,
  refreshLearningActionMessage,
  currentLearningStep,
  expireSupersededAdvanceCards,
  isRouteAction,
} from "../agent/learning-actions.js";
import {
  primarySystemPrompt,
  primaryTurnContext,
  PRIMARY_SKILL_ID,
  type UiSelection,
} from "../agent/prompts.js";
import { normalizeTargetCoverage } from '../agent/target-coverage.js';
import { reduceTeachingTurnCommit, type TeachingTurnCandidates } from '../agent/teaching-turn-candidate.js';
import { prepareReplyEvidence } from '../agent/reply-validation.js';
import { MAX_REVIEW_PACKETS } from '../agent/evidence-packets.js';
import { MAX_REPLY_SUBMISSIONS, questionIsCurrent, questionWasDisplayed, restoreDisplayedTeachingQuestion, learningActionReply, type ConversationReply } from '../agent/conversation-reply.js';
import { withCitationNotice, withEvidenceReviewNotice } from "../agent/citations.js";
import { MemoryMaintenance } from "../agent/memory-maintenance.js";
import { readLearner } from './learner-context.js';
import { FeedbackAnalysisWorker } from "../agent/feedback.js";
import { reviewAnswerEvidence, unavailableEvidenceReview } from "../agent/citation-review.js";
import {
  effectiveModelSelector,
  FREE_SELECTOR,
  resolveDeploymentProvider,
  resolveChatProvider,
} from "../agent/provider-resolver.js";
import { assertProductSkillRun, formatProductSkillInvocation, loadProductSkill } from "../agent/skill-registry.js";
import type { ProductStore } from "../persistence/store.js";
import type { TaskQueue } from "../queue/task-queue.js";
import { serviceError } from "./errors.js";
import { resolveSnapshotView } from "./snapshot-view.js";
import { ensureLearningMigration } from "./learning-migration.js";
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
  lessonActionId?: string;
  owner: ConversationOwner;
  projectId: string;
  content: string;
  /** Current UI language is a fallback, not a forced response language. */
  displayLanguage?: string;
  replaceMessageId?: string;
  /** The version the page shows; the whole turn reads it even if a newer one is published. */
  viewSnapshotId?: string | null;
  /** A browser may lose the response before learning the persisted message ID. */
  retryRunId?: string;
  /** Graph objects the learner attached to this message. */
  selections?: UiSelection[];
  reviewEvidence?: boolean;
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: PiRunEvent) => void;
}

export type ConversationRunControl = "pause" | "cancel";
export type LearningActionDecision = "confirm" | "decline";
const LEARNING_ACTION_TIMEOUT_MS = 180_000;

export class ConversationService {
  private readonly runtime: PiConversationRuntime;
  private readonly chatAdmission: CapacityScheduler;
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
    private readonly learningWorkers: {
      generateRoute?: typeof generateLearningRoute;
      assess?: typeof runUnderstandingAssessment;
      reviewEvidence?: typeof reviewAnswerEvidence;
      reviewReplyContent?: typeof reviewReplyContent;
    } = {},
  ) {
    this.chatAdmission = new CapacityScheduler(permitStoreFor(store), 'chat', {
      running: config.chatConcurrency ?? 8, waiting: config.chatQueueLimit ?? 16,
      waitMs: config.chatWaitTimeoutMs ?? 30_000, ownerActive: config.chatOwnerConcurrency ?? 2,
      ownerWaiting: 1, exclusiveResource: true,
    });
    this.runtime = new PiConversationRuntime(sessions, 30_000, true);
    this.memoryMaintenance = new MemoryMaintenance(store, memories, (ownerId, taskId) => this.memoryRuntime(ownerId, taskId));
    this.feedbackWorker = new FeedbackAnalysisWorker(
      store,
      taskQueue ? (requestId) => taskQueue.enqueueEvolution(requestId) : undefined,
    );
  }

  startMemoryMaintenance(): void { this.memoryMaintenance.start(); }
  stopMemoryMaintenance(): Promise<void> { return this.memoryMaintenance.stop(); }

  private async memoryRuntime(ownerId: string, taskId: string) {
    const config = await runtimeConfig(this.config, this.store);
    const provider = resolveDeploymentProvider({ providerId: config.freeProviderId,
      baseUrl: config.freeProviderBaseUrl, model: config.freeProviderModel,
      apiKey: config.freeProviderApiKey, connectionId: config.freeConnectionId ?? 'deployment-free' });
    return provider ? createModelRuntime(provider, {
      providerGate: this.providerGateFactory?.(provider, 'chat', { ownerId, taskId }),
      providerBudget: this.providerBudget, ownerId, metrics: this.metrics,
      attribution: { business: 'chat', payer: 'platform', agentRole: 'memory-maintenance', configVersion: config.adminConfigVersion, taskId },
    }) : undefined;
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
        providerGate: this.providerGateFactory?.(feedbackProvider, 'evolution'),
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
    const runId = input.actionId;
    if (this.runOwners.has(runId) || [...this.runOwners.values()].some(run => run.projectId === input.projectId && run.ownerId === input.owner.owner_id)) {
      throw serviceError("session_busy", "上一轮仍在处理，请等待它结束或取消后再试", 409);
    }
    this.runOwners.set(runId, { ownerId: input.owner.owner_id, projectId: input.projectId });
    const control = this.runtime.prepareRun(runId);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("learning_action_timeout")), LEARNING_ACTION_TIMEOUT_MS);
    timer.unref();
    input = { ...input, signal: AbortSignal.any([control, deadline.signal, ...(input.signal ? [input.signal] : [])]) };
    let admission: CapacityPermit | undefined;
    let repositoryLease: RepositoryReadLease | null = null;
    let snapshotLease: string | null = null;
    try {
      const owned = await this.store.loadProject(input.projectId, input.owner.owner_id);
      if (!owned) throw serviceError("not_found", "项目不存在", 404);
      admission = await this.chatAdmission.acquire(input.owner.owner_id, input.projectId, input.signal);
      input = { ...input, signal: admission.signal };
      repositoryLease = await acquireRepositoryReadLease(this.store);
      if (repositoryLease) input = { ...input, signal: AbortSignal.any([input.signal!, repositoryLease.signal]) };
      const project = await this.store.loadProject(input.projectId, input.owner.owner_id);
      if (!project) throw serviceError("not_found", "项目不存在", 404);
      if (project.analysis.removed_by_admin) throw serviceError("snapshot_unavailable", "请重新分析后继续学习。", 409);
      if (project.analysis.canonical_snapshot_key) {
        snapshotLease = await this.store.acquireSnapshotReadLease(project.analysis.canonical_snapshot_key, this.config.repositoryReadLeaseMaxMinutes ?? 30);
        if (!snapshotLease) throw serviceError("snapshot_expired", "旧版已过期，请刷新到最新版本。", 410);
      }
      return await this.executeLearningAction(input, project);
    } finally {
      clearTimeout(timer);
      this.runOwners.delete(runId);
      this.runtime.releaseRun(runId);
      try {
        if (snapshotLease) await this.store.releaseSnapshotReadLease(snapshotLease).catch(() => undefined);
        await repositoryLease?.();
      } finally { await admission?.release(); }
    }
  }

  private async executeLearningAction(input: {
    owner: ConversationOwner; projectId: string; actionId: string;
    decision: LearningActionDecision; signal?: AbortSignal;
  }, project: Project): Promise<{ project: Project; action: LearningActionCard; state_changed: boolean }> {
    input.signal?.throwIfAborted();
    const snapshot = await createConversationSnapshotReader(this.store, {
      projectId: input.projectId, ownerId: input.owner.owner_id,
      snapshotId: project.analysis.snapshot_id, publicSnapshotKey: project.analysis.canonical_snapshot_key,
      signal: input.signal,
    })();
    if (!snapshot) throw serviceError("snapshot_unavailable", "项目图谱尚未完成", 404);
    const existing = findLearningAction(project, input.actionId);
    if (existing?.status === "executed") return { project, action: existing, state_changed: false };
    if (!existing || !isRetryableLearningAction(existing)) {
      throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
    }
    try {
      assertLearningActionStillCurrent(project, snapshot, existing);
    } catch {
      const expired = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || !isRetryableLearningAction(action)) return;
        action.status = "expired";
        action.resolved_at = nowIso();
        action.error = "学习目标或分析快照已经变化。";
        refreshLearningActionMessage(row, action);
      });
      const action = expired ? findLearningAction(expired, input.actionId) : null;
      if (!expired || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: expired, action, state_changed: false };
    }

    if (input.decision === "decline") {
      const declined = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        input.signal?.throwIfAborted();
        if (!action || !isRetryableLearningAction(action)) {
          throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
        }
        action.status = "declined";
        action.resolved_at = nowIso();
        refreshLearningActionMessage(row, action);
      });
      const action = declined ? findLearningAction(declined, input.actionId) : null;
      if (!declined || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: declined, action, state_changed: false };
    }

    if (!isRouteAction(existing)) {
      const completed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        input.signal?.throwIfAborted();
        const action = findLearningAction(row, input.actionId);
        if (!action || !isRetryableLearningAction(action)) {
          throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
        }
        try {
          assertLearningActionStillCurrent(row, snapshot, action);
          applyConfirmedLearningAction(row, action);
        } catch (error) {
          if (!(error instanceof Error) || ![
            "learning_action_no_longer_current", "learning_action_snapshot_mismatch", "learning_step_not_passed",
          ].includes(error.message)) throw error;
          action.status = "expired";
          action.resolved_at = nowIso();
          action.error = "当前路线、步骤或理解检查已经变化，请重新检查后继续。";
          refreshLearningActionMessage(row, action);
          return;
        }
        completeLearningAction(row, action);
        markConfirmedLesson(action);
        recordLearningActionResult(row, action);
      });
      const action = completed ? findLearningAction(completed, input.actionId) : null;
      if (!completed || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: completed, action, state_changed: action.status === "executed" };
    }

    const reserved = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
      input.signal?.throwIfAborted();
      const action = findLearningAction(row, input.actionId);
      if (!action || !isRetryableLearningAction(action)) {
        throw serviceError("learning_action_not_pending", "这个学习选择已经处理或不存在", 409);
      }
      assertLearningActionStillCurrent(row, snapshot, action);
      action.status = "confirmed";
      action.resolved_at = nowIso();
      action.run_id = randomUUID();
      action.run_expires_at = new Date(Date.now() + LEARNING_ACTION_TIMEOUT_MS).toISOString();
      action.error = null;
      refreshLearningActionMessage(row, action);
    });
    const reservedAction = reserved ? findLearningAction(reserved, input.actionId) : null;
    if (!reserved || !reservedAction?.target) throw serviceError("learning_action_invalid", "学习目标无效", 409);

    const fail = async (message: string): Promise<{ project: Project; action: LearningActionCard; state_changed: false }> => {
      const failed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
        const action = findLearningAction(row, input.actionId);
        if (!action || action.status !== "confirmed" || action.run_id !== reservedAction.run_id) return;
        action.status = "failed";
        action.error = message;
        action.run_expires_at = null;
        refreshLearningActionMessage(row, action);
      });
      const action = failed ? findLearningAction(failed, input.actionId) : null;
      if (!failed || !action) throw serviceError("not_found", "项目不存在", 404);
      return { project: failed, action, state_changed: false };
    };

    try {
    const config = await runtimeConfig(this.config, this.store);
    const settings = await this.store.loadSettings(input.owner.owner_id);
    const selectedModel = reserved.model_override || settings.model || await effectiveModelSelector(config, this.store, input.owner, settings);
    const selectedProvider = await resolveChatProvider({
      config: config,
      store: this.store,
      owner: input.owner,
      settings,
      selectedModel,
    });
    const userPaid = selectedModel !== FREE_SELECTOR && input.owner.kind !== "guest";
    const provider = selectedProvider;
    if (!provider) return fail("当前没有可用模型，路线尚未生成。");
    const { profile, memories } = await readLearner(this.store, this.memories, input.owner.owner_id);
    const route = await (this.learningWorkers.generateRoute ?? generateLearningRoute)({
      project: reserved,
      snapshot,
      target: reservedAction.target,
      request: reservedAction.request,
      profile,
      memories,
      store: this.store,
      modelRuntime: createModelRuntime(provider, {
        providerGate: this.providerGateFactory?.(provider, 'chat', { ownerId: input.owner.owner_id, taskId: input.actionId }),
        providerBudget: this.providerBudget,
        ownerId: input.owner.owner_id,
        attribution: { business: "chat", payer: userPaid ? "user" : "platform", agentRole: "learning-route", configVersion: config.adminConfigVersion, taskId: input.actionId },
        metrics: this.metrics,
      }),
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
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
      diagnostics: route.trace.diagnostics,
      state_changed: route.completed && route.steps.length > 0,
      created_at: nowIso(),
    });
    if (!route.completed) return fail("路线 Agent 暂时没有形成可靠结果，现有学习状态没有改变。");
    if (!route.steps.length) return fail("当前代码证据不足以生成可靠路线，现有学习状态没有改变。");

    const completed = await this.store.updateProject(input.projectId, input.owner.owner_id, (row) => {
      input.signal?.throwIfAborted();
      const action = findLearningAction(row, input.actionId);
      if (!action || action.status !== "confirmed" || action.run_id !== reservedAction.run_id) {
        throw serviceError("learning_action_not_confirmed", "学习路线请求已经失效", 409);
      }
      assertLearningActionStillCurrent(row, snapshot, action);
      applyCompletedLearningRoute(row, action, route.steps);
      completeLearningAction(row, action);
      markConfirmedLesson(action);
      recordLearningActionResult(row, action);
    });
    const action = completed ? findLearningAction(completed, input.actionId) : null;
    if (!completed || !action) throw serviceError("not_found", "项目不存在", 404);
    return { project: completed, action, state_changed: true };
    } catch {
      return await fail(input.signal?.aborted
        ? "路线生成已取消或超时，可以重试。"
        : "路线生成暂未完成，可以重试；现有学习进度未改变。");
    }
  }

  async run(input: ConversationRunInput): Promise<ConversationResult | null> {
    const content = input.lessonActionId ? CONFIRMED_LESSON_TASK : input.content.trim().slice(0, 20_000);
    if (!content) throw serviceError("invalid_request", "content 不能为空", 400);
    if ([...this.runOwners.values()].some(run => run.projectId === input.projectId && run.ownerId === input.owner.owner_id)) {
      throw serviceError("session_busy", "上一轮仍在处理，请等待它结束或取消后再试", 409);
    }
    const runId = input.runId ?? randomUUID();
    this.runOwners.set(runId, { ownerId: input.owner.owner_id, projectId: input.projectId });
    const controlSignal = this.runtime.prepareRun(runId);
    input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, controlSignal]) : controlSignal };
    let admission: CapacityPermit | undefined;
    let admissionEvents = 0;
    let releaseRepository: RepositoryReadLease | null = null;
    let snapshotLease: string | null = null;
    try {
    const owned = await this.store.loadProject(input.projectId, input.owner.owner_id);
    if (!owned) throw serviceError('not_found', '项目不存在', 404);
    admission = await this.chatAdmission.acquire(input.owner.owner_id, input.projectId, input.signal, () => {
      admissionEvents = 1;
      input.onEvent?.({ runId, sequence: 1, timestamp: nowIso(), type: 'capacity_waiting',
        summary: '服务器繁忙，正在等待处理…', elapsedMs: 0,
        display: { kind: 'summary', stage: 'capacity_waiting', label: '服务器繁忙，正在等待处理…', status: 'running', visible: true } });
    });
    input = { ...input, signal: admission.signal };
    releaseRepository = await acquireRepositoryReadLease(this.store);
    if(releaseRepository) input={...input,signal:input.signal ? AbortSignal.any([input.signal,releaseRepository.signal]) : releaseRepository.signal};
    const loaded = await this.store.loadProject(input.projectId, input.owner.owner_id);
    if (!loaded) throw serviceError("not_found", "项目不存在", 404);
    if(loaded.analysis.removed_by_admin) throw serviceError('snapshot_unavailable','此仓库的分析资料已由管理员清理，请重新分析后继续对话。',409);
    // Only analysis/source fields differ in a pinned view; history and study
    // are merged into the current row when the turn is saved.
    const view = await resolveSnapshotView(this.store, loaded, input.viewSnapshotId);
    // A turn on the current version first carries the route over to it.
    const project = view.historical ? view.project : await ensureLearningMigration(this.store, loaded);
    const leasedKey = project.analysis.canonical_snapshot_key;
    if (leasedKey) {
      snapshotLease = await this.store.acquireSnapshotReadLease(leasedKey, this.config.repositoryReadLeaseMaxMinutes ?? 30);
      if (!snapshotLease) throw serviceError("snapshot_expired", "旧版已过期，请刷新到最新版本。", 410);
    }
    let lessonSource: Message | undefined;
    let lessonTail: Message[] = [];
    if (input.lessonActionId) {
      if (input.replaceMessageId || view.historical || input.selections?.length) {
        throw serviceError('invalid_request', '程序讲解请求不能编辑用户消息或更换来源。', 400);
      }
      const action = assertCurrentConfirmedLesson(project, input.lessonActionId);
      const initialRun = action.outcome!.lesson_run_id!;
      lessonSource = project.messages.find(message => message.message_id === confirmedLessonSourceId(action.action_id));
      if (lessonSource) lessonTail = structuredClone(project.messages.slice(project.messages.indexOf(lessonSource) + 1));
      if (lessonSource && !isConfirmedLessonSource(project, lessonSource)) {
        throw serviceError('invalid_request', '程序讲解来源无效。', 400);
      }
      if (input.retryRunId) {
        if (!input.runId || runId === initialRun || runId === lessonSource?.trace_id
          || ![initialRun, lessonSource?.trace_id, lessonSource?.original_run_id].includes(input.retryRunId)) {
          throw serviceError('invalid_request', '讲解重试关联无效。', 400);
        }
      } else if (runId !== initialRun) throw serviceError('invalid_request', '讲解运行标识无效。', 400);
      const savedAnswer = lessonSource && project.messages[project.messages.indexOf(lessonSource) + 1];
      const terminal = savedAnswer?.role === 'assistant' && savedAnswer.trace_id === lessonSource?.trace_id ? savedAnswer : undefined;
      const successful = Boolean(terminal && !terminal.error && terminal.teaching_question && terminal.context_eligible !== false);
      if (terminal && (!input.retryRunId || successful)) {
        if (input.retryRunId && successful) throw serviceError('lesson_already_completed', '本步骤讲解已经完成。', 409);
        return { user_message: structuredClone(lessonSource!), assistant_message: structuredClone(terminal),
          teaching_phase: project.study.phase, validation_errors: [], tools_used: [], state_changed: false,
          ...(terminal.error ? { error: { code: terminal.error, message: terminal.content } } : {}) };
      }
      if (lessonSource && !terminal && !input.retryRunId) {
        throw serviceError('lesson_interrupted', '上一轮讲解已中断，请显式重试。', 409);
      }
      if (lessonSource && input.retryRunId) {
        const index = project.messages.indexOf(lessonSource);
        if (project.messages.slice(index + 1).some(message => message.message_id !== terminal?.message_id)) {
          throw serviceError('last_message_changed', '讲解之后已有新消息，请检查聊天记录。', 409);
        }
      }
    }
    if (!input.lessonActionId && !input.replaceMessageId && input.retryRunId) {
      const prior = project.messages.find(message => message.role === "user"
        && (message.trace_id === input.retryRunId || message.original_run_id === input.retryRunId));
      if (!prior) throw serviceError("last_message_changed", "重试关联的消息已经变化，请刷新后重试。", 409);
      input = { ...input, replaceMessageId: prior.message_id };
    }
    const previousUser = [...project.messages].reverse().find(message => message.role === "user");
    if (input.replaceMessageId && previousUser?.message_id !== input.replaceMessageId) {
      throw serviceError("last_message_changed", "只能编辑最后一条消息，请刷新后重试。", 409);
    }
    const beforeTurn = input.replaceMessageId
      ? project.messages.slice(0, project.messages.findIndex(message => message.message_id === input.replaceMessageId))
      : project.messages;
    const previousAnswer = input.replaceMessageId
      ? project.messages.slice(beforeTurn.length + 1).find(message => message.role === 'assistant' && !message.error)
      : undefined;
    const actionTail = input.replaceMessageId && previousAnswer
      ? project.messages.slice(project.messages.indexOf(previousAnswer) + 1) : [];
    if (input.replaceMessageId && previousUser && actionTail.some(message => message.lesson_request)
      && !(previousAnswer && isExecutedActionReplay(input, content, project.analysis.snapshot_id, previousUser, previousAnswer))) {
      throw serviceError('last_message_changed', '已确认操作之后已有程序讲解，不能编辑原消息。', 409);
    }
    assertChatHistoryCapacity(project.messages, content, input.replaceMessageId, this.config);
    // Admission, ownership and snapshot leases are held. Stable replays need no provider.
    if (input.replaceMessageId && previousUser && previousAnswer
      && isExecutedActionReplay(input, content, project.analysis.snapshot_id, previousUser, previousAnswer)) {
      const startedAt = Date.now();
      const userMessage = structuredClone(previousUser);
      userMessage.original_run_id ??= userMessage.trace_id ?? runId;
      userMessage.trace_id = runId;
      const receipt = learningActionReply(true)!;
      const assistantMessage = { ...structuredClone(previousAnswer),
        ...answerMessage(project, previousAnswer.content_parts!.body, previousAnswer.model ?? '', 'completed', 0, combinedUsage(), runId, []),
        created_at: previousAnswer.created_at,
        message_id: previousAnswer.message_id,
        evidence: structuredClone(previousAnswer.evidence), evidence_review: structuredClone(previousAnswer.evidence_review),
        content_parts: { ...structuredClone(previousAnswer.content_parts!), action_receipt: receipt },
        unresolved_references: structuredClone(previousAnswer.unresolved_references),
        context_eligible: previousAnswer.context_eligible,
        learning_action: structuredClone(previousAnswer.learning_action),
        teaching_question: structuredClone(previousAnswer.teaching_question),
        teaching_context: structuredClone(previousAnswer.teaching_context),
      };
      delete assistantMessage.feedback;
      assistantMessage.content = [assistantMessage.content_parts.body, receipt].filter(Boolean).join('\n\n');
      const saved = await this.store.updateProject(input.projectId, input.owner.owner_id, row => {
        input.signal?.throwIfAborted();
        const latest = [...row.messages].reverse().find(message => message.role === 'user');
        const index = row.messages.findIndex(message => message.message_id === previousUser.message_id);
        const answer = row.messages.slice(index + 1).find(message => message.role === 'assistant' && !message.error);
        if (!latest || !answer || !isDeepStrictEqual(latest, previousUser) || !isDeepStrictEqual(answer, previousAnswer)
          || row.analysis.removed_by_admin
          || !isExecutedActionReplay(input, content, project.analysis.snapshot_id, latest, answer)) {
          throw serviceError('last_message_changed', '重发关联的消息或学习操作已经变化，请刷新后重试。', 409);
        }
        assertChatHistoryCapacity(row.messages, content, input.replaceMessageId, this.config);
        const tail = row.messages.slice(row.messages.indexOf(answer) + 1);
        if (!isDeepStrictEqual(tail, actionTail)) throw serviceError('last_message_changed', '后续讲解记录已经变化。', 409);
        row.messages = [...row.messages.slice(0, index), userMessage, assistantMessage, ...tail];
      });
      if (!saved) throw serviceError('not_found', '项目不存在', 404);
      await this.store.saveTrace(runId, { trace_id: runId, run_id: runId, project_id: input.projectId,
        owner_id: input.owner.owner_id, snapshot_id: project.analysis.snapshot_id, skill_id: PRIMARY_SKILL_ID,
        replay: true, replay_source_trace_id: previousAnswer.trace_id, source_message_id: userMessage.message_id,
        learning_action_id: previousUser.learning_action_result!.action_id, state_changed: false, stop_reason: 'completed',
        model: previousAnswer.model, usage: combinedUsage(), primary_usage: combinedUsage(), worker_runs: [], tools_used: [],
        validation_errors: [], latency_ms: Date.now() - startedAt, events: [],
        evidence_quality: measureEvidenceQuality({ events: [], observed_evidence_ids: previousAnswer.evidence.map(row => row.stable_id),
          valid_evidence_ids: previousAnswer.evidence.map(row => row.stable_id), referenced_evidence_ids: [],
          validation_errors: [], usage: combinedUsage(), model_calls: 0, first_valid_evidence_ms: null }),
      }).catch(() => this.metrics.increment('what_the_repo_postcommit_errors_total', 1, { stage: 'replay_trace' }));
      try { input.onEvent?.({ runId, sequence: admissionEvents + 1, timestamp: nowIso(), type: 'run_completed',
        summary: '已恢复保存的回答，学习进度没有再次改变。', elapsedMs: Date.now() - startedAt });
      } catch { this.metrics.increment('what_the_repo_postcommit_errors_total', 1, { stage: 'replay_terminal' }); }
      return { user_message: userMessage, assistant_message: assistantMessage, teaching_phase: saved.study.phase,
        validation_errors: [], tools_used: [], state_changed: false };
    }
    const originalStudy = structuredClone(project.study);
    const config = await runtimeConfig(this.config, this.store);
    const settings = await this.store.loadSettings(input.owner.owner_id);
    const selectedModel = project.model_override || settings.model || await effectiveModelSelector(config, this.store, input.owner, settings);
    const provider = await resolveChatProvider({
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
      providerGate: this.providerGateFactory?.(provider, 'chat', { ownerId: input.owner.owner_id, taskId: runId }),
      providerBudget: this.providerBudget,
      ownerId: input.owner.owner_id,
      metrics: this.metrics,
    };
    // Chat helpers always follow this conversation's selected model and payer.
    const modelRuntime = createModelRuntime(provider, runtimeOptions);
    const primarySkill = await loadProductSkill(PRIMARY_SKILL_ID);
    const capturedSnapshotId = project.analysis.snapshot_id;
    const capturedPublicKey = project.analysis.canonical_snapshot_key;
    // The turn keeps the version it started with under a read lease. A newer
    // publication does not interrupt it; losing the project (access) still does.
    const assertSnapshotBinding = async () => {
      input.signal?.throwIfAborted();
      if (!(await this.store.loadProject(input.projectId, input.owner.owner_id))) {
        throw serviceError('not_found', '项目不存在', 404);
      }
    };
    const getSnapshot = createConversationSnapshotReader(this.store, {
      projectId: input.projectId, ownerId: input.owner.owner_id,
      snapshotId: capturedSnapshotId, publicSnapshotKey: capturedPublicKey, signal: input.signal,
    });
    const getSummary = createConversationSummaryReader(this.store, {
      project, snapshotId: capturedSnapshotId, assertSnapshotBinding,
    });
    const { profile, memories: agentMemories } = await readLearner(this.store, this.memories, input.owner.owner_id);
    const selections = (input.selections ?? []).filter((item) => item.snapshot_id === project.analysis.snapshot_id);
    const userMessage = createMessage(input.lessonActionId ? "system" : "user", content, {
      trace_id: runId,
      analysis_snapshot_id: project.analysis.snapshot_id,
      analysis_commit_sha: project.source.commit_sha,
    });
    if (input.lessonActionId) {
      const action = assertCurrentConfirmedLesson(project, input.lessonActionId);
      if (lessonSource) Object.assign(userMessage, structuredClone(lessonSource), { trace_id: runId });
      userMessage.message_id = confirmedLessonSourceId(action.action_id);
      userMessage.original_run_id = action.outcome!.lesson_run_id;
      userMessage.lesson_request = { action_id: action.action_id, snapshot_id: action.snapshot_id,
        route_revision: action.outcome!.route_revision, step_id: action.outcome!.next_step_id! };
    }
    if (selections.length) userMessage.attachments = selections.map((item) => ({ ...item }));
    if (input.replaceMessageId) userMessage.message_id = input.replaceMessageId;
    if (!input.lessonActionId) userMessage.original_run_id = input.replaceMessageId
      ? previousUser?.original_run_id ?? previousUser?.trace_id ?? runId : runId;
    if (input.replaceMessageId && previousUser?.learning_action_result) {
      userMessage.learning_action_result = structuredClone(previousUser.learning_action_result);
    }
    // Upgrade old executed cards before removing the assistant message on resend.
    if (input.replaceMessageId && !userMessage.learning_action_result) {
      const oldAction = project.messages.slice(project.messages.findIndex(message => message.message_id === input.replaceMessageId) + 1)
        .find(message => message.learning_action?.status === "executed")?.learning_action;
      if (oldAction) userMessage.learning_action_result = {
        action_id: oldAction.action_id, route_revision: oldAction.route_revision ?? 0,
        step_id: oldAction.expected_step_id ?? oldAction.target?.stable_id ?? null,
      };
    }
    const lessonBefore = lessonSource ? project.messages.slice(0, project.messages.indexOf(lessonSource)) : beforeTurn;
    project.messages = [...lessonBefore, userMessage];
    const questionRestored = restoreDisplayedTeachingQuestion(project, beforeTurn, userMessage.message_id);
    normalizeTargetCoverage(project);
    const turnBaseline = structuredClone(project);
    const candidates: TeachingTurnCandidates = { project: null };

    const startedAt = Date.now();
    let turnStarted = false;
    const exposedEvidence = new Map();
    const exposedPaths = new Set<string>();
    const toolsUsed: string[] = [];
    const workerRuns: TeachingWorkerTrace[] = [];
    let stateChanged = false;
    const pendingLearningAction = { value: null as LearningActionCard | null };
    const reply = { value: null as ConversationReply | null };
    const assessment: ConversationToolContext['assessment'] = { value: null };
    const feedbackHint: { value: FeedbackHint | null } = { value: null };
    const submissionDiagnostics: Array<Record<string, unknown>> = [];
    const submissionBudget = { used: 0 };
    const preflightDiagnostics: Array<Record<string, unknown>> = [];
    // Preserve first owner-feedback failures separately from the repaired result.
    // Feedback is schema-bounded to 1,200 chars; no source excerpts or SDK args.
    const assessmentReviewFailures: Array<Record<string, unknown>> = [];
    type Review = Awaited<ReturnType<typeof reviewAnswerEvidence>>;
    const reviewCache = new Map<string, Review>();
    const executedReviews: Review[] = [];
    const reviewBlock = async (block: ReplyEvidenceBlock, signal?: AbortSignal): Promise<Review> => {
      // Turn-local cache includes every source/range/coverage input. Finalization
      // revalidates sources before using an identical semantic review.
      const key = JSON.stringify([capturedSnapshotId, block.kind, block.text, block.evidence,
        block.citation_coverage, block.packet_coverage,
        block.kind === 'assessment' ? block.assessment_context : null]);
      const cached = reviewCache.get(key);
      if (cached) return cached;
      const reviewed = await (this.learningWorkers.reviewEvidence ?? reviewAnswerEvidence)({
        text: block.text, evidence: block.evidence, projectId: input.projectId,
        snapshotId: capturedSnapshotId ?? '', store: this.store, modelRuntime, signal,
        purpose: block.kind === 'explanation' ? 'answer' : block.kind, citationCoverage: block.citation_coverage,
        ...(block.kind === 'assessment' && block.assessment_context
          ? { assessmentContext: block.assessment_context } : {}),
      }).catch(() => unavailableEvidenceReview(undefined, block.text));
      executedReviews.push(reviewed);
      // Every result, including unavailable, belongs to this exact candidate.
      // Changing the text or its bound inputs creates a different review.
      reviewCache.set(key, reviewed);
      return reviewed;
    };
    const prepareReply: NonNullable<ConversationToolContext['prepareReply']> = async (candidate, signal, attempt) => {
      const prepared = await prepareReplyEvidence({ reply: candidate,
        text: [candidate.text, candidate.question?.prompt].filter(Boolean).join('\n\n'),
        getSnapshot, snapshotId: capturedSnapshotId, exposed: exposedEvidence,
        projectId: input.projectId, store: this.store, signal });
      const repairs: ReplyEvidenceRepair[] = [];
      let reviewUnavailable = false;
      for (const block of prepared.blocks) {
        let reviewed: Review | undefined;
        // Fix deterministic failures without spending a model request on a set
        // of packets already known to be incomplete.
        if (block.commit_eligible && input.reviewEvidence === true) reviewed = await reviewBlock(block, signal);
        const supported = !reviewed || (reviewed.completed && !reviewed.evidenceIncomplete
          && reviewed.coverage?.complete !== false && reviewed.answerCoverage?.complete !== false && ((reviewed.status === 'reviewed' && reviewed.supported)
            || (block.kind === 'explanation' && reviewed.status === 'not_applicable' && !block.citation_coverage?.parsed)));
        if (reviewed && !supported && (!reviewed.completed || reviewed.status === 'unverified' || reviewed.evidenceIncomplete
          || reviewed.coverage?.complete === false || reviewed.answerCoverage?.complete === false
          || reviewed.issues.length === 0)) reviewUnavailable = true;
        if (block.commit_eligible && supported) continue;
        if (block.kind === 'assessment' && assessmentReviewFailures.length < MAX_REPLY_SUBMISSIONS) {
          assessmentReviewFailures.push({ attempt, feedback: block.text, evidence: block.evidence,
            question_id: block.assessment_context?.registered_question.question_id,
            source_message_id: block.assessment_context?.source_message_id,
            validation_errors: block.validation_errors,
            review: reviewed ? { status: reviewed.status, completed: reviewed.completed, supported: reviewed.supported,
              stop_reason: reviewed.stopReason, summary: reviewed.summary, issues: reviewed.issues,
              validation_errors: reviewed.validationErrors, answer_coverage: reviewed.answerCoverage,
              coverage: reviewed.coverage, semantic_review: reviewed.semanticReview } : null });
        }
        const feedbackRepairAllowed = block.kind === 'assessment' && block.commit_eligible === true
          && reviewed?.status === 'reviewed' && reviewed.completed && !reviewed.evidenceIncomplete
          && reviewed.coverage?.complete !== false && reviewed.answerCoverage?.complete !== false
          && reviewed.issues.length > 0 && reviewed.issues.every(issue => issue.subject === 'assessment_feedback');
        repairs.push({ block_kind: block.kind, validation_errors: block.validation_errors,
          packet_limit: MAX_REVIEW_PACKETS, packet_count: block.packet_coverage?.packets.length ?? 0,
          unread_ranges: block.packet_coverage?.packets.filter(packet => packet.incomplete),
          review_status: reviewed?.status, issues: reviewed?.issues,
          feedback_repair_allowed: feedbackRepairAllowed,
          instruction: block.kind === 'assessment'
            ? !feedbackRepairAllowed
              ? 'This assessment candidate cannot be adopted. Its judgment and feedback are locked: do not reassess it or rewrite its feedback to rescue it. Repair only other reply partitions identified below; finalization will discard this assessment candidate.'
              : 'Only the assessment owner may repair feedback. Keep its judgment and evidence fixed; use the registered question conditions and remove unsupported mechanism restatements about other goals. Never borrow the new question evidence.'
            : 'Read the exact supporting ranges and revise the claim if needed. A claim about the only implementation or all other files needs repository-wide evidence: narrow that claim to the inspected scope, rather than retaining its universal wording after reducing citations. Keep the lesson focused on the requested targets; remove unnecessary detours, never a requested explanation. Cite the actual behavior, not a nearby symbol.' });
        if (preflightDiagnostics.length < 24) preflightDiagnostics.push({ attempt, block_kind: block.kind,
          validation_errors: block.validation_errors, packet_count: block.packet_coverage?.packets.length ?? 0,
          coverage_reasons: block.packet_coverage?.reasons, review_status: reviewed?.status,
          issue_kinds: reviewed?.issues.map(issue => issue.kind) });
      }
      return reviewUnavailable ? { outcome: 'finalize' }
        : repairs.length ? { outcome: 'repair', repairs } : { outcome: 'ready' };
    };
    const tools = [
      ...createConversationTools({
      project,
      snapshot: null,
      getSnapshot,
      getSummary,
      snapshotId: capturedSnapshotId,
      publicSnapshotKey: capturedPublicKey,
      assertSnapshotBinding,
      profile,
      agentMemories,
      getLearner: () => readLearner(this.store, this.memories, input.owner.owner_id),
      store: this.store,
      selected: selections,
      exposedEvidence,
      exposedPaths,
      toolsUsed,
      pendingLearningAction,
      reply,
      prepareReply,
      submissionDiagnostics,
      submissionBudget,
      confirmedLesson: Boolean(input.lessonActionId),
      assessment,
      candidates,
      currentUserMessage: content,
      source_message_id: userMessage.message_id,
      modelRuntime,
      workerRuns,
      workerServices: { assess: this.learningWorkers.assess, reviewReplyContent: this.learningWorkers.reviewReplyContent },
      }),
      createFeedbackHintTool(feedbackHint),
    ];
    assertProductSkillRun(primarySkill, {
      toolNames: tools.map((tool) => tool.name),
      inputSchemaId: "conversation-turn-v1",
      outputSchemaId: "conversation-reply-v7",
      contextBuilderId: "primary-conversation-context-v13",
    });

    const finalize = async (result: PiRunResult, runSignal?: AbortSignal, writeFence?: {permitId:string}) => {
      const checkExecution = () => { for (const signal of [input.signal,runSignal]) {
        if (signal?.aborted && !['cancelled','client_network_error'].includes(runAbortCode(signal.reason)))
          throw serviceError(runAbortCode(signal.reason),failureMessage(runAbortCode(signal.reason)),503);
      }};
      checkExecution();
      if (input.signal?.aborted && /lease_lost|maintenance_connection_lost/.test(String(input.signal.reason))) input.signal.throwIfAborted();
      if (!turnStarted) throw serviceError(result.stopReason, failureMessage(result.stopReason), result.stopReason === "cancelled" ? 409 : 503);
      if (result.stopReason === 'completed' && (input.signal?.aborted || runSignal?.aborted)) {
        result = { ...result, stopReason: runAbortCode(input.signal?.aborted ? input.signal.reason : runSignal?.reason) };
      }
      if (result.stopReason === 'completed' && !reply.value) {
        result = { ...result, text: '', stopReason: 'conversation_reply_invalid' };
      }
      if (input.lessonActionId && result.stopReason === 'completed' && reply.value?.kind !== 'lesson' && reply.value?.kind !== 'unavailable') {
        result = { ...result, text: '', stopReason: 'conversation_reply_invalid' };
        candidates.project = null; assessment.value = null; pendingLearningAction.value = null;
      }
      const proposedAction = pendingLearningAction.value;
      const noticeLanguage = normalizeDisplayLanguage(input.displayLanguage ?? projectDisplayLanguage(project));
      const chinese = noticeLanguage === 'zh-CN';
      if (userMessage.learning_action_result || result.stopReason !== 'completed' || reply.value?.kind === 'unavailable') {
        pendingLearningAction.value = null;
        if (reply.value?.kind === 'unavailable') assessment.value = null;
      }
      if (pendingLearningAction.value) pendingLearningAction.value.source_message_id = userMessage.message_id;
      // Stable teaching prose is reviewed separately from the mutable operation receipt.
      let visibleText = result.stopReason !== 'completed'
        ? result.stopReason === 'paused' ? '已暂停本轮处理，学习进度没有改变。'
          : result.stopReason === 'conversation_reply_invalid'
            ? '本轮回答未通过内容检查，学习进度没有改变。' + (project.study.teaching_question && questionIsCurrent(project, project.study.teaching_question)
              && questionWasDisplayed(project, project.study.teaching_question, userMessage.message_id) ? '原题仍然有效，可以继续作答或重试换题。'
                : input.lessonActionId ? '本次讲解尚未完成，已确认的进度保留。请重试本次讲解。' : '当前没有生效的题目，请重试本次请求。')
            : '本轮回答暂未完成，学习进度没有改变。可以重试这条消息。'
        : reply.value!.text;
      let question = result.stopReason === 'completed' && reply.value?.kind !== 'unavailable' ? reply.value?.question : null;
      if (question) visibleText = [visibleText, question.prompt].filter(Boolean).join('\n\n');
      const reviewSignal = input.signal && runSignal ? AbortSignal.any([input.signal, runSignal]) : input.signal ?? runSignal;
      // Program failure notices carry no model-authored repository claims.
      const prepared = result.stopReason !== 'completed' || reply.value?.kind === 'unavailable'
        ? { validation: { text: visibleText, evidence: [], errors: [], unresolved: [] }, blocks: [],
          errors: reply.value?.kind === 'unavailable' ? ['conversation_reply_unavailable'] : [] }
        : await prepareReplyEvidence({ reply: result.stopReason === 'completed' && reply.value ? reply.value
            : { kind: 'answer', text: visibleText, question: null, evidenceBlocks: [] }, text: visibleText,
          getSnapshot, snapshotId: capturedSnapshotId, exposed: exposedEvidence, projectId: input.projectId, store: this.store,
          signal: reviewSignal?.aborted ? undefined : reviewSignal });
      const validation = prepared.validation;
      const validationErrors = [...prepared.errors];
      const evidenceBlocks: ReplyEvidenceBlock[] = prepared.blocks;
      // Do not broaden explicit anchors from independent explanations with the
      // assessor's packets. Each block is reviewed against its own provenance.
      let acceptedEvidence = distinctEvidence(evidenceBlocks.flatMap(block => block.evidence));
      let reviewStatus: Record<string, unknown> | null = null;
      let reviewUsage = combinedUsage();
      let reviewRequestCount = 0;
      let reviewedText = validation.text;
      const finalBlockReviews: Review[] = [];
      let evidenceReview: Message["evidence_review"];
      if (
        input.reviewEvidence === true
        && result.stopReason === "completed"
        && Boolean(visibleText.trim())
        && reply.value?.kind !== 'unavailable'
      ) {
        const reviews: Awaited<ReturnType<typeof reviewAnswerEvidence>>[] = [];
        const supportedEvidence = [];
        for (const block of evidenceBlocks) {
          const reviewed: Review = block.commit_eligible ? await reviewBlock(block, reviewSignal)
            : { ...unavailableEvidenceReview(undefined, block.text),
              summary: '引用范围或证据覆盖不完整，未启动语义核对。', evidenceIncomplete: true,
              coverage: block.packet_coverage, validationErrors: block.validation_errors };
          reviews.push(reviewed);
          finalBlockReviews.push(reviewed);
          block.review = { status: reviewed.status, supported: reviewed.supported, summary: reviewed.summary, issues: reviewed.issues,
            completed: reviewed.completed, evidenceIncomplete: reviewed.evidenceIncomplete,
            ...(reviewed.coverage ? { coverage: reviewed.coverage } : {}),
            ...(reviewed.answerCoverage ? { answerCoverage: reviewed.answerCoverage } : {}),
            ...(reviewed.semanticReview ? { semanticReview: reviewed.semanticReview } : {}) };
          block.commit_eligible &&= reviewed.completed && !reviewed.evidenceIncomplete && reviewed.coverage?.complete !== false && reviewed.answerCoverage?.complete !== false
            && ((reviewed.status === 'reviewed' && reviewed.supported)
              || (block.kind === 'explanation' && reviewed.status === 'not_applicable' && !block.citation_coverage?.parsed));
          if (block.commit_eligible && reviewed.status === 'reviewed' && reviewed.supported) {
            const ids = new Set(reviewed.acceptedEvidenceIds);
            supportedEvidence.push(...block.evidence.filter(row => ids.has(row.stable_id)));
          }
        }
        const review = combineBlockReviews(reviews);
        acceptedEvidence = distinctEvidence(supportedEvidence);
        reviewStatus = {
          usage: review.usage,
          request_count: reviewRequestCount,
          model: runtimeForSkill(modelRuntime, "citation-review").model.id,
          provider: runtimeForSkill(modelRuntime, "citation-review").model.provider,
          completed: review.completed,
          supported: review.supported,
          stop_reason: review.stopReason,
          unsupported_claim_count: review.unsupportedClaims.length,
          unsupported_claims: review.unsupportedClaims,
          status: review.status,
          issues: review.issues,
          summary: review.summary,
          evidence_incomplete: review.evidenceIncomplete,
          validation_errors: review.validationErrors ?? [],
          blocks: evidenceBlocks.map((block, index) => ({ kind: block.kind, evidence: block.evidence, ...reviews[index] })),
        };
        reviewedText = withEvidenceReviewNotice(validation.text, review, noticeLanguage);
        evidenceReview = { status: review.status, supported: review.supported, summary: review.summary, issues: review.issues };
        if (review.status === "unverified") {
          validationErrors.push("citation_review_unavailable");
        } else if (review.status === "reviewed" && !review.supported) {
          validationErrors.push("citation_review_not_supported");
        }
      }
      // One commit decision follows every deterministic and requested model check.
      // Review-off still requires readable, complete evidence for teaching state.
      if (input.reviewEvidence !== true && result.stopReason === 'completed') {
        acceptedEvidence = distinctEvidence(evidenceBlocks.filter(block => block.commit_eligible).flatMap(block => block.evidence));
      }
      reviewUsage = combinedUsage(...executedReviews.map(review => review.usage));
      reviewRequestCount = executedReviews.reduce((sum, review) => sum + (review.diagnostics?.requestCount ?? 0), 0);
      if (reviewStatus) { reviewStatus.usage = reviewUsage; reviewStatus.request_count = reviewRequestCount; }
      checkExecution();
      if (reviewSignal?.aborted) {
        result = { ...result, stopReason: runAbortCode(reviewSignal.reason) };
        assessment.value = null;
        pendingLearningAction.value = null;
        question = null;
        acceptedEvidence = [];
        for (const block of evidenceBlocks) block.commit_eligible = false;
        reviewedText = '本轮回答暂未完成，学习进度没有改变。可以重试这条消息。';
      }
      const commit = reduceTeachingTurnCommit({ baseline: turnBaseline, candidate: candidates.project,
        completed: result.stopReason === 'completed', cancelled: Boolean(reviewSignal?.aborted),
        replyKind: reply.value?.kind, hasAssessment: Boolean(assessment.value), question: question ?? null,
        blocks: evidenceBlocks, validationErrors });
      project.study = commit.project.study;
      const { assessmentEligible, questionEligible, turnEligible, assessedQuestion } = commit;
      question = commit.question;
      if (result.stopReason === 'completed' && reply.value?.kind !== 'unavailable' && !reviewSignal?.aborted) {
        // Render only the selected partitions. Rejected candidates and their
        // quoted review claims must never remain as apparent success feedback.
        const visibleBlocks = evidenceBlocks.filter(block =>
          (block.kind !== 'assessment' || assessmentEligible) && (block.kind !== 'question' || questionEligible));
        reviewedText = [assessmentEligible ? assessment.value?.statusText : '', ...visibleBlocks.map(block => block.text)]
          .filter(Boolean).join('\n\n');
        const visibleReviews = finalBlockReviews.filter((_, index) => visibleBlocks.includes(evidenceBlocks[index]!));
        if (visibleReviews.length) reviewedText = withEvidenceReviewNotice(reviewedText, combineBlockReviews(visibleReviews), noticeLanguage);
      }
      if (!assessmentEligible) {
        assessment.value = null;
        reviewedText += '\n\n本次作答反馈未被采纳，原有学习记录和原题保留。可以重试这条消息，原作答不会作为已掌握证明。';
        validationErrors.push('assessment_not_adopted');
      }
      if (!questionEligible) {
        question = null;
        for (const block of evidenceBlocks.filter(block => block.kind === 'question')) block.commit_eligible = false;
        const oldQuestion = project.study.teaching_question;
        const retained = oldQuestion && questionIsCurrent(project, oldQuestion) && questionWasDisplayed(project, oldQuestion, userMessage.message_id);
        reviewedText += retained ? '\n\n本次换题未完成，原题仍然有效。可以继续回答原题，或重试换题。'
          : input.lessonActionId ? '\n\n本次题目未生效，已确认的进度保留。请重试本次讲解。'
            : '\n\n本次题目未生效，当前没有可作答的题目。请重试本次请求。';
        validationErrors.push('teaching_question_not_activated');
      }
      const eligibleIds = new Set(evidenceBlocks.filter(block => block.commit_eligible).flatMap(block => block.evidence.map(row => row.stable_id)));
      acceptedEvidence = acceptedEvidence.filter(row => eligibleIds.has(row.stable_id));
      if (question) question.commit_eligibility = { deterministic: true, review: input.reviewEvidence === true ? 'passed' : 'disabled' };
      if (!turnEligible) {
        pendingLearningAction.value = null;
        if (proposedAction) {
          const operation = isRouteAction(proposedAction)
            ? chinese ? '本次学习路线未创建或更新，确认卡未生效。' : 'The learning route was not created or updated; no confirmation card is active.'
            : chinese ? '本次学习操作未执行，确认卡未生效。' : 'The learning action was not performed; no confirmation card is active.';
          const progress = isDeepStrictEqual(turnBaseline.study, project.study)
            ? chinese ? '学习进度没有改变。' : 'Your learning progress is unchanged.'
            : chinese ? '本轮已采纳的作答记录保留，学习步骤没有推进。' : 'Accepted answer records are retained; the learning step has not advanced.';
          const failure = [operation, progress, chinese ? '可以重试这条消息。' : 'You can retry this message.'].join(' ');
          reviewedText = evidenceBlocks.length ? [reviewedText, failure].filter(Boolean).join('\n\n') : failure;
        }
      }
      const receipt = pendingLearningAction.value ? learningActionReceipt(pendingLearningAction.value) : null;
      if (!reviewedText.trim() && !receipt) reviewedText = chinese
        ? '本轮回答尚未完成，学习进度没有改变。可以重试这条消息。'
        : 'This reply could not be completed. Your learning progress is unchanged. You can retry this message.';
      validationErrors.splice(0, validationErrors.length, ...new Set(validationErrors));
      const totalUsage = combinedUsage(
        result.usage,
        ...workerRuns.map((worker) => worker.usage),
        reviewUsage,
      );
      const assistantMessage = answerMessage(
        project,
        withCitationNotice(reviewedText, validationErrors, noticeLanguage),
        provider.model,
        result.stopReason,
        Date.now() - startedAt,
        totalUsage,
        runId,
        messageThinkingSummary(result.events),
      );
      assistantMessage.content_parts = { body: assistantMessage.content, action_receipt: receipt,
        evidence_blocks: evidenceBlocks };
      assistantMessage.content = [assistantMessage.content, receipt].filter(Boolean).join('\n\n');
      assistantMessage.evidence = acceptedEvidence;
      const step = currentLearningStep(project);
      if (result.stopReason === 'completed' && step) assistantMessage.teaching_context = {
        snapshot_id: capturedSnapshotId!, route_revision: project.study.route_revision ?? 0, step_id: step.step_id,
      };
      if (question) assistantMessage.teaching_question = structuredClone(question);
      assistantMessage.evidence_review = evidenceReview;
      assistantMessage.unresolved_references = validation.unresolved;
      assistantMessage.context_eligible = result.stopReason === "completed" && validationErrors.length === 0
        && evidenceBlocks.every(block => block.commit_eligible);
      // A card is exposed only when this turn is eligible to commit it.
      if (turnEligible && pendingLearningAction.value) {
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
          + workerRuns.reduce((count, worker) => count + (worker.diagnostics?.requestCount ?? 0), 0)
          + reviewRequestCount,
        first_valid_evidence_ms: acceptedEvidence.length
          ? result.events.find((event) => event.type === "tool_result_received")?.elapsedMs ?? null
          : null,
      });
      // Merge into the current row: feedback, analysis and settings may have
      // changed while the model was running. Never replay an old transcript.
      const saved = await this.store.updateProject(input.projectId, input.owner.owner_id, row => {
        checkExecution();
        if (!isDeepStrictEqual(originalStudy, project.study)) {
          input.signal?.throwIfAborted();
          runSignal?.throwIfAborted();
        }
        if (input.lessonActionId) assertCurrentConfirmedLesson(row, input.lessonActionId);
        const currentUser = input.lessonActionId ? row.messages.at(-1)
          : [...row.messages].reverse().find(message => message.role === 'user');
        if (currentUser?.message_id !== userMessage.message_id || currentUser.trace_id !== runId) {
          throw serviceError('last_message_changed', '只能编辑最后一条消息，请刷新后重试。', 409);
        }
        if (input.lessonActionId && !isConfirmedLessonSource(row, currentUser)) throw serviceError('invalid_request', '程序讲解来源无效。', 400);
        if (!isDeepStrictEqual(originalStudy, project.study) && !isDeepStrictEqual(row.study, originalStudy)) {
          throw serviceError('learning_action_no_longer_current', '学习状态已经变化，请刷新后重试。', 409);
        }
        if (userMessage.learning_action_result) currentUser.learning_action_result = userMessage.learning_action_result;
        if (assessedQuestion && assessment.value) {
          const displayed = row.messages.find(message => message.role === 'assistant'
            && message.teaching_question?.question_id === assessedQuestion.question_id);
          if (displayed) displayed.teaching_question = structuredClone(assessedQuestion);
        }
        row.messages.push(assistantMessage);
        if (!isDeepStrictEqual(originalStudy, project.study) && isDeepStrictEqual(row.study, originalStudy)) {
          row.study = project.study;
          expireSupersededAdvanceCards(row);
          stateChanged = true;
        }
      }, undefined, writeFence);
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
        reply_kind: reply.value?.kind ?? null,
        submission_diagnostics: submissionDiagnostics,
        submission_budget: { used: submissionBudget.used, limit: MAX_REPLY_SUBMISSIONS },
        evidence_preflight: preflightDiagnostics,
        assessment_review_failures: assessmentReviewFailures,
        evidence_review_runs: executedReviews.map((review, index) => ({ attempt: index + 1,
          completed: review.completed, supported: review.supported, stop_reason: review.stopReason,
          issues: review.issues, validation_errors: review.validationErrors,
          usage: review.usage, diagnostics: review.diagnostics, semantic_review: review.semanticReview })),
        commit_eligibility: { turn: turnEligible, assessment: assessmentEligible, question: questionEligible, blocks: evidenceBlocks },
        question_id: question?.question_id ?? project.study.teaching_question?.question_id ?? null,
        question_created_message_id: question?.created_message_id ?? project.study.teaching_question?.created_message_id ?? null,
        question_restored: questionRestored,
        question_step_id: question?.step_id ?? project.study.teaching_question?.step_id ?? null,
        question_route_revision: question?.route_revision ?? project.study.teaching_question?.route_revision ?? null,
        source_message_id: userMessage.message_id,
        route_revision: project.study.route_revision ?? 0,
        learning_action_policy: pendingLearningAction.value?.execution_policy ?? null,
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
      }).catch(() => this.metrics.increment('what_the_repo_postcommit_errors_total', 1, { stage: 'conversation_trace' }));
      if (!input.lessonActionId && ["completed", "paused"].includes(result.stopReason)) try { this.feedbackWorker.schedule({
        ownerId: input.owner.owner_id,
        projectId: input.projectId,
        userMessageId: userMessage.message_id,
        hint: feedbackHint.value ?? undefined,
        modelRuntime: await this.feedbackRuntime(`feedback:${input.projectId}:${"messageId" in input ? input.messageId : runId}`),
      }); } catch { this.metrics.increment('what_the_repo_postcommit_errors_total', 1, { stage: 'feedback_schedule' }); }
      const publicErrorCode = selectedModel === FREE_SELECTOR && result.stopReason === "provider_balance_insufficient" ? "platform_provider_balance_insufficient"
        : selectedModel === FREE_SELECTOR && ["provider_authentication_failed", "provider_permission_denied"].includes(result.stopReason) ? "provider_unavailable" : result.stopReason;
      return {
        assistantText: trustedMessageText(assistantMessage),
        ...(assistantMessage.context_eligible === false || submissionDiagnostics.length || preflightDiagnostics.length
          || result.events.some(event => event.type === 'tool_result_received' && event.toolName === 'submit_conversation_reply' && event.isError)
          ? { trustedMessages: visibleContextMessages([userMessage, assistantMessage], project) } : {}),
        stopReason: result.stopReason,
        value: {
          ...(!["completed", "paused"].includes(result.stopReason) ? { error: {
            code: publicErrorCode,
            message: publicErrorCode === 'conversation_reply_invalid' ? assistantMessage.content : failureMessage(publicErrorCode),
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
          : result.stopReason !== "completed" || !trustedMessageText(assistantMessage)
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
      systemPrompt: formatProductSkillInvocation(primarySkill, primarySystemPrompt()),
      turnContext: primaryTurnContext({
        project,
        profile,
        selections,

        displayLanguage: input.displayLanguage,

      }),
      userMessage: content,
      replyContract: {
        budget: submissionBudget,
        onSchemaRejection: fields => {
          if (submissionDiagnostics.length < 12) submissionDiagnostics.push({ attempt: submissionBudget.used, code: 'reply_schema_invalid', fields });
        },
        read: () => reply.value ? reply.value.text || reply.value.question?.prompt
          || (reply.value.kind === 'action' && pendingLearningAction.value ? learningActionReceipt(pendingLearningAction.value) : null) : null,
        correction: 'The answer is not yet submitted. Finish with submit_conversation_reply. A lesson must include its exact registered question, targets and evidence; an action must have a successful proposal. Tool errors do not count as success. Use the original user message and existing saved question; never ask the learner to resend their answer to repair registration.',
      },
      turn: {
        messageId: userMessage.message_id,
        replace: Boolean(input.replaceMessageId),
        previousMessages: visibleContextMessages(lessonBefore, project),
      },
      beforePrompt: async (runSignal, writeFence) => {
        runSignal?.throwIfAborted();
        const saved = await this.store.updateProject(input.projectId, input.owner.owner_id, row => {
          runSignal?.throwIfAborted();
          if (input.lessonActionId) {
            assertCurrentConfirmedLesson(row, input.lessonActionId);
            const existing = row.messages.find(message => message.message_id === userMessage.message_id);
            if (lessonSource) {
              if (!existing || !isDeepStrictEqual(existing, lessonSource)) throw serviceError('last_message_changed', '讲解来源已经变化。', 409);
              if (!isDeepStrictEqual(row.messages.slice(row.messages.indexOf(existing) + 1), lessonTail)) {
                throw serviceError('last_message_changed', '讲解之后已有新消息，请检查聊天记录。', 409);
              }
              row.messages = row.messages.slice(0, row.messages.indexOf(existing));
            } else if (existing) throw serviceError('lesson_interrupted', '讲解来源已经存在，请恢复原运行。', 409);
            else if (!isDeepStrictEqual(row.messages.map(message => message.message_id), lessonBefore.map(message => message.message_id))) {
              throw serviceError('last_message_changed', '启动讲解前聊天记录已经变化。', 409);
            }
          }
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
        }, undefined, writeFence);
        if (!saved) throw serviceError("not_found", "项目不存在", 404);
        turnStarted = true;
        if (!input.lessonActionId) await this.memoryMaintenance.schedule({ ownerId: input.owner.owner_id, projectId: input.projectId });
      },
      modelRuntime,
      thinkingLevel: provider.thinkingLevel ?? "medium",
      tools,
      runId,
      signal: input.signal,
      onEvent: event => input.onEvent?.({ ...event, sequence: event.sequence + admissionEvents }),
      }, finalize);
    } catch (error) {
      if (input.signal?.aborted) { const code=runAbortCode(input.signal.reason); throw serviceError(code,failureMessage(code),code==='cancelled'?409:503); }
      const local = executionErrorCode(error); if (local) throw serviceError(local,failureMessage(local),503);
      if (error instanceof PiSessionWaitTimeoutError) {
        throw serviceError("session_busy", "上一轮仍在处理，请等待它结束或取消后再试", 409);
      }
      throw error;
    } finally {
      this.runOwners.delete(runId);
      this.runtime.releaseRun(runId);
      try {
        if (snapshotLease) await this.store.releaseSnapshotReadLease(snapshotLease).catch(() => undefined);
        await releaseRepository?.();
      } finally { await admission?.release(); }
    }
  }
}

function trustedMessageText(message: Message): string {
  if (message.context_eligible !== false) return message.content;
  return (message.content_parts?.evidence_blocks ?? []).filter(block => block.commit_eligible)
    .map(block => block.text).join('\n\n');
}

function visibleContextMessages(messages: Message[], project?: Project): AgentMessage[] {
  return messages.flatMap((message, index): AgentMessage[] => {
    if ((message.error && message.error !== "paused") || message.placeholder || !message.content.trim()) return [];
    const programSource = Boolean(project && isConfirmedLessonSource(project, message));
    if (message.role === "user" || programSource) {
      const answer = messages[index + 1];
      // Legacy sessions have no turn marker. Do not reintroduce unanswered failed turns.
      if (answer?.role !== "assistant" || (answer.error && answer.error !== "paused") || answer.placeholder || !trustedMessageText(answer).trim()) return [];
    }
    if (message.role === "user" || programSource) return [{ role: "user", content: message.content, timestamp: Date.parse(message.created_at) }];
    if (message.role !== "assistant") return [];
    const trusted = trustedMessageText(message);
    if (!trusted.trim()) return [];
    return [{ role: "assistant", content: [{ type: "text", text: trusted }],
      api: "openai-completions", provider: "history", model: message.model ?? "history",
      stopReason: "stop", timestamp: Date.parse(message.created_at),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  });
}

export function answerMessage(
  project: Project,
  text: string,
  model: string,
  stopReason: string,
  latencyMs: number,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number },
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
      prompt_tokens: usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens,
      completion_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
      total_tokens: usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens + usage.outputTokens,
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

function isExecutedActionReplay(input: ConversationRunInput, content: string, snapshotId: string | null, user: Message, answer: Message): boolean {
  const action = answer.learning_action;
  if (user.content !== content || !answer.content_parts || !user.learning_action_result) return false;
  if (input.selections && !isDeepStrictEqual(input.selections, user.attachments ?? [])) return false;
  // Earlier regenerated answers omitted the resolved card. The persisted source
  // result is still authoritative for an exact resend, never for a new UI action.
  if (!action) return !input.lessonActionId && user.analysis_snapshot_id === snapshotId
    && answer.analysis_snapshot_id === snapshotId;
  if (action.status !== 'executed'
    || action.source_message_id !== user.message_id || user.learning_action_result?.action_id !== action.action_id
    || user.learning_action_result.route_revision !== action.route_revision
    || user.learning_action_result.step_id !== (action.expected_step_id ?? null)
    || action.snapshot_id !== snapshotId) return false;
  return !input.lessonActionId;
}

function markConfirmedLesson(action: LearningActionCard): void {
  if (action.status === 'executed' && action.outcome?.next_step_id
    && ['start_learning_route', 'switch_learning_target', 'advance_learning_step'].includes(action.action)) {
    action.outcome.lesson_run_id ??= randomUUID();
  }
}

export function assertCurrentConfirmedLesson(project: Project, actionId: string): LearningActionCard {
  const action = currentConfirmedLesson(project, actionId);
  if (!action) throw serviceError('learning_action_no_longer_current', '当前学习步骤已经变化，请刷新后重试。', 409);
  return action;
}

function isRetryableLearningAction(action: LearningActionCard): boolean {
  return action.status === "pending" || action.status === "failed"
    || (action.status === "confirmed" && (!action.run_expires_at || Date.parse(action.run_expires_at) <= Date.now()));
}

function recordLearningActionResult(project: Project, action: LearningActionCard): void {
  const source = project.messages.find(message => message.role === "user" && message.message_id === action.source_message_id);
  if (!source) return;
  if (source.learning_action_result && source.learning_action_result.action_id !== action.action_id) {
    throw serviceError("learning_action_already_applied", "这条消息的学习操作已经执行过。", 409);
  }
  source.learning_action_result = {
    action_id: action.action_id, route_revision: action.route_revision ?? 0,
    step_id: action.expected_step_id ?? null,
  };
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
