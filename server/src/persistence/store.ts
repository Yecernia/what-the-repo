import type {
  LearnerProfile,
  Project,
  ProviderSettings,
} from "../domain/conversation.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import type { SnapshotEvidence } from "../domain/snapshot.js";
import type { ConversationSummary } from "../domain/conversation-summary.js";
import type { SnapshotEvidenceRequest } from "./snapshot-evidence.js";
import type { StoredSourceSnapshot } from "./snapshot-object-store.js";
import type { PreparedAnalysisCache } from './analysis-payload.js';
import type {
  EvolutionFeedbackRequest,
  EvolutionFeedbackRequestStatus,
} from "../domain/evolution.js";
import type {
  RepositoryHead,
  GuestRetentionCandidate,
  OwnerLifecycle,
  OwnerMergeSummary,
  PublicSnapshotMetadata,
  RepositoryMigrationAction,
  RepositoryUpdate,
  RevisionLink,
  RevisionRedirect,
  SnapshotLanguageOverlay,
} from "../domain/lifecycle.js";
import type { SnapshotLanguageOverlayPayload } from "../domain/snapshot-language.js";
import type {
  SnapshotQueryInput,
  SnapshotQueryResult,
} from "../domain/snapshot-query.js";

export interface QuotaLimits {
  maxProjects: number;
  maxCreationsPerHour: number;
  maxStorageBytes: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxProjects: 20,
  maxCreationsPerHour: 30,
  maxStorageBytes: 0,
};

export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "quota_exceeded";

  constructor(readonly kind: string, readonly limit: number) {
    super(`owner quota exceeded: ${kind}`);
  }
}

/**
 * Capability carried by an analysis worker when it writes derived data.
 * The storage layer validates it against the current job row before writing.
 */
export interface SessionWriteFence { permitId: string; }

export interface AnalysisLeaseFence {
  jobId: string;
  workerId: string;
  attempt: number;
  /** Optional project identity used to acquire the project fence before the job row. */
  projectId?: string;
}

export class AnalysisLeaseLostError extends Error {
  readonly code = "analysis_lease_lost";

  constructor() {
    super("analysis_lease_lost");
  }
}

/** Elapsed substeps; uploads overlap, so these durations must not be added. */
export type SnapshotPublicationTimings = Record<string, number>;

/** Store user credentials with authenticated encryption; retrieve plaintext only on demand. */
export interface ProviderKeyVault {
  init(): Promise<void>;
  set(ownerId: string, value: string, connectionId?: string): Promise<void>;
  get(ownerId: string, connectionId?: string): Promise<string | null>;
  has(ownerId: string, connectionId?: string): Promise<boolean>;
  clear(ownerId: string, connectionId?: string): Promise<void>;
  masked(ownerId: string, connectionId?: string): Promise<string | null>;
}

export interface PublicSnapshotBundle<T = Record<string, unknown>> {
  metadata: Record<string, unknown>;
  view: T;
  analysis: Record<string, unknown>;
}

export type PublicSnapshotView<T = Record<string, unknown>> = Pick<PublicSnapshotBundle<T>, 'metadata' | 'view'>;

export interface IncrementalSnapshotBase {
  metadata: Record<string, unknown>;
  analysisCache: unknown;
  nodePaths: Array<{ id: string; path: string | null }>;
  factGraphAvailable: boolean;
}

export interface RepositoryIdentityInput {
  repository: string;
  analyzerBundleVersion: string;
  analysisConfigDigest: string;
}

/** Why a background update did not start; recorded for the admin console. */
export type BackgroundDeferReason =
  | 'disabled' | 'unavailable' | 'inactive' | 'interval' | 'suppressed'
  | 'active_update' | 'capacity' | 'budget_off' | 'daily_budget';
export type BackgroundAdmission = 'queued' | 'up_to_date' | `deferred:${BackgroundDeferReason}`;

export interface BackgroundRepositoryCandidate {
  repository: string;
  projectId: string;
  currentPublicSnapshotKey: string;
  currentSnapshotId: string;
  analyzerBundleVersion: string;
  analysisConfigDigest: string;
  currentCommitSha: string;
  publishedAt: string;
  lastRealUseAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  upstreamCommitSha: string | null;
  behindCommits: number | null;
  relation: 'same' | 'ahead' | 'diverged' | 'rewound' | 'unknown';
  lastBackgroundStartedAt: string | null;
  /** When the latest background update failed, or null when it did not. */
  lastBackgroundFailedAt: string | null;
}

