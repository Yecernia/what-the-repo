import { runtimeConfig } from '../admin/runtime-config.js';
import { randomUUID, createHash } from "node:crypto";
import { analysisFailureCode } from "../agent/provider-error.js";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  nowIso,
  REPOSITORY_ANALYSIS_OWNER_ID,
  recordAnalysisProgress,
  setAnalysisStrategy,
  type AnalysisProgressEvent,
  type AnalysisProgressKind,
  type AnalysisStage,
  type AnalysisStrategy,
  type Project,
} from "../domain/conversation.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { ServerConfig } from "../config.js";
import {
  AnalysisLeaseLostError,
  type AnalysisLeaseFence,
  type ProductStore,
} from "../persistence/store.js";
import { digestSemanticBatch, type SemanticBatch } from "../domain/semantic-batch.js";
import type { WorkerDiagnostics } from "../agent/worker-diagnostics.js";
import { WORKER_FAILURE_CODES, workerFailureCode } from "../agent/worker-failure.js";
import { trackAnalysisStage, type AnalysisProgressUpdate } from "./progress.js";
import { createAnalysisExecutionBudget } from "./execution-budget.js";
import type { SemanticBatchContext } from "./semantic-worker.js";
import { fetchPublicGithubSource, type GithubSource } from "./github.js";
import { buildSnapshot, type BuiltSnapshot } from "./graph.js";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { resolveAnalysisExecution, resolveAnalysisProvider } from "./execution-identity.js";
export { resolveAnalysisProvider } from "./execution-identity.js";
import { createModelRuntime } from "../agent/model-runtime.js";
import { resolveAgentProvider } from "../agent/role-models.js";
import { enrichSnapshotWithPi } from "./semantic-worker.js";
import { createWebResearchClient } from "./web-research-client.js";
import { searchInitialRepositoryResearch, type InitialWebResearch } from "./initial-web-research.js";
import type { WebResearchClient } from "../agent/web-research-tools.js";
import { assertValidEvidenceSnapshot } from "../domain/snapshot-validation.js";
import { createLspRunner, type LspRunner } from "./lsp.js";
import {
  type LspRunResult,
  type ParsedFile,
  type SourceFileManifest,
  unavailableLspResult,
} from "./facts.js";
import {
  applyIncrementalProvenance,
  buildFullPlan,
  buildIncrementalPlan,
  createAnalysisCache,
  incrementalSummary,
  lspTargetFiles,
  mergeLspResult,
  mergeParsedFiles,
  readAnalysisCache,
  type AnalysisCache,
  type IncrementalPlan,
} from "./incremental.js";
import { languageForPath } from "./languages.js";
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import type { RevisionRedirect } from "../domain/lifecycle.js";
import {
  SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
  asSnapshotLanguageOverlayPayload,
  extractSnapshotLanguageOverlay,
  snapshotMatchesDisplayLanguage,
  stripSnapshotLanguage,
} from "../domain/snapshot-language.js";
import type { PiModelRuntime } from "../agent/types.js";
import type { ProviderGateFactory } from "../agent/provider-gate.js";
import type { ProviderUsageBudget } from "../agent/provider-budget.js";
import {
  DEFAULT_DISPLAY_LANGUAGE,
  projectDisplayLanguage,
  normalizeDisplayLanguage,
} from "../domain/display-language.js";
import {
  ANALYSIS_CONFIG_DIGEST,
  ANALYZER_BUNDLE_VERSION,
  canonicalPublicSnapshotKey,
} from "./identity.js";
import { generateSnapshotLanguageOverlay } from "./language-overlay-worker.js";
import { defaultRuntimeMetrics, METRIC_NAMES, type RuntimeMetrics } from "../observability/metrics.js";
import { performance } from "node:perf_hooks";
import type { StoredSourceSnapshot } from "../persistence/snapshot-object-store.js";

export { ANALYSIS_CONFIG_DIGEST, ANALYZER_BUNDLE_VERSION } from "./identity.js";

const JOB_LEASE_SECONDS = 15 * 60;
const JOB_HEARTBEAT_MS = 60_000;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

type SemanticEnrichment = Awaited<ReturnType<typeof enrichSnapshotWithPi>>;
type SemanticEnricher = (
  snapshot: BuiltSnapshot,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  displayLanguage?: string,
  batchContext?: SemanticBatchContext,
  webResearch?: WebResearchClient,
  initialWebResearch?: Promise<InitialWebResearch>,
) => Promise<SemanticEnrichment>;

interface AnalysisCheckpoint {
  schema_version?: 1;
  analysis_config_digest?: string;
  analyzer_bundle_version?: string;
  stage: "source" | "semantic" | "assembly";
  source_root: string;
  fetched: GithubSource;
  snapshot_id: string;
  public_key: string;
  repository: string;
  commit_sha: string;
  plan?: IncrementalPlan;
  parsed?: ParsedFile[];
  lsp_results?: LspRunResult[];
  display_language?: string;
  provenance_applied?: boolean;
  previous_fact_graph?: NonNullable<EvidenceSnapshot["fact_graph"]> | null;
  redirects?: RevisionRedirect[];
  prepared_source?: StoredSourceSnapshot;
}

function semanticFailureCode(error: unknown): string {
  const local = workerFailureCode(error);
  if (local) return local;
  const category = analysisFailureCode(error instanceof Error ? error.message : "");
  if (category.startsWith("site_")) return category;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unsupported_model") || message.includes("unsupported_provider") || message.startsWith("skill_")) {
    return "provider_configuration";
  }
  return "worker_internal_error";
}

/**
 * A semantic phase that produced no usable structured result must terminate
 * before the large static snapshot is copied, indexed, or uploaded. The
 * deterministic graph is still valid, but this analysis attempt cannot
 * publish the requested architecture projection without a semantic result.
 */
export function semanticTerminalFailureCode(stopReason: string): string | null {
  const normalized = stopReason.trim().toLowerCase();
  const providerCode = analysisFailureCode(normalized);
  if(providerCode==='provider_balance_insufficient')return 'platform_provider_balance_insufficient';
  if ((providerCode.startsWith("provider_") || providerCode.startsWith("site_")) && providerCode !== "provider_request_failed") return providerCode;
  if (normalized.includes("value_reference_validation_failed") || normalized.includes("value_candidate_validation_failed")
    || normalized.includes("component_semantics_incomplete")) return "structured_worker_failed";
  for (const code of WORKER_FAILURE_CODES) if (normalized.includes(code)) return code;
  if (normalized.includes("provider_transient_error") && !normalized.includes("provider_request_failed")) return "provider_transient_error";
  if (normalized === "semantic_provider_configuration") return "provider_configuration";
  if (normalized.includes("semantic_no_structured_result") || normalized.includes("structured_output_missing")
    || normalized.includes("structured_worker_failed")) return "structured_worker_failed";
  if (
    normalized === "provider_unavailable"
    || normalized.startsWith("semantic_provider_")
    || normalized.includes("provider_request_failed")
  ) {
    return "provider_unavailable";
  }
  // Absence of a value result is different from a valid empty candidate list.
  // Keep specific provider/local causes above; unknown no-result reasons fail closed.
  if (normalized.includes("value_output_missing")) return "structured_worker_failed";
  return null;
}

function isAnalysisLeaseLost(error: unknown): boolean {
  return error instanceof AnalysisLeaseLostError
    || (error instanceof Error && error.message === "analysis_lease_lost");
}

/** Only transient network/provider failures are retried automatically. */
export function isRetryableAnalysisError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized === "analysis_lease_lost") return false;
  if (["provider_transient_error", "provider_rate_limited", "provider_busy", "provider_connection_failed"].includes(normalized)) return true;
  if (normalized.includes("timeout") || normalized.includes("timed out")) return true;
  if (normalized.includes("econn") || normalized.includes("network") || normalized.includes("fetch failed")) return true;
  if (normalized.includes("provider_unavailable") || normalized.includes("provider_timeout")) return true;
  const status = normalized.match(/(?:^|_)(429|500|502|503|504)(?:$|_)/)?.[1];
  return Boolean(status);
}

