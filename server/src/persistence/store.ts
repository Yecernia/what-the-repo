import type {
  LearnerProfile,
  Project,
  ProviderSettings,
} from "../domain/conversation.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import type { StoredSourceSnapshot } from "./snapshot-object-store.js";
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
  maxActiveAnalysisJobs: number;
  maxStorageBytes: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxProjects: 20,
  maxCreationsPerHour: 30,
  maxActiveAnalysisJobs: 2,
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

export interface ProviderKeyVault {
  init(): Promise<void>;
  set(ownerId: string, value: string, connectionId?: string): Promise<void>;
  get(ownerId: string, connectionId?: string): string | null;
  clear(ownerId: string, connectionId?: string): Promise<void>;
  masked(ownerId: string, connectionId?: string): string | null;
}

export interface PublicSnapshotBundle<T = Record<string, unknown>> {
  metadata: Record<string, unknown>;
  view: T;
  analysis: Record<string, unknown>;
}

export interface RepositoryIdentityInput {
  repository: string;
  analyzerBundleVersion: string;
  analysisConfigDigest: string;
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
}

export interface SnapshotLanguageOverlayPublication {
  publicKey: string;
  language: string;
  status: "ready" | "degraded";
  payload: SnapshotLanguageOverlayPayload;
  completedAt: string;
  error?: string | null;
}

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
  ): Promise<Project | null>;
  deleteProject(projectId: string, ownerId: string): Promise<boolean>;
  createProjectWithJob(project: Project, job: AnalysisJob): Promise<void>;
  enqueueAnalysisJob(ownerId: string, projectId: string, job: AnalysisJob): Promise<void>;

  saveSnapshot(projectId: string, payload: unknown): Promise<void>;
  loadSnapshot<T = Record<string, unknown>>(projectId: string, displayLanguage?: string): Promise<T | null>;
  saveAnalysisResult(projectId: string, payload: unknown): Promise<void>;
  loadAnalysisResult<T = Record<string, unknown>>(projectId: string): Promise<T | null>;
  /** Persist an analysis-stage checkpoint independently of any published snapshot binding. */
  saveAnalysisCheckpoint(projectId: string, checkpoint: unknown, snapshot: unknown): Promise<void>;
  loadAnalysisCheckpoint<T = Record<string, unknown>>(projectId: string): Promise<{ checkpoint: T; snapshot: T | null } | null>;
  clearAnalysisCheckpoint(projectId: string): Promise<void>;
  queryPublicSnapshot(input: {
    publicKey: string;
    snapshotId: string;
    query: SnapshotQueryInput;
  }): Promise<SnapshotQueryResult>;
  sourceSnapshotRoot(projectId: string, snapshotId: string): string;
  publicSourceSnapshotRoot(publicKey: string, snapshotId: string): string;
  boundSourceSnapshotRoot(projectId: string, snapshotId: string): Promise<string>;
  listSourceFiles(projectId: string, snapshotId: string): Promise<string[]>;
  readSourceLines(projectId: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }>;
  readPublicSourceLines(publicKey: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }>;
  loadPublicSnapshot<T = Record<string, unknown>>(publicKey: string): Promise<PublicSnapshotBundle<T> | null>;
  loadPublicSnapshotMetadata(publicKey: string): Promise<PublicSnapshotMetadata | null>;
  loadLatestPublicSnapshot<T = Record<string, unknown>>(input: {
    repository: string;
    analyzerBundleVersion: string;
    analysisConfigDigest: string;
    excludeCommitSha?: string;
  }): Promise<PublicSnapshotBundle<T> | null>;
  savePublicSnapshot(input: {
    publicKey: string;
    repository: string;
    commitSha: string;
    snapshotId: string;
    sourceRoot?: string;
    preparedSource?: StoredSourceSnapshot;
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
  loadRepositoryHead(input: RepositoryIdentityInput): Promise<RepositoryHead | null>;
  saveRepositoryHead(head: RepositoryHead): Promise<void>;
  createOrJoinRepositoryUpdate(input: {
    project: Project;
    job: AnalysisJob;
    identity: RepositoryIdentityInput;
    targetCommitSha?: string | null;
    newProject: boolean;
  }): Promise<{ update: RepositoryUpdate; job: AnalysisJob; leader: boolean }>;
  loadRepositoryUpdateForProject(projectId: string): Promise<RepositoryUpdate | null>;
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
  touchOwner(ownerId: string, seenAt: string, minimumIntervalMs: number): Promise<OwnerLifecycle | null>;
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