/**
 * When a repository may start its next background update: a failed attempt is retried after the shorter
 * failure wait, any other start after the normal interval. Null means it may start now.
 */
export function backgroundUpdateAllowedAt(input: {
  lastStartedAt: string | null; lastFailedAt: string | null;
  minUpdateIntervalHours: number; failureRetryHours: number;
}): number | null {
  if (input.lastFailedAt) return Date.parse(input.lastFailedAt) + input.failureRetryHours * 3600_000;
  if (input.lastStartedAt) return Date.parse(input.lastStartedAt) + input.minUpdateIntervalHours * 3600_000;
  return null;
}

export interface RepositoryUpdatePublication {
  updateId: string;
  publicKey: string;
  commitSha: string;
  snapshotId: string;
  fileCount: number;
  symbolCount: number;
  callCount: number;
  languages: string[];
  completedAt: string;
  readyLanguage: string | null;
  redirects: RevisionRedirect[];
  /** Old pages may keep reading the retired version this long (default 24). */
  snapshotGraceHours?: number;
}

export interface SnapshotLanguageOverlayPublication {
  publicKey: string;
  language: string;
  status: "ready" | "degraded";
  payload: SnapshotLanguageOverlayPayload;
  completedAt: string;
  error?: string | null;
}

export type { AnalysisCheckpointReadOptions, LoadedAnalysisCheckpoint } from './publication-checkpoint.js';
import type { AnalysisCheckpointReadOptions, LoadedAnalysisCheckpoint } from './publication-checkpoint.js';

export interface ProductStore {
  readonly kind: "file" | "postgres";
  readonly root: string;
  readonly keys: ProviderKeyVault;
  init(): Promise<void>;
  close(): Promise<void>;
  checkHealth(): Promise<void>;

  saveProject(project: Project): Promise<void>;
  loadProject(projectId: string, ownerId?: string): Promise<Project | null>;
  listProjects(ownerId: string): Promise<Project[]>;
  updateProject(
    projectId: string,
    ownerId: string,
    mutate: (project: Project) => void,
    fence?: AnalysisLeaseFence,
    sessionFence?: SessionWriteFence,
  ): Promise<Project | null>;
  deleteProject(projectId: string, ownerId: string): Promise<boolean>;
  createProjectWithJob(project: Project, job: AnalysisJob): Promise<void>;
  enqueueAnalysisJob(ownerId: string, projectId: string, job: AnalysisJob): Promise<void>;