export function analysisRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(4, attempt - 1));
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** exponent));
}

/**
 * Semantic enrichment is an enhancement over the deterministic snapshot.
 * A provider or Worker failure must never erase facts already produced by the
 * static analyzer, especially for documentation-heavy repositories.
 */
export async function enrichSnapshotSafely(
  snapshot: BuiltSnapshot,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  enricher: SemanticEnricher = enrichSnapshotWithPi,
  displayLanguage = DEFAULT_DISPLAY_LANGUAGE,
  batchContext?: SemanticBatchContext,
  webResearch?: WebResearchClient,
  initialWebResearch?: Promise<InitialWebResearch>,
): Promise<SemanticEnrichment> {
  try {
    return await enricher(snapshot, modelRuntime, signal, displayLanguage, batchContext, webResearch, initialWebResearch);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      snapshot,
      stopReason: `semantic_${semanticFailureCode(error)}`,
      workerRuns: [],
    };
  }
}

export function createSemanticBatchRecorder(
  store: ProductStore,
  job: AnalysisJob,
  fence: AnalysisLeaseFence,
): SemanticBatchContext {
  const recorder = {
    load: (jobId: string, batchId: string) => store.loadSemanticBatch(jobId, batchId),
    start: async (batch: SemanticBatch): Promise<void> => {
      const existing = await store.loadSemanticBatch(batch.job_id, batch.batch_id);
      const checkpoint = { ...existing?.checkpoint, ...batch.checkpoint };
      const previous = (existing?.output as { diagnostics?: WorkerDiagnostics } | null)?.diagnostics;
      if (previous) {
        const runs = Array.isArray(checkpoint.diagnostic_runs) ? [...checkpoint.diagnostic_runs] : [];
        if (!runs.some((run) => run?.diagnostics?.runId === previous.runId)) {
          runs.push({ attempt: existing!.attempt, input_digest: existing!.input_digest, diagnostics: previous });
        }
        checkpoint.diagnostic_runs = runs.slice(-8);
        checkpoint.dropped_diagnostic_runs = Number(checkpoint.dropped_diagnostic_runs ?? 0) + Math.max(0, runs.length - 8);
      }
      await store.saveSemanticBatch({
        ...(existing ?? batch),
        ...batch,
        attempt: job.attempt,
        lease_owner: fence.workerId,
        lease_expires_at: job.lease_expires_at,
        status: "running",
        checkpoint,
        output: null,
        output_digest: null,
        created_at: existing?.created_at ?? batch.created_at,
        updated_at: nowIso(),
        completed_at: null,
        error: null,
      }, fence);
    },
    complete: async (batchId: string, output: unknown, outputDigest: string): Promise<void> => {
      const existing = await store.loadSemanticBatch(job.job_id, batchId);
      if (!existing) throw new Error("semantic_batch_missing");
      await store.saveSemanticBatch({
        ...existing,
        status: "succeeded",
        output,
        output_digest: outputDigest,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: nowIso(),
        completed_at: nowIso(),
        error: null,
      }, fence);
    },
    fail: async (batchId: string, error: string, status: "failed" | "cancelled" = "failed", output?: unknown): Promise<void> => {
      const existing = await store.loadSemanticBatch(job.job_id, batchId);
      if (!existing) return;
      await store.saveSemanticBatch({
        ...existing,
        status,
        error,
        ...(output === undefined ? {} : { output, output_digest: digestSemanticBatch(output) }),
        lease_owner: null,
        lease_expires_at: null,
        updated_at: nowIso(),
        completed_at: nowIso(),
      }, fence);
    },
  };
  return { recorder, jobId: job.job_id, jobAttempt: job.attempt };
}