  saveSnapshot(projectId: string, payload: unknown): Promise<void>;
  loadSnapshot<T = Record<string, unknown>>(projectId: string, displayLanguage?: string): Promise<T | null>;
  loadConversationSummary(project: Project, displayLanguage?: string): Promise<ConversationSummary | null>;
  snapshotAvailable(project: Project, displayLanguage?: string): Promise<boolean>;
  saveAnalysisResult(projectId: string, payload: unknown): Promise<void>;
  loadAnalysisResult<T = Record<string, unknown>>(projectId: string): Promise<T | null>;
  readStaticFile(projectId: string, snapshotId: string, path: string): Promise<import("./analysis-payload.js").StaticFileFacts | null>;
  /** Persist an analysis-stage checkpoint independently of any published snapshot binding. */
  saveAnalysisCheckpoint(projectId: string, checkpoint: unknown, snapshot: unknown): Promise<void>;
  loadAnalysisCheckpoint<T = Record<string, unknown>>(projectId: string, options?: AnalysisCheckpointReadOptions): Promise<LoadedAnalysisCheckpoint<T> | null>;
  analysisCheckpointInfo(projectId: string): Promise<{ stage: string; bytes: number; sourceBytes: number; staticBytes?: number } | null>;
  clearAnalysisCheckpoint(projectId: string): Promise<void>;
  readPublicSnapshotEvidence(input: SnapshotEvidenceRequest): Promise<SnapshotEvidence[]>;
  queryPublicSnapshot(input: {
    publicKey: string;
    snapshotId: string;
    query: SnapshotQueryInput;
    signal?: AbortSignal;
  }): Promise<SnapshotQueryResult>;
  sourceSnapshotRoot(projectId: string, snapshotId: string): string;
  publicSourceSnapshotRoot(publicKey: string, snapshotId: string): string;
  boundSourceSnapshotRoot(projectId: string, snapshotId: string): Promise<string>;
  listSourceFiles(projectId: string, snapshotId: string): Promise<string[]>;
  readSourceLines(projectId: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }>;
  readPublicSourceLines(publicKey: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }>;
  loadPublicSnapshot<T = Record<string, unknown>>(publicKey: string): Promise<PublicSnapshotBundle<T> | null>;
  loadPublicSnapshotView<T = Record<string, unknown>>(publicKey: string): Promise<PublicSnapshotView<T> | null>;
  loadPublicSnapshotMetadata(publicKey: string): Promise<PublicSnapshotMetadata | null>;
  loadLatestPublicSnapshot<T = Record<string, unknown>>(input: {
    repository: string;
    analyzerBundleVersion: string;
    analysisConfigDigest: string;
    excludeCommitSha?: string;
  }): Promise<PublicSnapshotBundle<T> | null>;
  /** Compiler cache/fact-lineage candidate across semantic configurations.
   * Callers must validate stage cache keys and invalidate fact history when
   * metadata.analysis_config_digest differs from the current execution. */
  loadLatestPublicSnapshotIncrementalBase(input: {
    repository: string;
    analyzerBundleVersion: string;
    analysisConfigDigest: string;
    excludeCommitSha?: string;
  }): Promise<IncrementalSnapshotBase | null>;
  visitPublicSnapshotFactGraph(publicKey: string, visitor: import('./analysis-payload.js').AnalysisFactGraphVisitor): Promise<void>;
  /** False when the snapshot predates compact fact lineage. */
  visitPublicSnapshotFactLineage(publicKey: string, visitor: import('./analysis-payload.js').AnalysisFactLineageVisitor): Promise<boolean>;
  loadPublicSnapshotFactRows(publicKey: string, request: { nodes: readonly number[]; edges: readonly number[] },
    options?: { metrics?: import('./analysis-chunk-codec.js').AnalysisPayloadReadMetrics; signal?: AbortSignal }): Promise<{ nodes: Map<number, unknown>; edges: Map<number, unknown> }>;
  savePublicSnapshot(input: {
    publicKey: string;
    repository: string;
    commitSha: string;
    snapshotId: string;
    sourceRoot?: string;
    preparedSource?: StoredSourceSnapshot;
    preparedAnalysisCache?: PreparedAnalysisCache;
    view: unknown;
    analysis: unknown;
    analyzerBundleVersion?: string;
    analysisConfigDigest?: string;
    languageOverlayVersion?: string | null;
    fence?: AnalysisLeaseFence;
  }): Promise<SnapshotPublicationTimings | void>;
  preparePublicSnapshotSource(input: {
    publicKey: string; snapshotId: string; sourceRoot: string; fence?: AnalysisLeaseFence; signal?: AbortSignal;
  }): Promise<StoredSourceSnapshot | null>;
  preparePublicSnapshotAnalysisCache(input: {
    publicKey: string; snapshotId: string; cache: unknown; fence?: AnalysisLeaseFence;
  }): Promise<PreparedAnalysisCache>;
  loadRepositoryHead(input: RepositoryIdentityInput): Promise<RepositoryHead | null>;
  loadCurrentRepositoryHead(repository: string): Promise<RepositoryHead | null>;
  saveRepositoryHead(head: RepositoryHead): Promise<void>;
  createOrJoinRepositoryUpdate(input: {
    project: Project;
    job: AnalysisJob;
    identity: RepositoryIdentityInput;
    targetCommitSha?: string | null;
    newProject: boolean;
  }): Promise<{ update: RepositoryUpdate; job: AnalysisJob; leader: boolean }>;
  loadRepositoryUpdateForProject(projectId: string): Promise<RepositoryUpdate | null>;
  loadActiveRepositoryUpdate(repository: string): Promise<RepositoryUpdate | null>;
  /** Most recently created update of any status; used for failure display. */
  loadLatestRepositoryUpdate(repository: string): Promise<RepositoryUpdate | null>;
  /** Public key of a readable older version of the project's repository; null for the current binding. */
  historicalPublicKey(projectId: string, snapshotId: string): Promise<string | null>;
  /** Paths and content digests of a published version, or null without a source list. */
  listPublicSourceFiles(publicKey: string): Promise<Array<{ path: string; bytes: number; digest: string }> | null>;
  /**
   * Protects a version from cleanup while one request reads it. Returns null
   * when the version is already outside its grace period or purged.
   */
  acquireSnapshotReadLease(publicKey: string, maxMinutes: number): Promise<string | null>;
  /**
   * When the owner may start another analysis or update under the hourly creation limit, or null while under
   * it. Starting either counts against the same limit.
   */
  ownerCreationRetryAfter(ownerId: string): Promise<string | null>;
  releaseSnapshotReadLease(leaseId: string): Promise<void>;
  touchRepositoryRealUse(repository: string, at: string, minIntervalMinutes: number): Promise<void>;
  listBackgroundRepositoryCandidates(now: string, activeSince: string, limit: number): Promise<BackgroundRepositoryCandidate[]>;
  saveRepositoryFreshness(input: {
    repository: string; baseSnapshotKey: string; upstreamCommitSha: string | null;
    behindCommits: number | null; relation: BackgroundRepositoryCandidate['relation'];
    checkedAt: string; nextCheckAt: string; errorCode: string | null;
    /** Upstream head commit time; omitted keeps the stored time while the head is unchanged. */
    upstreamCommittedAt?: string | null;
  }): Promise<boolean>;
  createBackgroundRepositoryUpdate(input: {
    project: Project; job: AnalysisJob; identity: RepositoryIdentityInput;
    targetCommitSha: string;
    maxActive: number; minUpdateIntervalHours: number; failureRetryHours: number;
    activeWindowDays: number; now: string;
  }): Promise<BackgroundAdmission>;
  /** Records one background scheduler pass; stores without a database keep none. */
  recordBackgroundRun(run: { startedAt: string; finishedAt: string; outcome: unknown; error: string | null }): Promise<void>;
  /** Brings a repository's next upstream check forward to `at`; a later time never delays it. */
  scheduleRepositoryCheck(repository: string, at: string): Promise<void>;
  listRepositoryUpdateProjects(updateId: string): Promise<Project[]>;
  publishRepositoryUpdate(input: RepositoryUpdatePublication & { fence?: AnalysisLeaseFence }): Promise<string[]>;
  failRepositoryUpdate(updateId: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]>;
  loadSnapshotLanguageOverlay(
    publicKey: string,
    language: string,
  ): Promise<SnapshotLanguageOverlay | null>;
  listSnapshotLanguageOverlays(publicKey: string): Promise<SnapshotLanguageOverlay[]>;
  saveSnapshotLanguageOverlay(input: {
    publicKey: string;
    language: string;
    status: SnapshotLanguageOverlay["status"];
    payload: SnapshotLanguageOverlayPayload | null;
    error?: string | null;
    fence?: AnalysisLeaseFence;
  }): Promise<void>;
  createOrJoinSnapshotLanguageOverlay(input: {
    project: Project;
    job: AnalysisJob;
    publicKey: string;
    language: string;
    newProject: boolean;
    systemManaged?: boolean;
  }): Promise<{ job: AnalysisJob; ready: boolean }>;
  publishSnapshotLanguageOverlay(input: SnapshotLanguageOverlayPublication & { fence?: AnalysisLeaseFence }): Promise<string[]>;
  failSnapshotLanguageOverlay(publicKey: string, language: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]>;
  saveRevisionRedirects(redirects: RevisionRedirect[]): Promise<void>;
  saveRevisionLink(link: RevisionLink): Promise<void>;
  listRevisionLinks(repositoryIdentity: string): Promise<RevisionLink[]>;
  listRevisionRedirects(repositoryIdentity: string): Promise<RevisionRedirect[]>;
  resolveRevisionRedirect(input: {
    fromPublicKey: string;
    toPublicKey: string;
    oldPath: string;
    oldStableId?: string | null;
  }): Promise<RevisionRedirect | null>;
  findPublicSnapshotKeyBySnapshotId(snapshotId: string): Promise<string | null>;
  listPurgeablePublicSnapshots(now: string): Promise<PublicSnapshotMetadata[]>;
  purgePublicSnapshotPayload(publicKey: string, purgedAt: string): Promise<boolean>;
  executeRepositoryMigration(input: {
    projectId: string;
    ownerId: string;
    migrationId: string;
    routeReplanned?: boolean;
    summary?: string | null;
    migration?: RepositoryMigrationAction;
  }): Promise<Project | null>;