export class AnalysisCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private activeRuns = 0;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly concurrency: number;
  private readonly parser = new TreeSitterAnalyzer();
  private lspRunner: LspRunner | null = null;
  private readonly workerId = `ts-analysis-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly store: ProductStore,
    private readonly config: ServerConfig,
    private readonly providerGateFactory?: ProviderGateFactory,
    private readonly metrics: RuntimeMetrics = defaultRuntimeMetrics,
    private readonly providerBudget?: ProviderUsageBudget,
  ) {
    this.concurrency = Math.max(1, Math.min(16, config.analysisQueueConcurrency ?? 1));
  }

  async start(options: { poll?: boolean } = {}): Promise<void> {
    this.stopping = false;
    await this.parser.init();
    this.lspRunner = await createLspRunner();
    if (options.poll === false) return;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, 500);
    void this.runOnce();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error("analysis_worker_stopping"));
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  requestCancellation(jobId: string): boolean {
    const controller = this.activeControllers.get(jobId);
    if (!controller) return false;
    controller.abort(new Error("analysis_cancelled"));
    return true;
  }

  async runOnce(): Promise<void> {
    if (this.stopping || this.activeRuns >= this.concurrency) return;
    const lanes: Promise<void>[] = [];
    while (!this.stopping && this.activeRuns < this.concurrency) {
      this.activeRuns += 1;
      this.metrics.setGauge(METRIC_NAMES.analysisActive, this.activeRuns, { worker: "analysis" });
      const execution = (async () => {
        while (!this.stopping && await this.claimAndProcess()) { /* Drain durable work whenever a slot becomes free. */ }
      })().finally(() => {
        this.activeRuns -= 1;
        this.metrics.setGauge(METRIC_NAMES.analysisActive, this.activeRuns, { worker: "analysis" });
        this.inFlight.delete(execution);
      });
      this.inFlight.add(execution);
      lanes.push(execution);
    }
    await Promise.all(lanes);
  }

  private async claimAndProcess(): Promise<boolean> {
    const candidate = await this.store.claimAnalysisJob(this.workerId, JOB_LEASE_SECONDS);
    if (!candidate) return false;
    const startedAt = performance.now();
    const role = candidate.execution_role ?? "standalone";
    this.metrics.increment(METRIC_NAMES.analysisJobs, 1, { role, phase: "claimed" });
    await this.process(candidate);
    const finalJob = typeof this.store.loadJob === "function"
      ? await this.store.loadJob(candidate.job_id).catch(() => null)
      : null;
    const status = finalJob?.status ?? "unknown";
    this.metrics.increment(METRIC_NAMES.analysisJobs, 1, { role, status });
    this.metrics.observe(METRIC_NAMES.analysisDuration, performance.now() - startedAt, { role, status });
    if (status === "queued" && (finalJob?.attempt ?? candidate.attempt) > candidate.attempt) {
      this.metrics.increment(METRIC_NAMES.analysisJobs, 1, { role, outcome: "retry" });
    }
    return true;
  }

  private async requeueAfterTransientFailure(
    job: AnalysisJob,
    worker: string,
    message: string,
    beforeRelease?: () => Promise<void>,
  ): Promise<boolean> {
    if (job.attempt >= job.max_attempts || !isRetryableAnalysisError(message)) return false;
    const timestamp = nowIso();
    const availableAt = new Date(Date.now() + analysisRetryDelayMs(job.attempt)).toISOString();
    // Keep the lease while recording the project error. Releasing it first
    // would let a replacement worker race with this stale write.
    await beforeRelease?.();
    return this.store.finishAnalysisJob({
      ...job,
      status: "queued",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      available_at: availableAt,
      completed_at: null,
      updated_at: timestamp,
      error: message,
      error_code: "analysis_retry_scheduled",
    }, worker, job.attempt);
  }

  private async updateAnalysisProjects(
    job: AnalysisJob,
    fence: AnalysisLeaseFence,
    mutate: (project: Project) => void,
  ): Promise<void> {
    const projects = job.repository_update_id
      ? await this.store.listRepositoryUpdateProjects(job.repository_update_id)
      : [await this.store.loadProject(job.project_id)].filter((row): row is Project => Boolean(row));
    for (const project of projects) {
      await this.store.updateProject(project.project_id, project.owner_id, mutate, fence);
    }
  }

  private async recordAnalysisPhase(
    job: AnalysisJob,
    fence: AnalysisLeaseFence,
    kind: AnalysisProgressKind,
    status: AnalysisProgressEvent["status"],
    options: {
      stage?: AnalysisStage;
      strategy?: Exclude<AnalysisStrategy, null>;
      startedAt?: string;
      clearError?: boolean;
      progress?: AnalysisProgressUpdate;
    } = {},
  ): Promise<void> {
    await this.updateAnalysisProjects(job, fence, (row) => {
      if (options.stage) row.analysis.stage = options.stage;
      if (options.startedAt) row.analysis.started_at ??= options.startedAt;
      if (options.clearError) row.analysis.error = null;
      row.analysis.completed_at = null;
      if (options.strategy) setAnalysisStrategy(row.analysis, options.strategy);
      recordAnalysisProgress(row.analysis, kind, status, nowIso(), {
        ...options.progress, instance_id: `${job.job_id}/${job.attempt}/${kind}`,
      });
    });
  }

  private progressContext(job: AnalysisJob, fence: AnalysisLeaseFence): SemanticBatchContext {
    return { ...createSemanticBatchRecorder(this.store, job, fence),
      onProgress: progress => this.recordAnalysisPhase(job, fence, progress.kind, progress.status, { progress }),
    };
  }

  private async process(job: AnalysisJob): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(job.job_id, controller);
    const pollCancellation = async (): Promise<void> => {
      if (typeof this.store.loadJob !== "function") return;
      const current = await this.store.loadJob(job.job_id).catch(() => null);
      if (!current
        || current.status !== "running"
        || current.lease_owner !== job.lease_owner
        || current.attempt !== job.attempt) {
        controller.abort(new Error(current?.status === "cancelled" ? "analysis_cancelled" : "analysis_lease_lost"));
      }
    };
    const cancellationTimer = setInterval(() => { void pollCancellation(); }, 1_000);
    cancellationTimer.unref?.();
    void pollCancellation();
    try {
      await this.processClaimedJob(job, controller.signal);
    } finally {
      clearInterval(cancellationTimer);
      this.activeControllers.delete(job.job_id);
      if (
        controller.signal.aborted
        && controller.signal.reason instanceof Error
        && controller.signal.reason.message === "analysis_worker_stopping"
        && job.lease_owner
      ) {
        await this.store.releaseAnalysisJobForResume(job.job_id, job.lease_owner, job.attempt);
      }
    }
  }

  private async processClaimedJob(job: AnalysisJob, signal: AbortSignal): Promise<void> {
    const config = await runtimeConfig(this.config, this.store, job.created_at, job.config_version);
    const worker = job.lease_owner;
    if (!worker || job.status !== "running") return;
    const project = await this.store.loadProject(job.project_id);
    if (signal.aborted) return;
    if (!project) {
      if (signal.aborted) return;
      const completed = nowIso();
      await this.store.finishAnalysisJob({
        ...job,
        status: "failed",
        lease_owner: null,
        lease_expires_at: null,
        error: "project_not_found",
        error_code: "project_not_found",
        completed_at: completed,
        updated_at: completed,
      }, worker, job.attempt);
      return;
    }
    const fence: AnalysisLeaseFence = {
      jobId: job.job_id,
      workerId: worker,
      attempt: job.attempt,
      projectId: project.project_id,
    };
    // Exhausted leases are reclaimed only to finalize the durable task and all
    // shared participants. This path must never start source or model work.
    if (job.error_code === 'lease_attempts_exhausted') {
      const message = 'analysis job lease expired after maximum attempts';
      if (job.repository_update_id) {
        await this.store.failRepositoryUpdate(job.repository_update_id, message, fence);
      } else if (job.language_overlay_key && project.analysis.canonical_snapshot_key) {
        await this.store.failSnapshotLanguageOverlay(project.analysis.canonical_snapshot_key,
          normalizeDisplayLanguage(project.display_language), message, fence);
      } else {
        const completed = nowIso();
        await this.store.updateProject(project.project_id, project.owner_id, row => {
          recordAnalysisProgress(row.analysis, 'failed', 'failed', completed);
          row.analysis.stage = 'failed'; row.analysis.error = message; row.analysis.completed_at = completed;
        }, fence);
        await this.store.finishAnalysisJob({ ...job, status: 'failed', lease_owner: null,
          lease_expires_at: null, completed_at: completed, updated_at: completed, error: message }, worker, job.attempt);
      }
      return;
    }
    const semanticBatchContext = this.progressContext(job, fence);
    await this.updateAnalysisProjects(job, fence, row => {
      // A reclaimed lease is a new attempt; old in-flight rows must not keep spinning.
      for (const event of row.analysis.progress_events ?? []) {
        if (event.status === "running") {
          event.status = event.instance_id ? "cancelled" : "completed";
          event.timestamp = nowIso();
        }
      }
    });
    const started = job.heartbeat_at ?? nowIso();
    const runningJob = job;
    const refreshLease = async (): Promise<boolean> => {
      if (signal.aborted) return false;
      try {
        const refreshed = await this.store.heartbeatAnalysisJob(
          job.job_id,
          worker,
          job.attempt,
          JOB_LEASE_SECONDS,
        );
        return refreshed;
      } catch {
        return false;
      }
    };
    const heartbeat = setInterval(() => {
      void refreshLease();
    }, JOB_HEARTBEAT_MS);
    if (job.execution_role === "overlay") {
      try {
        await this.processLanguageOverlay(job, project, refreshLease, fence, signal);
      } catch (error) {
        if (signal.aborted || isAnalysisLeaseLost(error)) return;
        const message = error instanceof Error ? error.message : "language_overlay_failed";
        const publicKey = project.analysis.canonical_snapshot_key;
        const requeued = await this.requeueAfterTransientFailure(job, worker, message, async () => {
          await this.store.updateProject(project.project_id, project.owner_id, (row) => {
            row.analysis.completed_at = null;
            row.analysis.error = message;
          }, fence);
        });
        if (requeued) {
          // Project state was recorded while the old attempt still owned the lease.
        } else if (publicKey) {
          await this.store.failSnapshotLanguageOverlay(
            publicKey,
            normalizeDisplayLanguage(project.display_language),
            message,
            fence,
          );
        } else {
          await this.store.finishAnalysisJob({
            ...job,
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: nowIso(),
            updated_at: nowIso(),
            completed_at: nowIso(),
            error: message,
            error_code: "language_overlay_failed",
          }, worker, job.attempt);
        }
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }
    let checkpoint: { checkpoint: AnalysisCheckpoint; snapshot: unknown | null } | null = null;
    let checkpointPersisted = false;
    let temporary = join(config.dataDir, "source-snapshots", project.project_id, `.tmp-${randomUUID()}`);
    const backgroundController = new AbortController();
    let initialWebResearch: Promise<InitialWebResearch> | undefined;
    let sourcePreparation: Promise<StoredSourceSnapshot | null> | undefined;
    let sourcePreparationMs = 0;
    let sourcePreparationFailure: Error | undefined;
    try {
      // Missing checkpoints return null. Corruption or read errors must stop
      // recovery instead of silently discarding completed work and model cost.
      checkpoint = await this.store.loadAnalysisCheckpoint<AnalysisCheckpoint>(project.project_id);
      checkpointPersisted = Boolean(checkpoint);
      if (checkpoint?.checkpoint.source_root) temporary = checkpoint.checkpoint.source_root;
      const checkpointStage = checkpoint?.checkpoint.stage ?? "fetching";
      if (checkpoint?.snapshot && checkpointStage === "assembly") {
        await this.resumeAssemblyFromCheckpoint({
          job: runningJob,
          project,
          fence,
          signal,
          checkpoint: checkpoint.checkpoint,
          snapshot: checkpoint.snapshot as unknown as BuiltSnapshot,
        });
        return;
      }
      const execution = await resolveAnalysisExecution(config, { providerGateFactory: this.providerGateFactory });
      const analysisConfigDigest = execution.digest;
      const webResearch = createWebResearchClient(config.webSearchApiKey);
      const startResearch = async ({ owner, repo, commitSha }: { owner: string; repo: string; commitSha: string }) => {
        if (!execution.runtime || initialWebResearch) return;
        const repository = `${owner}/${repo}`;
        const key = canonicalPublicSnapshotKey(repository, commitSha, ANALYZER_BUNDLE_VERSION, analysisConfigDigest);
        if (await this.store.loadPublicSnapshotMetadata(key)) return;
        signal.throwIfAborted();
        const researchSignal = AbortSignal.any([signal, backgroundController.signal]);
        initialWebResearch = trackAnalysisStage("researching_project", semanticBatchContext,
          scoped => searchInitialRepositoryResearch({ repository, commitSha, client: webResearch,
            signal: researchSignal, batchContext: scoped }),
          { batches: true, totalBatches: 1, signal: researchSignal,
            status: result => (result.response as { status?: string } | null)?.status === "unavailable" ? "skipped" : "completed" });
        // The value branch awaits this result later. Observe a failure now as
        // well, so an early persistence error cannot become an unhandled rejection.
        void initialWebResearch.catch(() => undefined);
      };
      const resumingStatic = checkpointStage === "source";
      const resumingSemantic = checkpointStage === "semantic" && Boolean(checkpoint?.snapshot && checkpoint.checkpoint.parsed && checkpoint.checkpoint.lsp_results);
      await this.recordAnalysisPhase(job, fence, "fetching_source", resumingStatic || resumingSemantic ? "reused" : "running", {
        stage: resumingStatic || resumingSemantic ? "scanning" : "fetching",
        startedAt: started,
        clearError: true,
      });
      signal.throwIfAborted();
      const update = job.repository_update_id
        ? await this.store.loadRepositoryUpdateForProject(project.project_id)
        : null;
      if (update && update.update_id === job.repository_update_id && update.analysis_config_digest !== analysisConfigDigest) {
        throw new Error("analysis_configuration_changed");
      }
      const targetCommitSha = update?.update_id === job.repository_update_id ? update?.target_commit_sha : null;
      const fetched = checkpoint?.checkpoint.fetched
        ? checkpoint.checkpoint.fetched
        : await fetchPublicGithubSource(
          project.source.value,
          temporary,
          config.githubClientId,
          config.githubClientSecret,
          config.githubGatewayUrl && config.githubGatewaySharedSecret
            ? { baseUrl: config.githubGatewayUrl, sharedSecret: config.githubGatewaySharedSecret }
            : null,
          signal,
          targetCommitSha,
          startResearch,
        );
      if (checkpoint?.checkpoint.fetched) await startResearch(fetched);
      signal.throwIfAborted();
      if (targetCommitSha && fetched.commitSha.toLowerCase() !== targetCommitSha.toLowerCase()) throw new Error("github_target_commit_mismatch");
      const snapshotId = "snap:repo:github:" + fetched.owner + "/" + fetched.repo
        + ":" + fetched.commitSha + ":"
        + createHash("sha256").update([
          fetched.files.join("\n"),
          ANALYZER_BUNDLE_VERSION,
          analysisConfigDigest,
        ].join("\n")).digest("hex").slice(0, 16);
      const repository = fetched.owner + "/" + fetched.repo;
      const publicKey = canonicalPublicSnapshotKey(repository, fetched.commitSha, ANALYZER_BUNDLE_VERSION, analysisConfigDigest);
      if (!checkpoint || checkpoint.checkpoint.snapshot_id !== snapshotId) {
        await this.store.saveAnalysisCheckpoint(project.project_id, {
          schema_version: 1,
          analysis_config_digest: analysisConfigDigest,
          analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
          stage: "source",
          source_root: temporary,
          fetched,
          snapshot_id: snapshotId,
          public_key: publicKey,
          repository,
          commit_sha: fetched.commitSha,
        } satisfies AnalysisCheckpoint, null);
        checkpointPersisted = true;
      }
      await this.recordAnalysisPhase(job, fence, "fetching_source", resumingStatic || resumingSemantic ? "reused" : "completed");
      await this.recordAnalysisPhase(job, fence, "comparing_versions", "running");
      const existing = await this.store.loadPublicSnapshot(publicKey);
      if (!(await refreshLease())) throw new Error("analysis_lease_lost");
      if (existing && String(existing.metadata.analysis_snapshot_id ?? "") === snapshotId) {
        await this.recordAnalysisPhase(job, fence, "comparing_versions", "completed", { strategy: "reuse" });
        await this.recordAnalysisPhase(job, fence, "reusing_snapshot", "completed", { strategy: "reuse" });
        await this.completeJobWithSnapshot({
          job: runningJob,
          worker,
          projectId: project.project_id,
          ownerId: project.owner_id,
          commitSha: fetched.commitSha,
          publicKey,
          snapshot: existing.view,
          readyLanguage: existing.metadata.language_overlay_version
            ? null
            : normalizeDisplayLanguage(project.display_language),
          redirects: [],
          fence,
        });
        await this.store.clearAnalysisCheckpoint(project.project_id).catch(() => undefined);
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      const previous = await this.store.loadLatestPublicSnapshot({
        repository,
        analyzerBundleVersion: ANALYZER_BUNDLE_VERSION,
        analysisConfigDigest,
        excludeCommitSha: fetched.commitSha,
      });
      const previousCache = readAnalysisCache(previous?.analysis.analysis_cache);
      const previousFactGraph = asFactGraph(previous?.analysis.fact_graph);
      const previousSnapshotId = typeof previous?.metadata.analysis_snapshot_id === "string"
        ? previous.metadata.analysis_snapshot_id
        : null;
      const plan = resumingSemantic && checkpoint?.checkpoint.plan
        ? checkpoint.checkpoint.plan
        : previousCache && previousFactGraph && previousSnapshotId
          ? buildIncrementalPlan({
              parentSnapshotId: previousSnapshotId,
              previousCache,
              previousFactGraph,
              currentManifest: fetched.manifest,
            })
          : buildFullPlan(fetched.manifest);
      const analysisKind = plan.mode === "incremental" ? "incremental_analysis" : "full_analysis";
      await this.recordAnalysisPhase(job, fence, "comparing_versions", "completed", { strategy: plan.mode });
      let parsed: ParsedFile[];
      let lspResults: LspRunResult[];
      let structuralSnapshot: BuiltSnapshot;
      if (resumingSemantic && checkpoint?.snapshot && checkpoint.checkpoint.parsed && checkpoint.checkpoint.lsp_results) {
        for (const kind of ["parsing_source", "resolving_relations", "building_fact_graph"] as const) {
          await this.recordAnalysisPhase(job, fence, kind, "reused");
        }
        parsed = checkpoint.checkpoint.parsed;
        lspResults = checkpoint.checkpoint.lsp_results;
        structuralSnapshot = checkpoint.checkpoint.snapshot_id === snapshotId
          ? checkpoint.snapshot as unknown as BuiltSnapshot
          : buildSnapshot({ snapshotId, repository, commitSha: fetched.commitSha, files: parsed,
              sourceRoot: temporary, lspResults, research: fetched.research });
      } else {
        await this.recordAnalysisPhase(job, fence, analysisKind, "running", {
          stage: "scanning",
          strategy: plan.mode,
        });
        await this.store.updateProject(project.project_id, project.owner_id, (row) => {
          row.source.commit_sha = fetched.commitSha;
        }, fence);
        await this.recordAnalysisPhase(job, fence, "parsing_source", "running");
        parsed = await this.analyzeWithTreeSitter(
          fetched.manifest,
          temporary,
          previousCache,
          plan,
          signal,
        );
        await this.recordAnalysisPhase(job, fence, "parsing_source", "completed");
        await this.recordAnalysisPhase(job, fence, "resolving_relations", "running");
        const { bindTypeScriptRelations } = await import("./typescript-relations.js");
        parsed = await bindTypeScriptRelations(parsed, temporary, signal);
        lspResults = await this.analyzeWithLsp(
          parsed,
          temporary,
          previousCache,
          plan,
          signal,
        );
        await this.recordAnalysisPhase(job, fence, "resolving_relations", "completed");
        await this.recordAnalysisPhase(job, fence, "building_fact_graph", "running");
        structuralSnapshot = buildSnapshot({
          snapshotId,
          repository,
          commitSha: fetched.commitSha,
          files: parsed,
          sourceRoot: temporary,
          lspResults,
          research: fetched.research,
        });
        await this.recordAnalysisPhase(job, fence, "building_fact_graph", "completed");
      }
      if (!resumingSemantic || checkpoint?.checkpoint.snapshot_id !== snapshotId) {
        await this.store.saveAnalysisCheckpoint(project.project_id, {
          schema_version: 1,
          analysis_config_digest: analysisConfigDigest,
          analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
          stage: "semantic",
          source_root: temporary,
          fetched,
          snapshot_id: snapshotId,
          public_key: publicKey,
          repository,
          commit_sha: fetched.commitSha,
          plan,
          parsed,
          lsp_results: lspResults,
          previous_fact_graph: previousFactGraph,
        } satisfies AnalysisCheckpoint, structuralSnapshot);
        checkpointPersisted = true;
      }
      signal.throwIfAborted();
      await this.recordAnalysisPhase(job, fence, analysisKind, "completed", { strategy: plan.mode });
      if (this.store.kind === "postgres") {
        const sourceStarted = performance.now();
        const sourceSignal = AbortSignal.any([signal, backgroundController.signal]);
        sourcePreparation = trackAnalysisStage("preparing_source", semanticBatchContext,
          () => this.store.preparePublicSnapshotSource({ publicKey, snapshotId, sourceRoot: temporary, fence, signal: sourceSignal }),
          { signal: sourceSignal })
          .catch(error => {
            sourcePreparationFailure = error instanceof Error ? error : new Error("source_preparation_failed");
            backgroundController.abort(sourcePreparationFailure);
            throw sourcePreparationFailure;
          })
          .finally(() => { sourcePreparationMs = performance.now() - sourceStarted; });
        void sourcePreparation.catch(() => undefined);
      }
      await this.updateAnalysisProjects(job, fence, row => { row.analysis.stage = "interpreting"; });
      const displayLanguage = projectDisplayLanguage(project);
      let semanticProvider = null as ReturnType<typeof resolveAnalysisProvider>;
      let semantic: SemanticEnrichment = {
        snapshot: structuralSnapshot,
        stopReason: "provider_unavailable",
        workerRuns: [],
      };
      let executionBudget: Awaited<ReturnType<typeof createAnalysisExecutionBudget>> | undefined;
      try {
        semanticProvider = execution.provider;
        if (semanticProvider && execution.runtime) {
          backgroundController.signal.throwIfAborted();
          executionBudget = await createAnalysisExecutionBudget({ store: this.store, fence,
            signal: AbortSignal.any([signal, backgroundController.signal]) });
          semantic = await enrichSnapshotSafely(
            structuralSnapshot,
            { ...execution.runtime,
              providerGate: this.providerGateFactory?.(semanticProvider, 'analysis'),
              providerBudget: this.providerBudget,
              ownerId: REPOSITORY_ANALYSIS_OWNER_ID,
              attribution: { business: "analysis", payer: "platform", agentRole: "repository-analysis", connectionId: semanticProvider.connectionId, configVersion: config.adminConfigVersion, taskId: job.job_id },
              beforeWorkerRequest: executionBudget.beforeRequest,
            },
            executionBudget.signal,
            enrichSnapshotWithPi,
            displayLanguage,
            semanticBatchContext,
            webResearch,
            initialWebResearch,
          );
          executionBudget.signal.throwIfAborted();
        }
      } catch (error) {
        if (sourcePreparationFailure) throw sourcePreparationFailure;
        if (signal.aborted || isAnalysisLeaseLost(error)) throw error;
        if (isAnalysisLeaseLost(executionBudget?.signal.reason)) throw executionBudget!.signal.reason;
        semantic = {
          snapshot: structuralSnapshot,
          stopReason: `semantic_${semanticFailureCode(error)}`,
          workerRuns: [],
        };
      } finally {
        executionBudget?.dispose();
      }
      const semanticErrorCode = semanticTerminalFailureCode(semantic.stopReason);
      if (semanticErrorCode) {
        const failedAt = nowIso();
        const semanticError = semanticErrorCode;
        await this.store.saveTrace("analysis-semantic-" + job.job_id, {
          trace_id: "analysis-semantic-" + job.job_id,
          project_id: project.project_id,
          snapshot_id: snapshotId,
          worker: "semantic-snapshot",
          worker_runs: semantic.workerRuns,
          models_by_role: execution.modelsByRole,
          provider: semanticProvider?.provider ?? null,
          model: semanticProvider?.model ?? null,
          stop_reason: semantic.stopReason,
          semantic_error_code: semanticErrorCode,
          status: "failed",
          component_count: structuralSnapshot.graph.nodes.length,
          value_point_count: 0,
          semantic_batches: await this.store.listSemanticBatches(job.job_id),
        }, fence);
        // The outer handler owns bounded backoff and the durable checkpoint.
        // Re-enter the same job so completed semantic batches can be replayed.
        if (semanticErrorCode && semanticErrorCode !== "provider_unavailable" && isRetryableAnalysisError(semanticErrorCode)) throw new Error(semanticErrorCode);
        if (runningJob.repository_update_id) {
          await this.store.failRepositoryUpdate(runningJob.repository_update_id, semanticError, fence);
        } else {
          await this.store.updateProject(project.project_id, project.owner_id, (row) => {
            recordAnalysisProgress(row.analysis, "interpreting", "failed", failedAt);
            recordAnalysisProgress(row.analysis, "failed", "failed", failedAt);
            row.analysis.stage = "failed";
            row.analysis.error = semanticError;
            row.analysis.completed_at = failedAt;
          }, fence);
          await this.store.finishAnalysisJob({
            ...runningJob,
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: failedAt,
            updated_at: failedAt,
            completed_at: failedAt,
            error: semanticError,
            error_code: semanticErrorCode,
          }, worker, runningJob.attempt);
        }
        return;
      }
      if (!(await refreshLease())) throw new Error("analysis_lease_lost");
      signal.throwIfAborted();
      const redirects = revisionRedirects({
        repository,
        fromPublicKey: typeof previous?.metadata.public_snapshot_key === "string"
          ? previous.metadata.public_snapshot_key
          : null,
        toPublicKey: publicKey,
        plan,
      });
      // The provider result is the boundary between expensive LLM work and
      // deterministic assembly. Persist it before provenance/validation so a
      // worker restart never repeats a completed provider batch.
      const sourceWaitStarted = performance.now();
      const preparedSource = await sourcePreparation ?? undefined;
      const sourceWaitMs = performance.now() - sourceWaitStarted;
      await this.recordAnalysisPhase(job, fence, "validating_analysis", "running");
      await this.store.saveAnalysisCheckpoint(project.project_id, {
        schema_version: 1,
        analysis_config_digest: analysisConfigDigest,
        analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
        stage: "assembly",
        prepared_source: preparedSource,
        source_root: temporary,
        fetched,
        snapshot_id: snapshotId,
        public_key: publicKey,
        repository,
        commit_sha: fetched.commitSha,
        plan,
        parsed,
        lsp_results: lspResults,
        display_language: displayLanguage,
        provenance_applied: false,
        previous_fact_graph: previousFactGraph,
        redirects,
      } satisfies AnalysisCheckpoint, semantic.snapshot);
      checkpointPersisted = true;
      const localizedSnapshot = applyIncrementalProvenance({
        snapshot: semantic.snapshot,
        previousFactGraph,
        plan,
        currentParsedFiles: parsed,
      });
      // The pre-provenance assembly checkpoint is intentionally the only full
      // snapshot checkpoint. Provenance is deterministic and cheap to replay,
      // while persisting a second localized copy can exceed V8's string limit
      // and doubles the peak memory/disk pressure for large repositories.
      const languageOverlay = extractSnapshotLanguageOverlay(localizedSnapshot, displayLanguage);
      const overlayStatus = snapshotMatchesDisplayLanguage(localizedSnapshot, displayLanguage)
        ? "ready"
        : "degraded";
      const baseSnapshot = stripSnapshotLanguage(localizedSnapshot);
      const validatedSnapshot = assertValidEvidenceSnapshot(baseSnapshot);
      const { fact_graph: factGraph, source_root: _sourceRoot, ...view } = validatedSnapshot;
      await this.recordAnalysisPhase(job, fence, "validating_analysis", "completed");
      await this.recordAnalysisPhase(job, fence, "publishing_analysis", "running");
      const publicationTimings = await this.store.savePublicSnapshot({
        publicKey,
        repository,
        commitSha: fetched.commitSha,
        snapshotId,
        sourceRoot: temporary,
        preparedSource,
        view,
        analysis: {
          snapshot_id: snapshotId,
          fact_graph: factGraph,
          semantic_graph: view.graph,
          value_points: view.value_points,
          languages: view.languages,
          source_reports: view.source_reports,
          analysis_cache: createAnalysisCache({
            manifest: fetched.manifest,
            parsedFiles: parsed,
            lspResults,
          }),
          incremental: incrementalSummary(plan),
          active_fact_fingerprint: localizedSnapshot.active_fact_fingerprint,
        },
        analyzerBundleVersion: ANALYZER_BUNDLE_VERSION,
        analysisConfigDigest,
        languageOverlayVersion: SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
        fence,
      });
      await this.store.saveSnapshotLanguageOverlay({
        publicKey,
        language: displayLanguage,
        status: overlayStatus,
        payload: languageOverlay,
        error: overlayStatus === "degraded" ? "language_mismatch_after_retry" : null,
        fence,
      });
      await this.store.saveTrace("analysis-semantic-" + job.job_id, {
        trace_id: "analysis-semantic-" + job.job_id,
        project_id: project.project_id,
        snapshot_id: snapshotId,
        worker: "semantic-snapshot",
        worker_runs: semantic.workerRuns,
        models_by_role: execution.modelsByRole,
        publication_timings: { ...publicationTimings, source_preparation_ms: sourcePreparationMs, source_wait_ms: sourceWaitMs },
        provider: semanticProvider?.provider ?? null,
        model: semanticProvider?.model ?? null,
        stop_reason: semantic.stopReason,
        semantic_error_code: semantic.stopReason.startsWith("semantic_")
          ? semantic.stopReason.slice("semantic_".length)
          : null,
        semantic_mode: view.graph.semantic_mode,
        component_count: view.graph.nodes.filter(node => (node.entity_kind ?? "component") === "component").length,
        value_point_count: view.value_points.length,
        incremental: incrementalSummary(plan),
        active_fact_fingerprint: localizedSnapshot.active_fact_fingerprint,
        semantic_batches: await this.store.listSemanticBatches(job.job_id),
        languages: view.languages.map((language) => ({
          language: language.language,
          quality_tier: language.quality_tier,
          reason_codes: language.reason_codes,
        })),
      }, fence);
      await this.completeJobWithSnapshot({
        job: runningJob,
        worker,
        projectId: project.project_id,
        ownerId: project.owner_id,
        commitSha: fetched.commitSha,
        publicKey,
        snapshot: view,
        readyLanguage: displayLanguage,
        redirects,
        fence,
      });
      await this.store.clearAnalysisCheckpoint(project.project_id).catch(() => undefined);
      if (this.store.kind === "postgres") {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (error) {
      backgroundController.abort();
      await Promise.allSettled([initialWebResearch, sourcePreparation]);
      if (!checkpointPersisted) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "analysis_failed";
      if (signal.aborted || isAnalysisLeaseLost(error)) {
        if (signal.aborted
          && signal.reason instanceof Error
          && signal.reason.message === "analysis_cancelled") {
          await this.store.cancelSemanticBatches(job.job_id, "analysis_cancelled").catch(() => undefined);
        }
        return;
      }
      const requeued = await this.requeueAfterTransientFailure(runningJob, worker, message, async () => {
        await this.store.updateProject(project.project_id, project.owner_id, (row) => {
          row.analysis.completed_at = null;
          row.analysis.error = message;
        }, fence);
      });
      if (requeued) {
        // Project state was recorded while the old attempt still owned the lease.
      } else if (runningJob.repository_update_id) {
        await this.store.failRepositoryUpdate(runningJob.repository_update_id, message, fence);
      } else {
        await this.store.updateProject(project.project_id, project.owner_id, (row) => {
          const completedAt = nowIso();
          recordAnalysisProgress(row.analysis, "failed", "failed", completedAt);
          row.analysis.stage = "failed";
          row.analysis.error = message;
          row.analysis.completed_at = completedAt;
        }, fence);
        await this.store.finishAnalysisJob({ ...runningJob, status: "failed", lease_owner: null, lease_expires_at: null, heartbeat_at: nowIso(), updated_at: nowIso(), completed_at: nowIso(), error: message, error_code: message.startsWith("github_") ? message : "analysis_failed" }, worker, runningJob.attempt);
      }
    } finally {
      backgroundController.abort();
      await Promise.allSettled([initialWebResearch, sourcePreparation]);
      clearInterval(heartbeat);
    }
  }

  private async analyzeWithTreeSitter(
    manifest: SourceFileManifest[],
    sourceRoot: string,
    previousCache: AnalysisCache | null,
    plan: IncrementalPlan,
    signal?: AbortSignal,
  ): Promise<ParsedFile[]> {
    const targets = new Set(plan.recomputePaths);
    const recomputed: ParsedFile[] = [];
    for (const file of manifest) {
      if (!targets.has(file.path)) continue;
      signal?.throwIfAborted();
      try {
        recomputed.push(await this.parser.analyzeFile(sourceRoot, file.path, signal));
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted) throw error;
        recomputed.push({
          path: file.path,
          language: languageForPath(file.path)?.id ?? "unknown",
          bytes: file.bytes,
          digest: file.digest,
          symbols: [],
          imports: [],
          calls: [],
          parseError: error instanceof Error ? `file_analysis_failed:${error.name}` : "file_analysis_failed",
        });
      }
    }
    signal?.throwIfAborted();
    return mergeParsedFiles({
      previous: previousCache?.parsed_files ?? [],
      recomputed,
      currentManifest: manifest,
      plan,
    });
  }

  private async analyzeWithLsp(
    files: ParsedFile[],
    sourceRoot: string,
    previousCache: AnalysisCache | null,
    plan: IncrementalPlan,
    signal?: AbortSignal,
  ): Promise<LspRunResult[]> {
    const languages = [...new Set(files
      .map((file) => file.language)
      .filter((language) => language !== "unknown"))];
    const results: LspRunResult[] = [];
    const invalidatedPaths = new Set(plan.affectedPaths);
    const previousByLanguage = new Map(
      (previousCache?.lsp_results ?? []).map((result) => [result.language, result]),
    );
    for (const language of languages) {
      signal?.throwIfAborted();
      const languageFiles = files.filter((file) => file.language === language);
      const targetFiles = lspTargetFiles(files, language, plan);
      const fresh = targetFiles.length
        ? this.lspRunner
          ? await this.lspRunner.analyze({
              language,
              files: targetFiles,
              workspaceFiles: languageFiles,
              sourceRoot,
              runtimeRoot: join(this.config.dataDir, "lsp-runtime"),
              signal,
            })
          : unavailableLspResult(language, "sandbox_attestation_unavailable", "tree_sitter_only")
        : null;
      signal?.throwIfAborted();
      results.push(mergeLspResult({
        language,
        previous: plan.mode === "incremental" ? previousByLanguage.get(language) ?? null : null,
        fresh,
        invalidatedPaths,
        currentPaths: new Set(languageFiles.map((file) => file.path)),
      }));
    }
    signal?.throwIfAborted();
    return results;
  }

  private async completeProject(
    projectId: string,
    ownerId: string,
    commitSha: string,
    publicKey: string,
    snapshot: Record<string, unknown>,
    fence: AnalysisLeaseFence,
  ): Promise<void> {
    const summary = snapshot.summary as Record<string, unknown>;
    const languages = Array.isArray(snapshot.languages)
      ? snapshot.languages as { language: string }[]
      : [];
    const completedAt = nowIso();
    await this.store.updateProject(projectId, ownerId, (row) => {
      recordAnalysisProgress(row.analysis, "interpreting", "completed", completedAt);
      recordAnalysisProgress(row.analysis, "completed", "completed", completedAt);
      row.analysis.stage = "done";
      row.analysis.snapshot_id = String(snapshot.snapshot_id ?? "");
      row.analysis.file_count = Number(summary.file_count ?? 0);
      row.analysis.symbol_count = Number(summary.symbol_count ?? 0);
      row.analysis.call_count = Number(summary.call_count ?? 0);
      row.analysis.languages = languages.map((item) => item.language);
      row.analysis.error = null;
      row.analysis.canonical_snapshot_key = publicKey;
      row.analysis.completed_at = completedAt;
      row.source.commit_sha = commitSha;
    }, fence);
  }

  private async resumeAssemblyFromCheckpoint(input: {
    job: AnalysisJob;
    project: Project;
    fence: AnalysisLeaseFence;
    signal: AbortSignal;
    checkpoint: AnalysisCheckpoint;
    snapshot: BuiltSnapshot;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const analysisConfigDigest = input.checkpoint.analysis_config_digest;
    if (!analysisConfigDigest) throw new Error("analysis_checkpoint_identity_missing");
    const analyzerBundleVersion = input.checkpoint.analyzer_bundle_version ?? ANALYZER_BUNDLE_VERSION;
    if (input.checkpoint.public_key !== canonicalPublicSnapshotKey(input.checkpoint.repository, input.checkpoint.commit_sha, analyzerBundleVersion, analysisConfigDigest)) {
      throw new Error("analysis_checkpoint_identity_mismatch");
    }
    if (input.job.repository_update_id) {
      const update = await this.store.loadRepositoryUpdateForProject(input.project.project_id);
      if (update?.update_id !== input.job.repository_update_id || update.analysis_config_digest !== analysisConfigDigest) {
        throw new Error("analysis_configuration_changed");
      }
    }
    if (!input.checkpoint.prepared_source && !(await access(input.checkpoint.source_root).then(() => true).catch(() => false))) {
      throw new Error("analysis_checkpoint_source_missing");
    }
    await this.recordAnalysisPhase(input.job, input.fence, "validating_analysis", "running");
    const displayLanguage = input.checkpoint.display_language ?? normalizeDisplayLanguage(input.project.display_language);
    const localizedSnapshot = input.checkpoint.provenance_applied
      ? input.snapshot
      : applyIncrementalProvenance({
          snapshot: input.snapshot,
          previousFactGraph: input.checkpoint.previous_fact_graph ?? null,
          plan: input.checkpoint.plan ?? buildFullPlan(input.checkpoint.fetched.manifest),
          currentParsedFiles: input.checkpoint.parsed ?? [],
        });
    const baseSnapshot = stripSnapshotLanguage(localizedSnapshot);
    const validatedSnapshot = assertValidEvidenceSnapshot(baseSnapshot);
    const { fact_graph: factGraph, source_root: _sourceRoot, ...view } = validatedSnapshot;
    await this.recordAnalysisPhase(input.job, input.fence, "validating_analysis", "completed");
    await this.recordAnalysisPhase(input.job, input.fence, "publishing_analysis", "running");
    const publicationTimings = await this.store.savePublicSnapshot({
      publicKey: input.checkpoint.public_key,
      repository: input.checkpoint.repository,
      commitSha: input.checkpoint.commit_sha,
      snapshotId: input.checkpoint.snapshot_id,
      sourceRoot: input.checkpoint.source_root,
      preparedSource: input.checkpoint.prepared_source,
      view,
      analysis: {
        snapshot_id: input.checkpoint.snapshot_id,
        fact_graph: factGraph,
        semantic_graph: view.graph,
        value_points: view.value_points,
        languages: view.languages,
        source_reports: view.source_reports,
        analysis_cache: input.checkpoint.parsed && input.checkpoint.lsp_results && input.checkpoint.plan
          ? createAnalysisCache({
              manifest: input.checkpoint.fetched.manifest,
              parsedFiles: input.checkpoint.parsed,
              lspResults: input.checkpoint.lsp_results,
            })
          : undefined,
        incremental: input.checkpoint.plan ? incrementalSummary(input.checkpoint.plan) : undefined,
        active_fact_fingerprint: localizedSnapshot.active_fact_fingerprint,
      },
      analyzerBundleVersion,
      analysisConfigDigest,
      languageOverlayVersion: SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
      fence: input.fence,
    });
    await this.store.saveTrace("analysis-publication-" + input.job.job_id, {
      trace_id: "analysis-publication-" + input.job.job_id, job_id: input.job.job_id, job_attempt: input.job.attempt,
      project_id: input.project.project_id, snapshot_id: input.checkpoint.snapshot_id,
      worker: "snapshot-publication", resumed: true, publication_timings: publicationTimings,
    }, input.fence);
    const languageOverlay = extractSnapshotLanguageOverlay(localizedSnapshot, displayLanguage);
    const overlayStatus = snapshotMatchesDisplayLanguage(localizedSnapshot, displayLanguage) ? "ready" : "degraded";
    await this.store.saveSnapshotLanguageOverlay({
      publicKey: input.checkpoint.public_key,
      language: displayLanguage,
      status: overlayStatus,
      payload: languageOverlay,
      error: overlayStatus === "degraded" ? "language_mismatch_after_retry" : null,
      fence: input.fence,
    });
    await this.completeJobWithSnapshot({
      job: input.job,
      worker: input.job.lease_owner as string,
      projectId: input.project.project_id,
      ownerId: input.project.owner_id,
      commitSha: input.checkpoint.commit_sha,
      publicKey: input.checkpoint.public_key,
      snapshot: view,
      readyLanguage: displayLanguage,
      redirects: input.checkpoint.redirects ?? [],
      fence: input.fence,
    });
    await this.store.clearAnalysisCheckpoint(input.project.project_id).catch(() => undefined);
    await rm(input.checkpoint.source_root, { recursive: true, force: true }).catch(() => undefined);
  }

  private async completeJobWithSnapshot(input: {
    job: AnalysisJob;
    worker: string;
    projectId: string;
    ownerId: string;
    commitSha: string;
    publicKey: string;
    snapshot: Record<string, unknown>;
    readyLanguage: string | null;
    redirects: RevisionRedirect[];
    fence: AnalysisLeaseFence;
  }): Promise<void> {
    const summary = input.snapshot.summary as Record<string, unknown>;
    const languages = Array.isArray(input.snapshot.languages)
      ? input.snapshot.languages as { language: string }[]
      : [];
    const completedAt = nowIso();
    if (input.job.repository_update_id) {
      await this.store.publishRepositoryUpdate({
        updateId: input.job.repository_update_id,
        publicKey: input.publicKey,
        commitSha: input.commitSha,
        snapshotId: String(input.snapshot.snapshot_id ?? ""),
        fileCount: Number(summary.file_count ?? 0),
        symbolCount: Number(summary.symbol_count ?? 0),
        callCount: Number(summary.call_count ?? 0),
        languages: languages.map((item) => item.language),
        completedAt,
        readyLanguage: input.readyLanguage,
        redirects: input.redirects,
        fence: input.fence,
      });
      return;
    }
    await this.completeProject(
      input.projectId,
      input.ownerId,
      input.commitSha,
      input.publicKey,
      input.snapshot,
      input.fence,
    );
    await this.store.finishAnalysisJob({
      ...input.job,
      status: "succeeded",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: completedAt,
      updated_at: completedAt,
      completed_at: completedAt,
      error: null,
      error_code: null,
    }, input.worker, input.job.attempt);
  }

  private async processLanguageOverlay(
    job: AnalysisJob,
    project: Awaited<ReturnType<ProductStore["loadProject"]>> & {},
    refreshLease: () => Promise<boolean>,
    fence: AnalysisLeaseFence,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const publicKey = project.analysis.canonical_snapshot_key;
    if (!publicKey) throw new Error("language_overlay_snapshot_missing");
    const targetLanguage = normalizeDisplayLanguage(project.display_language);
    const overlays = await this.store.listSnapshotLanguageOverlays(publicKey);
    signal?.throwIfAborted();
    const source = overlays
      .filter((row) => row.status === "ready" || row.status === "degraded")
      .map((row) => asSnapshotLanguageOverlayPayload(row.payload))
      .find((row): row is NonNullable<typeof row> => Boolean(row));
    if (!source) throw new Error("language_overlay_source_missing");
    const config = await runtimeConfig(this.config, this.store, job.created_at, job.config_version);
    const provider = resolveAgentProvider(config, "snapshot-language-overlay", resolveAnalysisProvider(config));
    signal?.throwIfAborted();
    if (!provider) throw new Error("language_overlay_provider_unavailable");
    await this.store.updateProject(project.project_id, project.owner_id, (row) => {
      row.analysis.stage = "interpreting";
      row.analysis.error = null;
      row.analysis.completed_at = null;
    }, fence);
    const budget = await createAnalysisExecutionBudget({ store: this.store, fence, signal: signal ?? new AbortController().signal });
    let generated: Awaited<ReturnType<typeof generateSnapshotLanguageOverlay>>;
    try {
      generated = await generateSnapshotLanguageOverlay({
        source,
        targetLanguage,
        modelRuntime: { ...createModelRuntime(provider, {
          providerGate: this.providerGateFactory?.(provider, 'analysis'),
          providerBudget: this.providerBudget,
          ownerId: REPOSITORY_ANALYSIS_OWNER_ID,
        }), beforeWorkerRequest: budget.beforeRequest },
        batchContext: { ...this.progressContext(job, fence), snapshotId: project.analysis.snapshot_id ?? publicKey },
        signal: budget.signal,
      });
      budget.signal.throwIfAborted();
    } catch (error) {
      if (signal?.aborted || isAnalysisLeaseLost(error)) throw error;
      if (isAnalysisLeaseLost(budget.signal.reason)) throw budget.signal.reason;
      const reason = workerFailureCode(error) ?? (error instanceof Error && error.message.startsWith("language_overlay_") ? error.message : "worker_internal_error");
      await this.store.saveTrace(`analysis-language-overlay-${job.job_id}`, {
        trace_id: `analysis-language-overlay-${job.job_id}`, project_id: project.project_id,
        snapshot_id: project.analysis.snapshot_id, public_snapshot_key: publicKey,
        worker: "snapshot-language-overlay", status: "failed", stop_reason: reason,
        display_language: targetLanguage, source_language: source.language,
        provider: provider.provider, model: provider.model,
        semantic_batches: await this.store.listSemanticBatches(job.job_id).catch(() => []),
      }, fence).catch(() => undefined);
      throw new Error(reason);
    } finally { budget.dispose(); }
    signal?.throwIfAborted();
    if (!(await refreshLease())) throw new Error("analysis_lease_lost");
    const completedAt = nowIso();
    await this.store.saveTrace(`analysis-language-overlay-${job.job_id}`, {
      trace_id: `analysis-language-overlay-${job.job_id}`,
      project_id: project.project_id,
      snapshot_id: project.analysis.snapshot_id,
      public_snapshot_key: publicKey,
      worker: "snapshot-language-overlay",
      display_language: targetLanguage,
      source_language: source.language,
      status: generated.degraded ? "degraded" : "ready",
      validation_errors: generated.errors,
      stop_reasons: generated.stopReasons,
      semantic_batches: await this.store.listSemanticBatches(job.job_id),
      provider: provider.provider,
      model: provider.model,
    }, fence);
    await this.recordAnalysisPhase(job, fence, "publishing_translation", "running");
    await this.store.publishSnapshotLanguageOverlay({
      publicKey,
      language: targetLanguage,
      status: generated.degraded ? "degraded" : "ready",
      payload: generated.payload,
      completedAt,
      error: generated.errors.length ? generated.errors.join("; ").slice(0, 2_000) : null,
      fence,
    });
  }
}

function asFactGraph(value: unknown): NonNullable<EvidenceSnapshot["fact_graph"]> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.nodes) || !Array.isArray(row.edges)) return null;
  return row as unknown as NonNullable<EvidenceSnapshot["fact_graph"]>;
}

function revisionRedirects(input: {
  repository: string;
  fromPublicKey: string | null;
  toPublicKey: string;
  plan: IncrementalPlan;
}): RevisionRedirect[] {
  if (!input.fromPublicKey || input.fromPublicKey === input.toPublicKey || input.plan.mode !== "incremental") return [];
  const createdAt = nowIso();
  const unchanged = input.plan.reusedPaths.map((path): RevisionRedirect => ({
    repository_identity: input.repository.toLowerCase(),
    from_public_snapshot_key: input.fromPublicKey as string,
    to_public_snapshot_key: input.toPublicKey,
    old_path: path,
    old_stable_id: null,
    kind: "unchanged",
    candidates: [{ path, stable_id: null, confidence: 1 }],
    created_at: createdAt,
  }));
  const changed = input.plan.changes.flatMap((change): RevisionRedirect[] => {
    if (change.kind === "added") return [];
    if (change.kind === "renamed" && change.renamed_from) {
      return [{
        repository_identity: input.repository.toLowerCase(),
        from_public_snapshot_key: input.fromPublicKey as string,
        to_public_snapshot_key: input.toPublicKey,
        old_path: change.renamed_from,
        old_stable_id: null,
        kind: "renamed",
        candidates: [{ path: change.path, stable_id: null, confidence: 1 }],
        created_at: createdAt,
      }];
    }
    if (change.kind === "deleted") {
      return [{
        repository_identity: input.repository.toLowerCase(),
        from_public_snapshot_key: input.fromPublicKey as string,
        to_public_snapshot_key: input.toPublicKey,
        old_path: change.path,
        old_stable_id: null,
        kind: "deleted",
        candidates: [],
        created_at: createdAt,
      }];
    }
    return [{
      repository_identity: input.repository.toLowerCase(),
      from_public_snapshot_key: input.fromPublicKey as string,
      to_public_snapshot_key: input.toPublicKey,
      old_path: change.path,
      old_stable_id: null,
      kind: "unchanged",
      candidates: [{ path: change.path, stable_id: null, confidence: 1 }],
      created_at: createdAt,
    }];
  });
  return [...unchanged, ...changed];
}