  saveJob(job: AnalysisJob): Promise<void>;
  loadJob(jobId: string): Promise<AnalysisJob | null>;
  listJobs(): Promise<AnalysisJob[]>;
  latestJob(projectId: string): Promise<AnalysisJob | null>;
  /** Cancel the latest active analysis owned by this project. */
  cancelAnalysisJob(projectId: string, ownerId: string, expectedJobId?: string): Promise<AnalysisJob | null>;
  claimAnalysisJob(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null>;
  heartbeatAnalysisJob(jobId: string, workerId: string, attempt: number, leaseSeconds: number): Promise<boolean>;
  finishAnalysisJob(job: AnalysisJob, workerId: string, attempt: number): Promise<boolean>;
  /** Release a worker-owned lease without consuming a retry attempt. */
  releaseAnalysisJobForResume(jobId: string, workerId: string, attempt: number): Promise<boolean>;
  saveSemanticBatch(batch: SemanticBatch, fence?: AnalysisLeaseFence): Promise<void>;
  loadSemanticBatch(jobId: string, batchId: string): Promise<SemanticBatch | null>;
  listSemanticBatches(jobId: string): Promise<SemanticBatch[]>;
  cancelSemanticBatches(jobId: string, reason: string, fence?: AnalysisLeaseFence): Promise<void>;

  saveProfile(ownerId: string, profile: LearnerProfile): Promise<void>;
  loadProfile(ownerId: string): Promise<LearnerProfile>;
  saveSettings(ownerId: string, settings: ProviderSettings): Promise<void>;
  loadSettings(ownerId: string): Promise<ProviderSettings>;
  saveUser(ownerId: string, payload: Record<string, unknown>): Promise<void>;
  loadUser(ownerId: string): Promise<Record<string, unknown> | null>;
  /** Passive polling authenticates without extending activity or restoring a retired owner. */
  touchOwner(ownerId: string, seenAt: string, minimumIntervalMs: number, recordActivity?: boolean): Promise<OwnerLifecycle | null>;
  listGuestRetentionCandidates(now: string): Promise<GuestRetentionCandidate[]>;
  softDeleteGuestOwner(ownerId: string, deletedAt: string, purgeAfter: string): Promise<boolean>;
  deleteOwner(ownerId: string): Promise<boolean>;
  mergeOwners(input: {
    sourceOwnerId: string;
    targetOwnerId: string;
    memoryCount: number;
    sessionCount: number;
  }): Promise<OwnerMergeSummary>;
  consumeOwnerMergeReceipt(ownerId: string): Promise<OwnerMergeSummary | null>;
  saveTrace(eventId: string, payload: unknown, fence?: AnalysisLeaseFence): Promise<void>;
  listTraces(projectId: string): Promise<Record<string, unknown>[]>;
  listRunTraces(projectId: string, runId: string): Promise<Record<string, unknown>[]>;
  saveEvolutionFeedbackRequest(request: EvolutionFeedbackRequest): Promise<void>;
  upsertEvolutionFeedbackRequest(request: EvolutionFeedbackRequest): Promise<EvolutionFeedbackRequest>;
  loadEvolutionFeedbackRequest(requestId: string): Promise<EvolutionFeedbackRequest | null>;
  listEvolutionFeedbackRequests(status?: EvolutionFeedbackRequestStatus): Promise<EvolutionFeedbackRequest[]>;
  updateEvolutionFeedbackRequest(
    requestId: string,
    mutate: (request: EvolutionFeedbackRequest) => void,
  ): Promise<EvolutionFeedbackRequest | null>;
}
