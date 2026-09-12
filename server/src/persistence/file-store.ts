import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { join } from "node:path";
import { KeyedMutex } from "../agent/mutex.js";
import {
  emptyProfile,
  emptySettings,
  normalizeProfile,
  normalizeSettings,
  nowIso,
  recordAnalysisProgress,
  type LearnerProfile,
  type Project,
  type ProviderSettings,
} from "../domain/conversation.js";
import { newAnalysisJob, type AnalysisJob } from "../domain/jobs.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import type {
  EvolutionFeedbackRequest,
  EvolutionFeedbackRequestStatus,
} from "../domain/evolution.js";
import {
  mergeEvolutionFeedbackRequests,
  removeOwnerFromEvolutionFeedbackRequest,
} from "../domain/evolution.js";
import type {
  GuestRetentionCandidate,
  OwnerLifecycle,
  OwnerMergeSummary,
  PublicSnapshotMetadata,
  RepositoryHead,
  RepositoryUpdate,
  RevisionLink,
  RevisionRedirect,
  SnapshotLanguageOverlay,
} from "../domain/lifecycle.js";
import { resolveRevisionRedirectChain, snapshotLanguageOverlayKey } from "../domain/lifecycle.js";
import type { SnapshotLanguageOverlayPayload } from "../domain/snapshot-language.js";
import {
  applySnapshotLanguageOverlay,
  asSnapshotLanguageOverlayPayload,
} from "../domain/snapshot-language.js";
import { asEvidenceSnapshot } from "../domain/snapshot.js";
import { normalizeDisplayLanguage } from "../domain/display-language.js";
import {
  buildSnapshotQueryDirectory,
  querySnapshotQueryDirectory,
  type SnapshotQueryInput,
  type SnapshotQueryResult,
} from "../domain/snapshot-query.js";
import {
  assembleAnalysisPayload,
  defaultAnalysisChunkKey,
  prepareStoredAnalysisPayload,
} from "./analysis-payload.js";
import {
  DEFAULT_QUOTA_LIMITS,
  AnalysisLeaseLostError,
  QuotaExceededError,
  type AnalysisLeaseFence,
  type ProductStore,
  type PublicSnapshotBundle,
  type ProviderKeyVault,
  type QuotaLimits,
  type RepositoryIdentityInput,
  type RepositoryUpdatePublication,
  type SnapshotLanguageOverlayPublication,
  type SnapshotPublicationTimings,
} from "./store.js";
import type { StoredSourceSnapshot } from "./snapshot-object-store.js";

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value.includes("..")) throw new Error("invalid record id");
  return value.replaceAll(":", "_");
}

function safePublicKey(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid public snapshot key");
  return value.toLowerCase();
}

function identityKey(input: RepositoryIdentityInput): string {
  return createHash("sha256")
    .update(`${input.repository.toLowerCase()}\n${input.analyzerBundleVersion}\n${input.analysisConfigDigest}`)
    .digest("hex");
}

function languageKey(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("/", "_");
  if (!/^[a-z0-9._-]{1,40}$/.test(normalized)) throw new Error("invalid_display_language");
  return normalized;
}

function redirectKey(redirect: RevisionRedirect): string {
  return createHash("sha256")
    .update([
      redirect.from_public_snapshot_key,
      redirect.to_public_snapshot_key,
      redirect.old_path,
      redirect.old_stable_id ?? "",
    ].join("\n"))
    .digest("hex");
}

function snapshotDigest(snapshotId: string): string {
  return createHash("sha256").update(snapshotId).digest("hex").slice(0, 24);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeBytes(
  path: string,
  body: Uint8Array,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let committed = false;
  try {
    await writeFile(temp, body);
    await beforeCommit?.();
    await rename(temp, path);
    committed = true;
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    worker,
  ));
  return results;
}

async function writeJson(
  path: string,
  value: unknown,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  await writeBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), beforeCommit);
}

interface BinaryAnalysisCheckpointEnvelope {
  schema_version: 1;
  encoding: "v8";
  payload_file: string;
  bytes: number;
  sha256: string;
}

function isBinaryAnalysisCheckpointEnvelope(value: unknown): value is BinaryAnalysisCheckpointEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema_version === 1
    && row.encoding === "v8"
    && typeof row.payload_file === "string"
    && /^[A-Za-z0-9._-]+\.bin$/u.test(row.payload_file)
    && Number.isSafeInteger(row.bytes)
    && Number(row.bytes) >= 0
    && typeof row.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(row.sha256);
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class KeyVault implements ProviderKeyVault {
  private readonly keys = new Map<string, string>();
  async init(): Promise<void> {}
  async set(ownerId: string, value: string, connectionId = "legacy"): Promise<void> {
    const id = `${ownerId}\0${connectionId}`;
    const key = value.trim();
    if (key) this.keys.set(id, key); else this.keys.delete(id);
  }
  get(ownerId: string, connectionId = "legacy"): string | null {
    return this.keys.get(`${ownerId}\0${connectionId}`) ?? null;
  }
  async clear(ownerId: string, connectionId = "legacy"): Promise<void> {
    this.keys.delete(`${ownerId}\0${connectionId}`);
  }
  masked(ownerId: string, connectionId = "legacy"): string | null {
    const key = this.get(ownerId, connectionId);
    if (!key) return null;
    return key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}********${key.slice(-4)}`;
  }
}

export class FileStore implements ProductStore {
  readonly kind: ProductStore["kind"] = "file";
  readonly keys: ProviderKeyVault;
  private readonly mutex = new KeyedMutex();
  private readonly dirs: Record<string, string>;

  constructor(
    readonly root: string,
    private readonly quotaLimits: QuotaLimits = DEFAULT_QUOTA_LIMITS,
    keys: ProviderKeyVault = new KeyVault(),
  ) {
    this.keys = keys;
    this.dirs = {
      projects: join(root, "projects"),
      snapshots: join(root, "snapshots"),
      analysisResults: join(root, "analysis-results"),
      analysisCheckpoints: join(root, "analysis-checkpoints"),
      jobs: join(root, "jobs"),
      semanticBatches: join(root, "semantic-batches"),
      profiles: join(root, "profiles"),
      settings: join(root, "settings-by-user"),
      traces: join(root, "traces"),
      evolutionFeedbackRequests: join(root, "evolution-feedback-requests"),
      users: join(root, "users"),
      sourceSnapshots: join(root, "source-snapshots"),
      publicSnapshots: join(root, "public-repository-snapshots"),
      repositoryHeads: join(root, "repository-heads"),
      repositoryUpdates: join(root, "repository-updates"),
      repositoryUpdateProjects: join(root, "repository-update-projects"),
      snapshotLanguageOverlays: join(root, "snapshot-language-overlays"),
      revisionRedirects: join(root, "revision-redirects"),
      revisionLinks: join(root, "revision-links"),
    };
  }

  async init(): Promise<void> {
    await Promise.all(Object.values(this.dirs).map((dir) => mkdir(dir, { recursive: true })));
    await this.keys.init();
  }

  async close(): Promise<void> {}

  async checkHealth(): Promise<void> {
    await access(this.root);
  }

  private path(kind: string, id: string): string {
    const filename = ["users", "profiles", "settings"].includes(kind)
      ? createHash("sha256").update(id).digest("hex")
      : safeId(id);
    return join(this.dirs[kind], `${filename}.json`);
  }

  private analysisLeaseKey(jobId: string): string {
    return `analysis-lease:${jobId}`;
  }

  private semanticBatchPath(jobId: string, batchId: string): string {
    return join(this.dirs.semanticBatches, `${safeId(jobId)}--${safeId(batchId)}.json`);
  }

  private repositoryUpdateMutexKey(update: RepositoryUpdate): string {
    return `repository-update:${identityKey({
      repository: update.repository_identity,
      analyzerBundleVersion: update.analyzer_bundle_version,
      analysisConfigDigest: update.analysis_config_digest,
    })}`;
  }

  private async assertAnalysisLease(fence: AnalysisLeaseFence): Promise<void> {
    const current = await this.loadJob(fence.jobId);
    const expiresAt = current?.lease_expires_at ? Date.parse(current.lease_expires_at) : Number.NaN;
    if (!current
      || current.status !== "running"
      || current.lease_owner !== fence.workerId
      || current.attempt !== fence.attempt
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()) {
      throw new AnalysisLeaseLostError();
    }
  }

  private async writeJsonWithAnalysisLease(
    path: string,
    value: unknown,
    fence: AnalysisLeaseFence | undefined,
  ): Promise<void> {
    if (!fence) {
      await writeJson(path, value);
      return;
    }
    await this.assertAnalysisLease(fence);
    await writeJson(path, value, () => this.assertAnalysisLease(fence));
  }

  private async writeBytesWithAnalysisLease(
    path: string,
    body: Uint8Array,
    fence: AnalysisLeaseFence | undefined,
  ): Promise<void> {
    if (!fence) {
      await writeBytes(path, body);
      return;
    }
    await this.assertAnalysisLease(fence);
    await writeBytes(path, body, () => this.assertAnalysisLease(fence));
  }

  private analysisChunkPath(directory: string, key: string): string {
    const normalized = key.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (normalized !== key
      || parts.length !== 2
      || parts[0] !== "analysis-chunks"
      || !parts[1]
      || parts[1] === "."
      || parts[1] === "..") {
      throw new Error("analysis_payload_chunk_key_invalid");
    }
    return join(directory, "analysis-chunks", parts[1]);
  }

  private async loadAnalysisPayload(directory: string, value: unknown): Promise<unknown> {
    return assembleAnalysisPayload(value, async (key) => {
      try {
        return await readFile(this.analysisChunkPath(directory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  }

  private async replaceSourceSnapshotWithAnalysisLease(
    sourceRoot: string,
    publishedRoot: string,
    fence: AnalysisLeaseFence,
  ): Promise<void> {
    const backupRoot = `${publishedRoot}.previous-${randomUUID()}`;
    let backedUp = false;
    let published = false;
    await mkdir(join(publishedRoot, ".."), { recursive: true });
    try {
      await this.assertAnalysisLease(fence);
      try {
        await rename(publishedRoot, backupRoot);
        backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.assertAnalysisLease(fence);
      await rename(sourceRoot, publishedRoot);
      published = true;
      await this.assertAnalysisLease(fence);
    } catch (error) {
      if (published) await rm(publishedRoot, { recursive: true, force: true }).catch(() => undefined);
      if (backedUp) await rename(backupRoot, publishedRoot).catch(() => undefined);
      throw error;
    }
    if (backedUp) await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  private async withAnalysisLease<T>(
    fence: AnalysisLeaseFence | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!fence) return task();
    return this.mutex.runExclusive(this.analysisLeaseKey(fence.jobId), async () => {
      await this.assertAnalysisLease(fence);
      return task();
    });
  }

  private async updateProjectLocked(
    projectId: string,
    ownerId: string,
    mutate: (project: Project) => void,
    fence?: AnalysisLeaseFence,
  ): Promise<Project | null> {
    return this.mutex.runExclusive(`project:${projectId}`, async () => {
      if (fence) await this.assertAnalysisLease(fence);
      const project = await this.loadProject(projectId, ownerId);
      if (!project) return null;
      mutate(project);
      project.updated_at = nowIso();
      await this.writeJsonWithAnalysisLease(
        this.path("projects", project.project_id),
        project,
        fence,
      );
      return project;
    });
  }

  private async saveJobWithAnalysisLease(
    job: AnalysisJob,
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    await this.writeJsonWithAnalysisLease(this.path("jobs", job.job_id), job, fence);
  }

  private async saveRepositoryHeadWithAnalysisLease(
    head: RepositoryHead,
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    const key = identityKey({
      repository: head.repository_identity,
      analyzerBundleVersion: head.analyzer_bundle_version,
      analysisConfigDigest: head.analysis_config_digest,
    });
    await this.writeJsonWithAnalysisLease(this.path("repositoryHeads", key), head, fence);
  }

  private async saveRevisionRedirectsWithAnalysisLease(
    redirects: RevisionRedirect[],
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    await Promise.all(redirects.map((redirect) => this.writeJsonWithAnalysisLease(
      this.path("revisionRedirects", redirectKey(redirect)),
      redirect,
      fence,
    )));
  }

  private async saveRevisionLinkWithAnalysisLease(
    link: RevisionLink,
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    const key = createHash("sha256")
      .update(`${link.repository_identity}\n${link.from_public_snapshot_key}\n${link.to_public_snapshot_key}`)
      .digest("hex");
    await this.writeJsonWithAnalysisLease(this.path("revisionLinks", key), link, fence);
  }

  async saveProject(project: Project): Promise<void> {
    await writeJson(this.path("projects", project.project_id), project);
  }

  async loadProject(projectId: string, ownerId?: string): Promise<Project | null> {
    const project = await readJson<Project>(this.path("projects", projectId));
    return project && (!ownerId || project.owner_id === ownerId) ? project : null;
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    return (await this.listAllProjects())
      .filter((row) => row.owner_id === ownerId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  private async listAllProjects(): Promise<Project[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.projects).catch(() => [] as string[]);
    const rows = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<Project>(join(this.dirs.projects, name))));
    return rows.filter((row): row is Project => Boolean(row));
  }

  private async listPublicSnapshotMetadataForIdentity(input: RepositoryIdentityInput): Promise<PublicSnapshotMetadata[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.publicSnapshots).catch(() => [] as string[]);
    const rows = await Promise.all(names
      .filter((name) => /^[0-9a-f]{64}$/i.test(name))
      .map((name) => this.loadPublicSnapshotMetadata(name)));
    return rows.filter((row): row is PublicSnapshotMetadata => Boolean(
      row
      && row.repository_identity === input.repository.toLowerCase()
      && row.analyzer_bundle_version === input.analyzerBundleVersion
      && row.analysis_config_digest === input.analysisConfigDigest,
    ));
  }

  async updateProject(
    projectId: string,
    ownerId: string,
    mutate: (project: Project) => void,
    fence?: AnalysisLeaseFence,
  ): Promise<Project | null> {
    return this.withAnalysisLease(fence, () => this.updateProjectLocked(projectId, ownerId, mutate, fence));
  }

  async deleteProject(projectId: string, ownerId: string): Promise<boolean> {
    return this.mutex.runExclusive(`project:${projectId}`, async () => {
      if (!(await this.loadProject(projectId, ownerId))) return false;
      await this.removeProjectArtifacts(projectId);
      await Promise.all([
        rm(this.path("projects", projectId), { force: true }),
        rm(this.path("snapshots", projectId), { force: true }),
        rm(this.path("analysisResults", projectId), { force: true }),
        this.clearAnalysisCheckpoint(projectId),
        rm(join(this.dirs.sourceSnapshots, safeId(projectId)), { recursive: true, force: true }),
      ]);
      await this.reconcileRepositoryUpdatesAfterProjectRemoval(projectId);
      return true;
    });
  }

  async createProjectWithJob(project: Project, job: AnalysisJob): Promise<void> {
    await this.mutex.runExclusive(`owner:${project.owner_id}`, async () => {
      await this.checkCreationQuotas(project.owner_id, true);
      await this.saveProject(project);
      await this.saveJob(job);
      await this.writeQuotaEvent(project.owner_id, project.project_id);
    });
  }

  async enqueueAnalysisJob(ownerId: string, projectId: string, job: AnalysisJob): Promise<void> {
    await this.mutex.runExclusive(`owner:${ownerId}`, async () => {
      if (!(await this.loadProject(projectId, ownerId))) throw new Error("project_not_found");
      await this.checkCreationQuotas(ownerId, false);
      await this.saveJob(job);
      await this.writeQuotaEvent(ownerId, projectId);
    });
  }

  async saveSnapshot(projectId: string, payload: unknown): Promise<void> { await writeJson(this.path("snapshots", projectId), payload); }
  async loadSnapshot<T = Record<string, unknown>>(projectId: string, displayLanguage?: string): Promise<T | null> {
    const project = await this.loadProject(projectId);
    const key = project?.analysis.canonical_snapshot_key;
    if (key) {
      const directory = join(this.dirs.publicSnapshots, safePublicKey(key));
      const [raw, metadata] = await Promise.all([
        readJson<unknown>(join(directory, "view.json")),
        readJson<Record<string, unknown>>(join(directory, "metadata.json")),
      ]);
      if (!metadata?.language_overlay_version) return raw as T | null;
      const snapshot = asEvidenceSnapshot(raw);
      if (!snapshot || !project) return null;
      const languages = new Set([
        normalizeDisplayLanguage(displayLanguage ?? project.display_language),
        normalizeDisplayLanguage(project.display_language),
      ]);
      for (const language of languages) {
        const overlay = await this.loadSnapshotLanguageOverlay(key, language);
        const payload = asSnapshotLanguageOverlayPayload(overlay?.payload);
        if (!overlay || !payload || (overlay.status !== "ready" && overlay.status !== "degraded")) continue;
        const assembled = applySnapshotLanguageOverlay(snapshot, payload);
        assembled.language_overlay_status = overlay.status;
        return assembled as T;
      }
      return null;
    }
    return readJson<T>(this.path("snapshots", projectId));
  }
  async saveAnalysisResult(projectId: string, payload: unknown): Promise<void> { await writeJson(this.path("analysisResults", projectId), payload); }
  async loadAnalysisResult<T = Record<string, unknown>>(projectId: string): Promise<T | null> {
    const project = await this.loadProject(projectId);
    const key = project?.analysis.canonical_snapshot_key;
    if (key) {
      const directory = join(this.dirs.publicSnapshots, safePublicKey(key));
      const raw = await readJson<unknown>(join(directory, "analysis.json"));
      return raw === null ? null : await this.loadAnalysisPayload(directory, raw) as T;
    }
    return readJson<T>(this.path("analysisResults", projectId));
  }

  /**
   * Checkpoints can contain the complete fact graph and parsed-file cache.
   * JSON.stringify creates one enormous JavaScript string for that payload and
   * eventually hits V8's string-size limit. Keep a tiny JSON pointer and store
   * the actual plain-data payload through V8's binary serializer instead.
   * Historical .json checkpoints remain readable for recovery.
   */
  async saveAnalysisCheckpoint(projectId: string, checkpoint: unknown, snapshot: unknown): Promise<void> {
    const checkpointPath = this.path("analysisCheckpoints", projectId);
    const payload = serialize({ checkpoint, snapshot });
    const payloadFile = `${safeId(projectId)}.${randomUUID()}.bin`;
    const payloadPath = join(this.dirs.analysisCheckpoints, payloadFile);
    await writeBytes(payloadPath, payload);
    try {
      await writeJson(checkpointPath, {
        schema_version: 1,
        encoding: "v8",
        payload_file: payloadFile,
        bytes: payload.byteLength,
        sha256: bytesSha256(payload),
      } satisfies BinaryAnalysisCheckpointEnvelope);
    } catch (error) {
      await rm(payloadPath, { force: true }).catch(() => undefined);
      throw error;
    }
    // A crashed process may leave older generations behind. They are safe to
    // remove only after the new pointer has been committed.
    const prefix = `${safeId(projectId)}.`;
    await Promise.all((await readdir(this.dirs.analysisCheckpoints).catch(() => [] as string[]))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bin") && name !== payloadFile)
      .map((name) => rm(join(this.dirs.analysisCheckpoints, name), { force: true }).catch(() => undefined)));
  }

  async loadAnalysisCheckpoint<T = Record<string, unknown>>(projectId: string): Promise<{ checkpoint: T; snapshot: T | null } | null> {
    const checkpointPath = this.path("analysisCheckpoints", projectId);
    const value = await readJson<unknown>(checkpointPath);
    if (!value) return null;
    if (isBinaryAnalysisCheckpointEnvelope(value)) {
      const payloadPath = join(this.dirs.analysisCheckpoints, value.payload_file);
      let payload: Uint8Array;
      try {
        payload = await readFile(payloadPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("analysis_checkpoint_payload_missing");
        }
        throw error;
      }
      if (payload.byteLength !== value.bytes || bytesSha256(payload) !== value.sha256) {
        throw new Error("analysis_checkpoint_integrity_mismatch");
      }
      let decoded: unknown;
      try {
        decoded = deserialize(payload);
      } catch {
        throw new Error("analysis_checkpoint_payload_invalid");
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("analysis_checkpoint_payload_invalid");
      }
      const row = decoded as { checkpoint?: T; snapshot?: T | null };
      if (!row.checkpoint) return null;
      return { checkpoint: row.checkpoint, snapshot: row.snapshot ?? null };
    }
    // Legacy checkpoints written before the binary format.
    const legacy = value as { checkpoint?: T; snapshot?: T | null };
    if (!legacy.checkpoint) return null;
    return { checkpoint: legacy.checkpoint, snapshot: legacy.snapshot ?? null };
  }

  async clearAnalysisCheckpoint(projectId: string): Promise<void> {
    const prefix = `${safeId(projectId)}.`;
    await Promise.all([
      rm(this.path("analysisCheckpoints", projectId), { force: true }),
      readdir(this.dirs.analysisCheckpoints).then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(prefix) && name.endsWith(".bin"))
          .map((name) => rm(join(this.dirs.analysisCheckpoints, name), { force: true })),
      )).catch(() => undefined),
    ]);
  }

  async queryPublicSnapshot(input: {
    publicKey: string;
    snapshotId: string;
    query: SnapshotQueryInput;
  }): Promise<SnapshotQueryResult> {
    const bundle = await this.loadPublicSnapshot(input.publicKey);
    if (!bundle || String(bundle.metadata.analysis_snapshot_id ?? "") !== input.snapshotId) {
      throw new Error("snapshot_query_not_found");
    }
    const directory = buildSnapshotQueryDirectory(
      input.publicKey,
      input.snapshotId,
      bundle.view,
      bundle.analysis,
    );
    return querySnapshotQueryDirectory(directory, input.query);
  }
  sourceSnapshotRoot(projectId: string, snapshotId: string): string {
    return join(this.dirs.sourceSnapshots, safeId(projectId), snapshotDigest(snapshotId));
  }
  publicSourceSnapshotRoot(publicKey: string, snapshotId: string): string {
    return join(this.dirs.sourceSnapshots, "public", safePublicKey(publicKey), snapshotDigest(snapshotId));
  }
  async boundSourceSnapshotRoot(projectId: string, snapshotId: string): Promise<string> {
    const project = await this.loadProject(projectId);
    if (!project || project.analysis.snapshot_id !== snapshotId) throw new Error("snapshot_not_bound");
    if (project.analysis.canonical_snapshot_key) {
      const key = safePublicKey(project.analysis.canonical_snapshot_key);
      const metadata = await readJson<Record<string, unknown>>(join(this.dirs.publicSnapshots, key, "metadata.json"));
      if (String(metadata?.analysis_snapshot_id ?? "") !== snapshotId) throw new Error("snapshot_not_bound");
      return this.publicSourceSnapshotRoot(key, snapshotId);
    }
    return this.sourceSnapshotRoot(projectId, snapshotId);
  }
  async listSourceFiles(projectId: string, snapshotId: string): Promise<string[]> {
    const root = await this.boundSourceSnapshotRoot(projectId, snapshotId);
    const { readdir, stat } = await import("node:fs/promises");
    const result: string[] = [];
    const visit = async (directory: string, relative: string): Promise<void> => {
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (name === ".snapshot-meta.json") continue;
        const absolute = join(directory, name);
        const info = await stat(absolute);
        const child = relative ? `${relative}/${name}` : name;
        if (info.isDirectory()) await visit(absolute, child); else if (info.isFile()) result.push(child);
      }
    };
    await visit(root, "");
    return result.sort();
  }
  async readSourceLines(projectId: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }> {
    const root = await this.boundSourceSnapshotRoot(projectId, snapshotId);
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("invalid_source_path");
    const target = join(root, ...normalized.split("/"));
    const { realpath } = await import("node:fs/promises");
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!(realTarget === realRoot || realTarget.startsWith(`${realRoot}${process.platform === "win32" ? "\\" : "/"}`))) throw new Error("source_path_outside_snapshot");
    const text = await readFile(realTarget, "utf8");
    const all = text.split(/\r?\n/);
    const safeStart = Math.max(1, Math.floor(start));
    const safeEnd = Math.min(all.length, Math.max(safeStart, Math.floor(end)), safeStart + 399);
    return { lines: all.slice(safeStart - 1, safeEnd), truncated: safeEnd < all.length && safeEnd < end };
  }

  async readPublicSourceLines(publicKey: string, snapshotId: string, relativePath: string, start: number, end: number): Promise<{ lines: string[]; truncated: boolean }> {
    const metadata = await this.loadPublicSnapshotMetadata(publicKey);
    if (!metadata || metadata.analysis_snapshot_id !== snapshotId) throw new Error("snapshot_not_found");
    const root = this.publicSourceSnapshotRoot(publicKey, snapshotId);
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("invalid_source_path");
    const target = join(root, ...normalized.split("/"));
    const { realpath } = await import("node:fs/promises");
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!(realTarget === realRoot || realTarget.startsWith(`${realRoot}${process.platform === "win32" ? "\\" : "/"}`))) {
      throw new Error("source_path_outside_snapshot");
    }
    const all = (await readFile(realTarget, "utf8")).split(/\r?\n/);
    const safeStart = Math.max(1, Math.floor(start));
    const safeEnd = Math.min(all.length, Math.max(safeStart, Math.floor(end)), safeStart + 399);
    return { lines: all.slice(safeStart - 1, safeEnd), truncated: safeEnd < all.length && safeEnd < end };
  }

  async loadPublicSnapshot<T = Record<string, unknown>>(publicKey: string): Promise<PublicSnapshotBundle<T> | null> {
    const directory = join(this.dirs.publicSnapshots, safePublicKey(publicKey));
    const [metadata, view, analysisRaw] = await Promise.all([
      readJson<Record<string, unknown>>(join(directory, "metadata.json")),
      readJson<T>(join(directory, "view.json")),
      readJson<unknown>(join(directory, "analysis.json")),
    ]);
    const analysis = analysisRaw === null
      ? null
      : await this.loadAnalysisPayload(directory, analysisRaw) as Record<string, unknown>;
    return metadata && view && analysis ? { metadata, view, analysis } : null;
  }

  async loadPublicSnapshotMetadata(publicKey: string): Promise<PublicSnapshotMetadata | null> {
    const metadata = await readJson<Record<string, unknown>>(join(this.dirs.publicSnapshots, safePublicKey(publicKey), "metadata.json"));
    if (!metadata || typeof metadata.identity !== "object" || !metadata.identity) return null;
    const identity = metadata.identity as Record<string, unknown>;
    return {
      public_snapshot_key: String(metadata.public_snapshot_key ?? publicKey),
      repository_identity: String(identity.repository_identity ?? ""),
      commit_sha: String(identity.commit_sha ?? ""),
      analyzer_bundle_version: String(identity.analyzer_bundle_version ?? ""),
      analysis_config_digest: String(identity.analysis_config_digest ?? ""),
      analysis_snapshot_id: String(metadata.analysis_snapshot_id ?? ""),
      language_overlay_version: typeof metadata.language_overlay_version === "string" ? metadata.language_overlay_version : null,
      retired_at: typeof metadata.retired_at === "string" ? metadata.retired_at : null,
      purge_after: typeof metadata.purge_after === "string" ? metadata.purge_after : null,
      payload_purged_at: typeof metadata.payload_purged_at === "string" ? metadata.payload_purged_at : null,
    };
  }

  async loadLatestPublicSnapshot<T = Record<string, unknown>>(input: {
    repository: string;
    analyzerBundleVersion: string;
    analysisConfigDigest: string;
    excludeCommitSha?: string;
  }): Promise<PublicSnapshotBundle<T> | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.publicSnapshots).catch(() => [] as string[]);
    let selected: { publicKey: string; createdAt: string } | null = null;
    for (const publicKey of names) {
      if (!/^[0-9a-f]{64}$/i.test(publicKey)) continue;
      const metadata = await readJson<Record<string, unknown>>(join(this.dirs.publicSnapshots, publicKey, "metadata.json"));
      const identity = metadata?.identity;
      if (!identity || typeof identity !== "object") continue;
      const row = identity as Record<string, unknown>;
      if (
        String(row.repository_identity ?? "").toLowerCase() !== input.repository.toLowerCase()
        || row.analyzer_bundle_version !== input.analyzerBundleVersion
        || row.analysis_config_digest !== input.analysisConfigDigest
        || row.commit_sha === input.excludeCommitSha
      ) continue;
      const createdAt = typeof metadata?.created_at === "string" ? metadata.created_at : "";
      if (!selected || createdAt > selected.createdAt) selected = { publicKey, createdAt };
    }
    return selected ? this.loadPublicSnapshot<T>(selected.publicKey) : null;
  }

  /** Local file storage publishes by moving its source directory at final commit. */
  async preparePublicSnapshotSource(_input: {
    publicKey: string; snapshotId: string; sourceRoot: string; fence?: AnalysisLeaseFence; signal?: AbortSignal;
  }): Promise<StoredSourceSnapshot | null> { return null; }

  async savePublicSnapshot(input: {
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
  }): Promise<SnapshotPublicationTimings | void> {
    const directory = join(this.dirs.publicSnapshots, safePublicKey(input.publicKey));
    await this.withAnalysisLease(input.fence, async () => {
      if (input.fence && input.sourceRoot) {
        const publishedRoot = this.publicSourceSnapshotRoot(input.publicKey, input.snapshotId);
        if (input.sourceRoot !== publishedRoot) {
          await this.replaceSourceSnapshotWithAnalysisLease(input.sourceRoot, publishedRoot, input.fence);
        }
      }
      const preparedAnalysis = await prepareStoredAnalysisPayload(
        input.analysis,
        (path, index, sha256) => defaultAnalysisChunkKey("", path, index, sha256),
        async (key, body) => {
          await this.writeBytesWithAnalysisLease(
            this.analysisChunkPath(directory, key),
            body,
            input.fence,
          );
          return {
            key,
            bytes: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
          };
        },
      );
      await Promise.all([
        this.writeJsonWithAnalysisLease(join(directory, "view.json"), input.view, input.fence),
        this.writeJsonWithAnalysisLease(join(directory, "analysis.json"), preparedAnalysis.value, input.fence),
        this.writeJsonWithAnalysisLease(join(directory, "metadata.json"), {
          contract: "canonical-public-repository-snapshot-v1",
          public_snapshot_key: input.publicKey,
          identity: {
            repository_identity: input.repository.toLowerCase(),
            commit_sha: input.commitSha,
            analyzer_bundle_version: input.analyzerBundleVersion ?? "typescript-0.1.0",
            analysis_config_digest: input.analysisConfigDigest ?? "tree-sitter-nine-language-v1",
          },
          analysis_snapshot_id: input.snapshotId,
          language_overlay_version: input.languageOverlayVersion ?? null,
          reuse_count: 1,
          created_at: nowIso(),
          last_used_at: nowIso(),
          retired_at: null,
          purge_after: null,
          payload_purged_at: null,
        }, input.fence),
      ]);
    });
  }

  async loadRepositoryHead(input: RepositoryIdentityInput): Promise<RepositoryHead | null> {
    return readJson<RepositoryHead>(this.path("repositoryHeads", identityKey(input)));
  }

  async saveRepositoryHead(head: RepositoryHead): Promise<void> {
    await this.saveRepositoryHeadWithAnalysisLease(head);
  }

  async createOrJoinRepositoryUpdate(input: {
    project: Project;
    job: AnalysisJob;
    identity: RepositoryIdentityInput;
    targetCommitSha?: string | null;
    newProject: boolean;
  }): Promise<{ update: RepositoryUpdate; job: AnalysisJob; leader: boolean }> {
    const key = identityKey(input.identity);
    return this.mutex.runExclusive(`repository-update:${key}`, async () => {
      await this.checkCreationQuotas(input.project.owner_id, input.newProject);
      if (!input.newProject && !(await this.loadProject(input.project.project_id, input.project.owner_id))) {
        throw new Error("project_not_found");
      }
      await this.saveProject(input.project);
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(this.dirs.repositoryUpdates).catch(() => [] as string[]);
      const rows = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<RepositoryUpdate>(join(this.dirs.repositoryUpdates, name))));
      let update = rows.find((row): row is RepositoryUpdate => Boolean(
        row
          && row.repository_identity === input.identity.repository.toLowerCase()
          && row.analyzer_bundle_version === input.identity.analyzerBundleVersion
          && row.analysis_config_digest === input.identity.analysisConfigDigest
          && (row.status === "queued" || row.status === "running"),
      ));
      if (update) {
        await writeJson(join(this.dirs.repositoryUpdateProjects, `${safeId(update.update_id)}-${safeId(input.project.project_id)}.json`), {
          project_id: input.project.project_id,
          update_id: update.update_id,
          created_at: nowIso(),
        });
        const waiter: AnalysisJob = {
          ...input.job,
          repository_update_id: update.update_id,
          execution_role: "waiter",
        };
        await this.saveJob(waiter);
        await this.writeQuotaEvent(input.project.owner_id, input.project.project_id);
        return { update, job: waiter, leader: false };
      }
      const timestamp = nowIso();
      update = {
        update_id: randomUUID().replaceAll("-", ""),
        repository_identity: input.identity.repository.toLowerCase(),
        analyzer_bundle_version: input.identity.analyzerBundleVersion,
        analysis_config_digest: input.identity.analysisConfigDigest,
        target_commit_sha: input.targetCommitSha ?? null,
        status: "queued",
        leader_project_id: input.project.project_id,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        result_public_snapshot_key: null,
        error: null,
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
      };
      await writeJson(this.path("repositoryUpdates", update.update_id), update);
      await writeJson(join(this.dirs.repositoryUpdateProjects, `${safeId(update.update_id)}-${safeId(input.project.project_id)}.json`), {
        project_id: input.project.project_id,
        update_id: update.update_id,
        created_at: timestamp,
      });
      const leader: AnalysisJob = {
        ...input.job,
        repository_update_id: update.update_id,
        execution_role: "leader",
      };
      await this.saveJob(leader);
      await this.writeQuotaEvent(input.project.owner_id, input.project.project_id);
      return { update, job: leader, leader: true };
    });
  }

  async loadRepositoryUpdateForProject(projectId: string): Promise<RepositoryUpdate | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.repositoryUpdateProjects).catch(() => [] as string[]);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const joinRow = await readJson<{ project_id?: string; update_id?: string }>(join(this.dirs.repositoryUpdateProjects, name));
      if (joinRow?.project_id !== projectId || !joinRow.update_id) continue;
      return readJson<RepositoryUpdate>(this.path("repositoryUpdates", joinRow.update_id));
    }
    return null;
  }

  async listRepositoryUpdateProjects(updateId: string): Promise<Project[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.repositoryUpdateProjects).catch(() => [] as string[]);
    const joins = await Promise.all(names.filter((name) => name.startsWith(`${safeId(updateId)}-`) && name.endsWith(".json")).map((name) => readJson<{ project_id?: string }>(join(this.dirs.repositoryUpdateProjects, name))));
    const projects = await Promise.all(joins.filter((row): row is { project_id: string } => Boolean(row?.project_id)).map((row) => this.loadProject(row.project_id)));
    return projects.filter((row): row is Project => Boolean(row));
  }

  async publishRepositoryUpdate(input: RepositoryUpdatePublication & { fence?: AnalysisLeaseFence }): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const update = await readJson<RepositoryUpdate>(this.path("repositoryUpdates", input.updateId));
      if (!update) throw new Error("repository_update_not_found");
      return this.mutex.runExclusive(`repository-update:${identityKey({
        repository: update.repository_identity,
        analyzerBundleVersion: update.analyzer_bundle_version,
        analysisConfigDigest: update.analysis_config_digest,
      })}`, async () => {
      let fencedJobFinalized = false;
      const fenceForWrite = (): AnalysisLeaseFence | undefined =>
        input.fence && !fencedJobFinalized ? input.fence : undefined;
      const current = await readJson<RepositoryUpdate>(this.path("repositoryUpdates", input.updateId));
      if (!current) throw new Error("repository_update_not_found");
      const timestamp = input.completedAt || nowIso();
      const previousHead = await this.loadRepositoryHead({
        repository: current.repository_identity,
        analyzerBundleVersion: current.analyzer_bundle_version,
        analysisConfigDigest: current.analysis_config_digest,
      });
      const previousPublicKey = previousHead?.current_public_snapshot_key ?? null;
      await this.writeJsonWithAnalysisLease(this.path("repositoryUpdates", input.updateId), {
        ...current,
        status: "succeeded",
        result_public_snapshot_key: input.publicKey,
        target_commit_sha: input.commitSha,
        error: null,
        updated_at: timestamp,
        completed_at: timestamp,
      }, fenceForWrite());
      await this.saveRepositoryHeadWithAnalysisLease({
        repository_identity: current.repository_identity,
        analyzer_bundle_version: current.analyzer_bundle_version,
        analysis_config_digest: current.analysis_config_digest,
        current_public_snapshot_key: input.publicKey,
        current_commit_sha: input.commitSha,
        last_checked_at: timestamp,
        updated_at: timestamp,
      }, fenceForWrite());
      const identity = {
        repository: current.repository_identity,
        analyzerBundleVersion: current.analyzer_bundle_version,
        analysisConfigDigest: current.analysis_config_digest,
      };
      const [joinedProjects, allProjects, identitySnapshots, jobs] = await Promise.all([
        this.listRepositoryUpdateProjects(input.updateId),
        this.listAllProjects(),
        this.listPublicSnapshotMetadataForIdentity(identity),
        this.listJobs(),
      ]);
      const identitySnapshotByKey = new Map(identitySnapshots.map((row) => [row.public_snapshot_key.toLowerCase(), row]));
      const boundProjects = allProjects.filter((project) => {
        const key = project.analysis.canonical_snapshot_key?.toLowerCase();
        return Boolean(key && key !== input.publicKey.toLowerCase() && identitySnapshotByKey.has(key));
      });
      const projects = [...new Map(
        [...joinedProjects, ...boundProjects].map((project) => [project.project_id, project]),
      ).values()];
      if (previousPublicKey && previousPublicKey !== input.publicKey) {
        await this.saveRevisionLinkWithAnalysisLease({
          repository_identity: current.repository_identity,
          from_public_snapshot_key: previousPublicKey,
          to_public_snapshot_key: input.publicKey,
          created_at: timestamp,
        }, fenceForWrite());
      }
      for (const oldSnapshot of identitySnapshots.filter((row) => row.public_snapshot_key !== input.publicKey)) {
        const metadataPath = join(this.dirs.publicSnapshots, safePublicKey(oldSnapshot.public_snapshot_key), "metadata.json");
        const oldRaw = await readJson<Record<string, unknown>>(metadataPath);
        if (!oldRaw) continue;
        oldRaw.retired_at = timestamp;
        oldRaw.purge_after = timestamp;
        await this.writeJsonWithAnalysisLease(metadataPath, oldRaw, fenceForWrite());
      }
      const targetMetadata = await this.loadPublicSnapshotMetadata(input.publicKey);
      const usesOverlays = Boolean(targetMetadata?.language_overlay_version);
      const readyLanguage = input.readyLanguage ? languageKey(input.readyLanguage) : null;
      const activeJobsByProject = new Map<string, AnalysisJob>();
      for (const job of jobs
        .filter((row) => row.status === "queued" || row.status === "running")
        .sort((left, right) => right.created_at.localeCompare(left.created_at))) {
        if (!activeJobsByProject.has(job.project_id)) activeJobsByProject.set(job.project_id, job);
      }
      const overlayLeaders = new Set(jobs
        .filter((row) => (row.status === "queued" || row.status === "running")
          && row.execution_role === "overlay"
          && row.language_overlay_key?.startsWith(`${input.publicKey}:`))
        .map((row) => row.language_overlay_key as string));
      const pendingOverlays = new Set<string>();
      for (const project of projects) {
        const previousProjectKey = project.analysis.canonical_snapshot_key;
        const projectPreviousMetadata = previousProjectKey
          ? identitySnapshotByKey.get(previousProjectKey.toLowerCase())
            ?? await this.loadPublicSnapshotMetadata(previousProjectKey)
          : null;
        const projectLanguage = languageKey(normalizeDisplayLanguage(project.display_language));
        const overlay = usesOverlays && projectLanguage !== readyLanguage
          ? await this.loadSnapshotLanguageOverlay(input.publicKey, projectLanguage)
          : null;
        const overlayReady = !usesOverlays || projectLanguage === readyLanguage
          || ["ready", "degraded"].includes(overlay?.status ?? "");
        await this.updateProjectLocked(project.project_id, project.owner_id, (row) => {
          if (previousProjectKey && previousProjectKey !== input.publicKey) {
            const fromCommit = String(projectPreviousMetadata?.commit_sha ?? row.source.commit_sha ?? "");
            row.repository_migration = {
              migration_id: randomUUID().replaceAll("-", ""),
              from_public_snapshot_key: previousProjectKey,
              to_public_snapshot_key: input.publicKey,
              from_snapshot_id: String(projectPreviousMetadata?.analysis_snapshot_id ?? row.analysis.snapshot_id ?? ""),
              to_snapshot_id: input.snapshotId,
              from_commit_sha: fromCommit,
              to_commit_sha: input.commitSha,
              status: "executed",
              route_replanned: false,
              resume_step: row.study.current_step,
              summary: `仓库已自动迁移到 commit ${input.commitSha.slice(0, 12)}；历史回答仍标注原 commit ${fromCommit.slice(0, 12)}。`,
              created_at: timestamp,
              resolved_at: timestamp,
              executed_at: timestamp,
              error: null,
            };
          }
          if (overlayReady) {
            recordAnalysisProgress(row.analysis, "interpreting", "completed", timestamp);
            recordAnalysisProgress(row.analysis, "completed", "completed", timestamp);
          } else {
            recordAnalysisProgress(row.analysis, "interpreting", "running", timestamp);
          }
          row.analysis.stage = overlayReady ? "done" : "interpreting";
          row.analysis.snapshot_id = input.snapshotId;
          row.analysis.file_count = input.fileCount;
          row.analysis.symbol_count = input.symbolCount;
          row.analysis.call_count = input.callCount;
          row.analysis.languages = [...input.languages];
          row.analysis.error = null;
          row.analysis.canonical_snapshot_key = input.publicKey;
          row.analysis.completed_at = overlayReady ? timestamp : null;
          row.source.commit_sha = input.commitSha;
        }, fenceForWrite());
        const activeJob = activeJobsByProject.get(project.project_id);
        if (overlayReady) {
          if (activeJob) {
            await this.saveJobWithAnalysisLease({
              ...activeJob,
              status: "succeeded",
              lease_owner: null,
              lease_expires_at: null,
              language_overlay_key: null,
              completed_at: timestamp,
              updated_at: timestamp,
              heartbeat_at: timestamp,
              error: null,
              error_code: null,
            }, fenceForWrite());
            if (input.fence?.jobId === activeJob.job_id) fencedJobFinalized = true;
          }
          continue;
        }
        const overlayKey = snapshotLanguageOverlayKey(input.publicKey, projectLanguage);
        const keepsLeadership = activeJob?.execution_role === "overlay"
          && activeJob.language_overlay_key === overlayKey;
        const leader = keepsLeadership || !overlayLeaders.has(overlayKey);
        overlayLeaders.add(overlayKey);
        if (!pendingOverlays.has(overlayKey)) {
          pendingOverlays.add(overlayKey);
          await this.saveSnapshotLanguageOverlayWithAnalysisLease({
            publicKey: input.publicKey,
            language: projectLanguage,
            status: "pending",
            payload: null,
          }, fenceForWrite());
        }
        const overlayJob = activeJob ?? newAnalysisJob(
          project.project_id,
          `migration-overlay:${project.project_id}:${input.publicKey}:${randomUUID()}`,
        );
        await this.saveJobWithAnalysisLease({
          ...overlayJob,
          status: "queued",
          attempt: 0,
          repository_update_id: null,
          execution_role: leader ? "overlay" : "waiter",
          language_overlay_key: overlayKey,
          lease_owner: null,
          lease_expires_at: null,
          completed_at: null,
          updated_at: timestamp,
          heartbeat_at: null,
          error: null,
          error_code: null,
        }, fenceForWrite());
        if (input.fence?.jobId === overlayJob.job_id) fencedJobFinalized = true;
      }
      await this.saveRevisionRedirectsWithAnalysisLease(input.redirects, fenceForWrite());
      return projects.map((project) => project.project_id);
      });
    };
    return this.withAnalysisLease(input.fence, run);
  }

  async failRepositoryUpdate(updateId: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const update = await readJson<RepositoryUpdate>(this.path("repositoryUpdates", updateId));
      if (!update) return [];
      return this.mutex.runExclusive(`repository-update:${identityKey({
        repository: update.repository_identity,
        analyzerBundleVersion: update.analyzer_bundle_version,
        analysisConfigDigest: update.analysis_config_digest,
      })}`, async () => {
      let fencedJobFinalized = false;
      const fenceForWrite = (): AnalysisLeaseFence | undefined =>
        fence && !fencedJobFinalized ? fence : undefined;
      const timestamp = nowIso();
      await this.writeJsonWithAnalysisLease(this.path("repositoryUpdates", updateId), { ...update, status: "failed", error, updated_at: timestamp, completed_at: timestamp }, fenceForWrite());
      const projects = await this.listRepositoryUpdateProjects(updateId);
      for (const project of projects) {
        await this.updateProjectLocked(project.project_id, project.owner_id, (row) => {
          // A failed update must not destroy a usable previous snapshot.
          recordAnalysisProgress(row.analysis, "failed", "failed", timestamp);
          if (row.analysis.canonical_snapshot_key) {
            row.analysis.stage = "done";
            row.analysis.error = null;
          } else {
            row.analysis.stage = "failed";
            row.analysis.error = error;
          }
          row.analysis.completed_at = timestamp;
        }, fenceForWrite());
      }
      for (const job of (await this.listJobs()).filter((row) => row.repository_update_id === updateId && (row.status === "queued" || row.status === "running"))) {
        await this.saveJobWithAnalysisLease({ ...job, status: "failed", lease_owner: null, lease_expires_at: null, completed_at: timestamp, updated_at: timestamp, heartbeat_at: timestamp, error, error_code: "repository_update_failed" }, fenceForWrite());
        if (fence?.jobId === job.job_id) fencedJobFinalized = true;
      }
      return projects.map((project) => project.project_id);
      });
    };
    return this.withAnalysisLease(fence, run);
  }

  async loadSnapshotLanguageOverlay(publicKey: string, language: string): Promise<SnapshotLanguageOverlay | null> {
    return readJson<SnapshotLanguageOverlay>(join(this.dirs.snapshotLanguageOverlays, safePublicKey(publicKey), `${languageKey(language)}.json`));
  }

  async listSnapshotLanguageOverlays(publicKey: string): Promise<SnapshotLanguageOverlay[]> {
    const directory = join(this.dirs.snapshotLanguageOverlays, safePublicKey(publicKey));
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(directory).catch(() => [] as string[]);
    const rows = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<SnapshotLanguageOverlay>(join(directory, name))));
    return rows.filter((row): row is SnapshotLanguageOverlay => Boolean(row));
  }

  async saveSnapshotLanguageOverlay(input: {
    publicKey: string;
    language: string;
    status: SnapshotLanguageOverlay["status"];
    payload: SnapshotLanguageOverlayPayload | null;
    error?: string | null;
    fence?: AnalysisLeaseFence;
  }): Promise<void> {
    await this.withAnalysisLease(input.fence, () => this.saveSnapshotLanguageOverlayWithAnalysisLease(input, input.fence));
  }

  private async saveSnapshotLanguageOverlayWithAnalysisLease(
    input: {
      publicKey: string;
      language: string;
      status: SnapshotLanguageOverlay["status"];
      payload: SnapshotLanguageOverlayPayload | null;
      error?: string | null;
    },
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    const timestamp = nowIso();
    await this.writeJsonWithAnalysisLease(join(this.dirs.snapshotLanguageOverlays, safePublicKey(input.publicKey), `${languageKey(input.language)}.json`), {
      public_snapshot_key: input.publicKey,
      language: languageKey(input.language),
      status: input.status,
      payload: input.payload as unknown as Record<string, unknown> | null,
      generated_at: input.payload ? timestamp : null,
      error: input.error ?? null,
    } satisfies SnapshotLanguageOverlay, fence);
  }

  async createOrJoinSnapshotLanguageOverlay(input: {
    project: Project;
    job: AnalysisJob;
    publicKey: string;
    language: string;
    newProject: boolean;
    systemManaged?: boolean;
  }): Promise<{ job: AnalysisJob; ready: boolean }> {
    const language = languageKey(normalizeDisplayLanguage(input.language));
    const overlayKey = snapshotLanguageOverlayKey(input.publicKey, language);
    return this.mutex.runExclusive(`snapshot-language:${overlayKey}`, async () => {
      if (!input.systemManaged) await this.checkCreationQuotas(input.project.owner_id, input.newProject);
      if (!input.newProject && !(await this.loadProject(input.project.project_id, input.project.owner_id))) {
        throw new Error("project_not_found");
      }
      const existing = await this.loadSnapshotLanguageOverlay(input.publicKey, language);
      const ready = existing?.status === "ready" || existing?.status === "degraded";
      const timestamp = nowIso();
      if (ready) {
        input.project.analysis.stage = "done";
        input.project.analysis.completed_at = timestamp;
      } else {
        input.project.analysis.stage = "interpreting";
        input.project.analysis.completed_at = null;
      }
      input.project.updated_at = timestamp;
      await this.saveProject(input.project);
      const active = ready ? null : (await this.listJobs()).find((row) =>
        row.language_overlay_key === overlayKey
        && row.execution_role === "overlay"
        && (row.status === "queued" || row.status === "running"));
      const queued: AnalysisJob = {
        ...input.job,
        status: ready ? "succeeded" : "queued",
        repository_update_id: null,
        execution_role: ready ? "waiter" : active ? "waiter" : "overlay",
        language_overlay_key: overlayKey,
        heartbeat_at: ready ? timestamp : null,
        completed_at: ready ? timestamp : null,
        updated_at: timestamp,
      };
      await this.saveJob(queued);
      if (!ready && !existing) {
        await this.saveSnapshotLanguageOverlay({ publicKey: input.publicKey, language, status: "pending", payload: null });
      }
      if (!input.systemManaged) await this.writeQuotaEvent(input.project.owner_id, input.project.project_id);
      return { job: queued, ready };
    });
  }

  async publishSnapshotLanguageOverlay(input: SnapshotLanguageOverlayPublication & { fence?: AnalysisLeaseFence }): Promise<string[]> {
    const language = languageKey(normalizeDisplayLanguage(input.language));
    const overlayKey = snapshotLanguageOverlayKey(input.publicKey, language);
    const run = (): Promise<string[]> => this.mutex.runExclusive(`snapshot-language:${overlayKey}`, async () => {
      let fencedJobFinalized = false;
      const fenceForWrite = (): AnalysisLeaseFence | undefined =>
        input.fence && !fencedJobFinalized ? input.fence : undefined;
      await this.saveSnapshotLanguageOverlayWithAnalysisLease({
        publicKey: input.publicKey,
        language,
        status: input.status,
        payload: input.payload,
        error: input.error ?? null,
      }, fenceForWrite());
      const jobs = (await this.listJobs()).filter((row) =>
        row.language_overlay_key === overlayKey
        && (row.status === "queued" || row.status === "running"));
      for (const job of jobs) {
        const project = await this.loadProject(job.project_id);
        if (project) {
          await this.updateProjectLocked(project.project_id, project.owner_id, (row) => {
            recordAnalysisProgress(row.analysis, "interpreting", "completed", input.completedAt);
            recordAnalysisProgress(row.analysis, "completed", input.status === "degraded" ? "degraded" : "completed", input.completedAt);
            row.analysis.stage = "done";
            row.analysis.error = null;
            row.analysis.completed_at = input.completedAt;
            if (row.repository_migration?.status === "confirmed"
              && row.repository_migration.to_public_snapshot_key === input.publicKey) {
              row.repository_migration.status = "executed";
              row.repository_migration.executed_at = input.completedAt;
              row.repository_migration.resolved_at ??= input.completedAt;
              row.repository_migration.error = null;
            }
          }, fenceForWrite());
        }
        await this.saveJobWithAnalysisLease({ ...job, status: "succeeded", lease_owner: null, lease_expires_at: null, heartbeat_at: input.completedAt, completed_at: input.completedAt, updated_at: input.completedAt, error: null, error_code: null }, fenceForWrite());
        if (input.fence?.jobId === job.job_id) fencedJobFinalized = true;
      }
      return jobs.map((job) => job.project_id);
    });
    return this.withAnalysisLease(input.fence, run);
  }

  async failSnapshotLanguageOverlay(publicKey: string, languageValue: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]> {
    const language = languageKey(normalizeDisplayLanguage(languageValue));
    const overlayKey = snapshotLanguageOverlayKey(publicKey, language);
    const run = (): Promise<string[]> => this.mutex.runExclusive(`snapshot-language:${overlayKey}`, async () => {
      let fencedJobFinalized = false;
      const fenceForWrite = (): AnalysisLeaseFence | undefined =>
        fence && !fencedJobFinalized ? fence : undefined;
      const timestamp = nowIso();
      await this.saveSnapshotLanguageOverlayWithAnalysisLease({ publicKey, language, status: "failed", payload: null, error }, fenceForWrite());
      const jobs = (await this.listJobs()).filter((row) => row.language_overlay_key === overlayKey && (row.status === "queued" || row.status === "running"));
      for (const job of jobs) {
        const project = await this.loadProject(job.project_id);
        if (project) {
          await this.updateProjectLocked(project.project_id, project.owner_id, (row) => {
            recordAnalysisProgress(row.analysis, "failed", "failed", timestamp);
            row.analysis.stage = "failed";
            row.analysis.error = error;
            row.analysis.completed_at = timestamp;
            if (row.repository_migration?.status === "confirmed"
              && row.repository_migration.to_public_snapshot_key === publicKey) {
              row.repository_migration.status = "failed";
              row.repository_migration.error = error;
              row.repository_migration.resolved_at ??= timestamp;
            }
          }, fenceForWrite());
        }
        await this.saveJobWithAnalysisLease({ ...job, status: "failed", lease_owner: null, lease_expires_at: null, heartbeat_at: timestamp, completed_at: timestamp, updated_at: timestamp, error, error_code: "language_overlay_failed" }, fenceForWrite());
        if (fence?.jobId === job.job_id) fencedJobFinalized = true;
      }
      return jobs.map((job) => job.project_id);
    });
    return this.withAnalysisLease(fence, run);
  }

  async saveRevisionRedirects(redirects: RevisionRedirect[]): Promise<void> {
    await this.saveRevisionRedirectsWithAnalysisLease(redirects);
  }

  async saveRevisionLink(link: RevisionLink): Promise<void> {
    await this.saveRevisionLinkWithAnalysisLease(link);
  }

  async listRevisionLinks(repositoryIdentity: string): Promise<RevisionLink[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.revisionLinks).catch(() => [] as string[]);
    const rows = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<RevisionLink>(join(this.dirs.revisionLinks, name))));
    return rows.filter((row): row is RevisionLink => Boolean(row && row.repository_identity === repositoryIdentity.toLowerCase())).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listRevisionRedirects(repositoryIdentity: string): Promise<RevisionRedirect[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.revisionRedirects).catch(() => [] as string[]);
    const rows = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<RevisionRedirect>(join(this.dirs.revisionRedirects, name))));
    return rows.filter((row): row is RevisionRedirect => Boolean(row && row.repository_identity === repositoryIdentity.toLowerCase()));
  }

  async resolveRevisionRedirect(input: {
    fromPublicKey: string;
    toPublicKey: string;
    oldPath: string;
    oldStableId?: string | null;
  }): Promise<RevisionRedirect | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.revisionRedirects).catch(() => [] as string[]);
    const redirects = (await Promise.all(names
      .filter((item) => item.endsWith(".json"))
      .map((name) => readJson<RevisionRedirect>(join(this.dirs.revisionRedirects, name))))
    ).filter((row): row is RevisionRedirect => Boolean(row));
    const links = await this.listRevisionLinksForRedirects(redirects, input.fromPublicKey, input.toPublicKey);
    return resolveRevisionRedirectChain({ ...input, links, redirects });
  }

  private async listRevisionLinksForRedirects(
    redirects: RevisionRedirect[],
    fromPublicKey: string,
    toPublicKey: string,
  ): Promise<RevisionLink[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.revisionLinks).catch(() => [] as string[]);
    const links = (await Promise.all(names
      .filter((item) => item.endsWith(".json"))
      .map((name) => readJson<RevisionLink>(join(this.dirs.revisionLinks, name))))
    ).filter((row): row is RevisionLink => Boolean(row));
    const repository = redirects.find((row) => row.from_public_snapshot_key === fromPublicKey)?.repository_identity
      ?? links.find((row) => row.from_public_snapshot_key === fromPublicKey)?.repository_identity;
    if (!repository) return [];
    return links.filter((row) => row.repository_identity === repository);
  }

  async findPublicSnapshotKeyBySnapshotId(snapshotId: string): Promise<string | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.publicSnapshots).catch(() => [] as string[]);
    for (const name of names.filter((item) => /^[0-9a-f]{64}$/i.test(item))) {
      const metadata = await readJson<Record<string, unknown>>(join(this.dirs.publicSnapshots, name, "metadata.json"));
      if (String(metadata?.analysis_snapshot_id ?? "") === snapshotId) return name.toLowerCase();
    }
    return null;
  }

  private async hasPublicSnapshotReference(publicKey: string): Promise<boolean> {
    const normalizedKey = safePublicKey(publicKey);
    const { readdir } = await import("node:fs/promises");
    const projectNames = await readdir(this.dirs.projects).catch(() => [] as string[]);
    for (const name of projectNames.filter((item) => item.endsWith(".json"))) {
      const project = await readJson<Project>(join(this.dirs.projects, name));
      if (project?.analysis.canonical_snapshot_key?.toLowerCase() === normalizedKey) return true;
    }
    const headNames = await readdir(this.dirs.repositoryHeads).catch(() => [] as string[]);
    for (const name of headNames.filter((item) => item.endsWith(".json"))) {
      const head = await readJson<RepositoryHead>(join(this.dirs.repositoryHeads, name));
      if (head?.current_public_snapshot_key?.toLowerCase() === normalizedKey) return true;
    }
    return false;
  }

  async listPurgeablePublicSnapshots(now: string): Promise<PublicSnapshotMetadata[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.publicSnapshots).catch(() => [] as string[]);
    const result: PublicSnapshotMetadata[] = [];
    for (const name of names.filter((item) => /^[0-9a-f]{64}$/i.test(item))) {
      const metadata = await this.loadPublicSnapshotMetadata(name);
      if (
        metadata?.purge_after
        && metadata.payload_purged_at === null
        && metadata.purge_after <= now
        && !(await this.hasPublicSnapshotReference(name))
      ) result.push(metadata);
    }
    return result;
  }

  async purgePublicSnapshotPayload(publicKey: string, purgedAt: string): Promise<boolean> {
    return this.mutex.runExclusive(`snapshot-purge:${safePublicKey(publicKey)}`, async () => {
      const metadata = await this.loadPublicSnapshotMetadata(publicKey);
      if (!metadata || metadata.payload_purged_at || await this.hasPublicSnapshotReference(publicKey)) return false;
      const directory = join(this.dirs.publicSnapshots, safePublicKey(publicKey));
      await Promise.all([
        rm(join(directory, "view.json"), { force: true }),
        rm(join(directory, "analysis.json"), { force: true }),
        rm(join(directory, "analysis-chunks"), { recursive: true, force: true }),
        rm(this.publicSourceSnapshotRoot(publicKey, metadata.analysis_snapshot_id), { recursive: true, force: true }),
      ]);
      const raw = await readJson<Record<string, unknown>>(join(directory, "metadata.json"));
      if (!raw) return false;
      raw.payload_purged_at = purgedAt;
      await writeJson(join(directory, "metadata.json"), raw);
      return true;
    });
  }

  async executeRepositoryMigration(input: {
    projectId: string;
    ownerId: string;
    migrationId: string;
    routeReplanned?: boolean;
    summary?: string | null;
    migration?: import("../domain/lifecycle.js").RepositoryMigrationAction;
  }): Promise<Project | null> {
    return this.mutex.runExclusive(`project:${input.projectId}`, async () => {
      const project = await this.loadProject(input.projectId, input.ownerId);
      const migration = input.migration ?? project?.repository_migration;
      if (!project || !migration || migration.migration_id !== input.migrationId) return null;
      if (!input.migration && migration.status === "executed") return project;
      if (migration.status !== "pending" && migration.status !== "confirmed") throw new Error("repository_migration_not_pending");
      const metadata = await this.loadPublicSnapshotMetadata(migration.to_public_snapshot_key);
      const snapshot = await this.loadPublicSnapshot<Record<string, unknown>>(migration.to_public_snapshot_key);
      if (!metadata || !snapshot) throw new Error("repository_migration_target_missing");
      const summary = snapshot.view && typeof snapshot.view === "object" && !Array.isArray(snapshot.view)
        ? (snapshot.view as Record<string, unknown>).summary as Record<string, unknown> | undefined
        : undefined;
      const languages = snapshot.view && typeof snapshot.view === "object" && !Array.isArray(snapshot.view)
        && Array.isArray((snapshot.view as Record<string, unknown>).languages)
        ? (snapshot.view as Record<string, unknown>).languages as Array<{ language?: unknown }>
        : [];
      const overlay = metadata.language_overlay_version
        ? await this.loadSnapshotLanguageOverlay(
          migration.to_public_snapshot_key,
          normalizeDisplayLanguage(project.display_language),
        )
        : null;
      const overlayReady = !metadata.language_overlay_version
        || overlay?.status === "ready"
        || overlay?.status === "degraded";
      const timestamp = nowIso();
      project.analysis = {
        ...project.analysis,
        stage: overlayReady ? "done" : "interpreting",
        snapshot_id: metadata.analysis_snapshot_id,
        file_count: Number(summary?.file_count ?? project.analysis.file_count),
        symbol_count: Number(summary?.symbol_count ?? project.analysis.symbol_count),
        call_count: Number(summary?.call_count ?? project.analysis.call_count),
        languages: languages.map((row) => typeof row.language === "string" ? row.language : "").filter(Boolean),
        error: null,
        canonical_snapshot_key: migration.to_public_snapshot_key,
        completed_at: overlayReady ? timestamp : null,
      };
      project.source.commit_sha = metadata.commit_sha;
      project.repository_migration = {
        ...migration,
        status: "executed",
        route_replanned: input.routeReplanned ?? migration.route_replanned,
        summary: input.summary ?? migration.summary,
        resolved_at: timestamp,
        executed_at: timestamp,
        error: null,
      };
      project.updated_at = timestamp;
      await this.saveProject(project);
      return project;
    });
  }

  async saveJob(job: AnalysisJob): Promise<void> { await writeJson(this.path("jobs", job.job_id), job); }
  async loadJob(jobId: string): Promise<AnalysisJob | null> { return readJson<AnalysisJob>(this.path("jobs", jobId)); }
  async listJobs(): Promise<AnalysisJob[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.jobs).catch(() => [] as string[]);
    const rows = await mapWithConcurrency(
      names.filter((name) => name.endsWith(".json")),
      16,
      (name) => readJson<AnalysisJob>(join(this.dirs.jobs, name)),
    );
    return rows.filter((row): row is AnalysisJob => Boolean(row));
  }
  async latestJob(projectId: string): Promise<AnalysisJob | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.jobs).catch(() => [] as string[]);
    const rows = await mapWithConcurrency(
      names.filter((name) => name.endsWith(".json")),
      16,
      (name) => readJson<AnalysisJob>(join(this.dirs.jobs, name)),
    );
    return rows.filter((row): row is AnalysisJob => Boolean(row && row.project_id === projectId)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  }

  async cancelAnalysisJob(
    projectId: string,
    ownerId: string,
    expectedJobId?: string,
  ): Promise<AnalysisJob | null> {
    const project = await this.loadProject(projectId, ownerId);
    if (!project) return null;
    const candidate = (await this.listJobs())
      .filter((job) => job.project_id === projectId
        && (job.status === "queued" || job.status === "running")
        && (!expectedJobId || job.job_id === expectedJobId))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (!candidate) return null;

    // Workers acquire the job lease before repository/project locks. Keep the
    // same order here so cancellation cannot deadlock a fenced publication.
    return this.mutex.runExclusive(this.analysisLeaseKey(candidate.job_id), async () => {
      const current = await this.loadJob(candidate.job_id);
      if (!current
        || current.project_id !== projectId
        || (expectedJobId && current.job_id !== expectedJobId)
        || (current.status !== "queued" && current.status !== "running")) return null;
      const ownedProject = await this.loadProject(projectId, ownerId);
      if (!ownedProject) return null;
      const timestamp = nowIso();
      if (current.repository_update_id) {
        const update = await readJson<RepositoryUpdate>(this.path("repositoryUpdates", current.repository_update_id));
        if (update) {
          await this.mutex.runExclusive(this.repositoryUpdateMutexKey(update), async () => {
            await this.cancelRepositoryUpdateMembership(update.update_id, projectId, current.job_id, timestamp);
          });
        }
      } else if (current.language_overlay_key) {
        await this.mutex.runExclusive(`snapshot-language:${current.language_overlay_key}`, async () => {
          await this.cancelSnapshotLanguageJob(current.language_overlay_key as string, current.job_id, timestamp);
        });
      }
      await this.updateProjectLocked(projectId, ownerId, (row) => {
        recordAnalysisProgress(row.analysis, "cancelled", "cancelled", timestamp);
        row.analysis.stage = "failed";
        row.analysis.error = "分析已停止，可重新分析。";
        row.analysis.completed_at = timestamp;
      });
      const cancelled: AnalysisJob = {
        ...current,
        status: "cancelled",
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: timestamp,
        updated_at: timestamp,
        completed_at: timestamp,
        error: "分析已停止，可重新分析。",
        error_code: "analysis_cancelled",
      };
      await this.saveJob(cancelled);
      return cancelled;
    });
  }

  async claimAnalysisJob(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null> {
    return this.mutex.runExclusive("analysis-job-claim", async () => {
      let now = nowIso();
      let jobs = await this.listJobs();
      for (const expired of jobs.filter((job) =>
        job.status === "running"
        && job.attempt >= job.max_attempts
        && job.lease_expires_at !== null
        && job.lease_expires_at <= now)) {
        await this.mutex.runExclusive(this.analysisLeaseKey(expired.job_id), async () => {
          const current = await this.loadJob(expired.job_id);
          if (!current
            || current.status !== "running"
            || current.attempt < current.max_attempts
            || !current.lease_expires_at
            || current.lease_expires_at > now) return;
          await this.saveJob({
            ...current,
            status: "failed",
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: now,
            updated_at: now,
            completed_at: now,
            error: "analysis job lease expired after maximum attempts",
            error_code: "lease_attempts_exhausted",
          });
        });
      }
      jobs = await this.listJobs();
      const candidates = jobs
        .filter((job) => job.attempt < job.max_attempts && job.available_at <= now && (
          job.execution_role !== "waiter" && (
          job.status === "queued"
          || (job.status === "running" && job.lease_expires_at !== null && job.lease_expires_at <= now)
          )
        ))
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
      for (const candidate of candidates) {
        const claimed = await this.mutex.runExclusive(this.analysisLeaseKey(candidate.job_id), async () => {
          const current = await this.loadJob(candidate.job_id);
          now = nowIso();
          if (!current || current.attempt >= current.max_attempts || current.available_at > now
            || current.execution_role === "waiter"
            || (current.status !== "queued"
              && !(current.status === "running" && current.lease_expires_at !== null && current.lease_expires_at <= now))) {
            return null;
          }
          const claimedJob: AnalysisJob = {
            ...current,
            status: "running",
            attempt: current.attempt + 1,
            lease_owner: workerId,
            lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
            heartbeat_at: now,
            updated_at: now,
            completed_at: null,
            error: null,
            error_code: null,
          };
          await this.saveJob(claimedJob);
          return claimedJob;
        });
        if (claimed) return claimed;
      }
      return null;
    });
  }

  async heartbeatAnalysisJob(
    jobId: string,
    workerId: string,
    attempt: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    return this.mutex.runExclusive(this.analysisLeaseKey(jobId), async () => {
      const current = await this.loadJob(jobId);
      if (!current || current.status !== "running" || current.lease_owner !== workerId || current.attempt !== attempt) return false;
      const now = nowIso();
      if (!current.lease_expires_at || current.lease_expires_at <= now) return false;
      await this.saveJob({
        ...current,
        heartbeat_at: now,
        lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        updated_at: now,
      });
      return true;
    });
  }

  async finishAnalysisJob(job: AnalysisJob, workerId: string, attempt: number): Promise<boolean> {
    return this.mutex.runExclusive(this.analysisLeaseKey(job.job_id), async () => {
      const current = await this.loadJob(job.job_id);
      if (!current || current.status !== "running" || current.lease_owner !== workerId || current.attempt !== attempt) return false;
      const expiresAt = current.lease_expires_at ? Date.parse(current.lease_expires_at) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
      await this.saveJob(job);
      return true;
    });
  }

  async releaseAnalysisJobForResume(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    return this.mutex.runExclusive(this.analysisLeaseKey(jobId), async () => {
      const current = await this.loadJob(jobId);
      if (!current || current.status !== "running" || current.lease_owner !== workerId || current.attempt !== attempt) return false;
      const timestamp = nowIso();
      await this.saveJob({
        ...current,
        status: "queued",
        attempt: Math.max(0, current.attempt - 1),
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        available_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
        error: null,
        error_code: null,
      });
      return true;
    });
  }

  async saveSemanticBatch(batch: SemanticBatch, fence?: AnalysisLeaseFence): Promise<void> {
    await this.withAnalysisLease(fence, () => this.writeJsonWithAnalysisLease(
      this.semanticBatchPath(batch.job_id, batch.batch_id),
      batch,
      fence,
    ));
  }

  async loadSemanticBatch(jobId: string, batchId: string): Promise<SemanticBatch | null> {
    return readJson<SemanticBatch>(this.semanticBatchPath(jobId, batchId));
  }

  async listSemanticBatches(jobId: string): Promise<SemanticBatch[]> {
    const { readdir } = await import("node:fs/promises");
    const prefix = `${safeId(jobId)}--`;
    const names = await readdir(this.dirs.semanticBatches).catch(() => [] as string[]);
    const rows = await mapWithConcurrency(
      names.filter((name) => name.startsWith(prefix) && name.endsWith(".json")),
      16,
      (name) => readJson<SemanticBatch>(join(this.dirs.semanticBatches, name)),
    );
    return rows
      .filter((row): row is SemanticBatch => Boolean(row && row.job_id === jobId))
      .sort((left, right) => left.ordinal - right.ordinal || left.batch_id.localeCompare(right.batch_id));
  }

  async cancelSemanticBatches(
    jobId: string,
    reason: string,
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    const cancel = async (): Promise<void> => {
      const timestamp = nowIso();
      for (const batch of await this.listSemanticBatches(jobId)) {
        if (batch.status !== "pending" && batch.status !== "running") continue;
        await this.writeJsonWithAnalysisLease(this.semanticBatchPath(jobId, batch.batch_id), {
          ...batch,
          status: "cancelled",
          error: reason,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: timestamp,
          completed_at: timestamp,
        } satisfies SemanticBatch, fence);
      }
    };
    if (fence) {
      await this.withAnalysisLease(fence, cancel);
      return;
    }
    await this.mutex.runExclusive(`semantic-batches:${jobId}`, cancel);
  }

  async saveProfile(ownerId: string, profile: LearnerProfile): Promise<void> { await writeJson(this.path("profiles", ownerId), profile); }
  async loadProfile(ownerId: string): Promise<LearnerProfile> {
    return normalizeProfile(await readJson<unknown>(this.path("profiles", ownerId)));
  }
  async saveSettings(ownerId: string, settings: ProviderSettings): Promise<void> { await writeJson(this.path("settings", ownerId), settings); }
  async loadSettings(ownerId: string): Promise<ProviderSettings> {
    return normalizeSettings(await readJson<unknown>(this.path("settings", ownerId)));
  }
  async saveUser(ownerId: string, payload: Record<string, unknown>): Promise<void> {
    const existing = await this.loadUser(ownerId);
    await writeJson(this.path("users", ownerId), {
      ...(existing ?? {}),
      ...payload,
      owner_id: ownerId,
      last_seen_at: typeof payload.last_seen_at === "string"
        ? payload.last_seen_at
        : typeof existing?.last_seen_at === "string" ? existing.last_seen_at : nowIso(),
    });
  }
  async loadUser(ownerId: string): Promise<Record<string, unknown> | null> { return readJson<Record<string, unknown>>(this.path("users", ownerId)); }
  async touchOwner(ownerId: string, seenAt: string, minimumIntervalMs: number): Promise<OwnerLifecycle | null> {
    return this.mutex.runExclusive(`owner:${ownerId}`, async () => {
      const user = await this.loadUser(ownerId);
      if (!user) return null;
      const purgeAfter = typeof user.purge_after === "string" ? user.purge_after : null;
      if (purgeAfter && Date.parse(purgeAfter) <= Date.parse(seenAt)) return null;
      const previous = typeof user.last_seen_at === "string" ? user.last_seen_at : null;
      if (!previous || Date.parse(seenAt) - Date.parse(previous) >= minimumIntervalMs) user.last_seen_at = seenAt;
      // A request during the recovery window restores a soft-deleted guest.
      if (user.deleted_at) {
        user.deleted_at = null;
        user.purge_after = null;
      }
      await this.saveUser(ownerId, user);
      return {
        owner_id: ownerId,
        last_seen_at: String(user.last_seen_at ?? seenAt),
        deleted_at: typeof user.deleted_at === "string" ? user.deleted_at : null,
        purge_after: typeof user.purge_after === "string" ? user.purge_after : null,
      };
    });
  }

  async listGuestRetentionCandidates(now: string): Promise<GuestRetentionCandidate[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.users).catch(() => [] as string[]);
    const jobs = await this.listJobs();
    const candidates: GuestRetentionCandidate[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const user = await readJson<Record<string, unknown>>(join(this.dirs.users, name));
      const ownerId = typeof user?.owner_id === "string" ? user.owner_id : "";
      if (!ownerId.startsWith("guest:")) continue;
      const lastSeen = Date.parse(typeof user?.last_seen_at === "string" ? user.last_seen_at : "1970-01-01T00:00:00.000Z");
      const projects = await this.listProjects(ownerId);
      const active = jobs.some((job) => projects.some((project) => project.project_id === job.project_id) && (job.status === "queued" || job.status === "running"));
      if (active) continue;
      const deletedAt = typeof user?.deleted_at === "string" ? user.deleted_at : null;
      const purgeAfter = typeof user?.purge_after === "string" ? user.purge_after : null;
      if (deletedAt && purgeAfter && purgeAfter <= now) candidates.push({ owner_id: ownerId, action: "delete", project_count: projects.length });
      else if (!projects.length && lastSeen <= Date.parse(now) - 7 * 24 * 60 * 60 * 1000) candidates.push({ owner_id: ownerId, action: "delete", project_count: 0 });
      else if (projects.length && lastSeen <= Date.parse(now) - 30 * 24 * 60 * 60 * 1000) candidates.push({ owner_id: ownerId, action: "soft_delete", project_count: projects.length });
    }
    return candidates;
  }

  async softDeleteGuestOwner(ownerId: string, deletedAt: string, purgeAfter: string): Promise<boolean> {
    return this.mutex.runExclusive(`owner:${ownerId}`, async () => {
      const user = await this.loadUser(ownerId);
      if (!user || !ownerId.startsWith("guest:")) return false;
      const projects = await this.listProjects(ownerId);
      const jobs = await this.listJobs();
      if (jobs.some((job) => projects.some((project) => project.project_id === job.project_id) && (job.status === "queued" || job.status === "running"))) return false;
      user.deleted_at = deletedAt;
      user.purge_after = purgeAfter;
      await this.saveUser(ownerId, user);
      return true;
    });
  }

  async deleteOwner(ownerId: string): Promise<boolean> {
    return this.mutex.runExclusive(`owner:${ownerId}`, async () => {
      const user = await this.loadUser(ownerId);
      if (!user) return false;
      const projects = await this.listProjects(ownerId);
      const jobs = await this.listJobs();
      if (jobs.some((job) => projects.some((project) => project.project_id === job.project_id)
        && (job.status === "queued" || job.status === "running"))) return false;
      for (const project of projects) await this.deleteProject(project.project_id, ownerId);
      const { readdir } = await import("node:fs/promises");
      for (const [directory, kind] of [
        [this.dirs.jobs, "other"],
        [this.dirs.traces, "other"],
        [this.dirs.evolutionFeedbackRequests, "feedback"],
        [join(this.root, "quota-events"), "other"],
      ] as const) {
        for (const name of await readdir(directory).catch(() => [] as string[])) {
          if (!name.endsWith(".json")) continue;
          const path = join(directory, name);
          const payload = await readJson<Record<string, unknown>>(path);
          if (kind === "feedback" && (payload?.owner_id === ownerId
            || payload?.source_owner_id === ownerId
            || (Array.isArray(payload?.owner_ids) && payload.owner_ids.includes(ownerId)))) {
            const next = removeOwnerFromEvolutionFeedbackRequest(payload as unknown as EvolutionFeedbackRequest, ownerId);
            if (next) await writeJson(path, next);
            else await rm(path, { force: true });
          } else if (payload?.owner_id === ownerId
            || payload?.source_owner_id === ownerId
            || (Array.isArray(payload?.owner_ids) && payload.owner_ids.includes(ownerId))) {
            await rm(path, { force: true });
          }
        }
      }
      await Promise.all([
        rm(this.path("users", ownerId), { force: true }),
        rm(this.path("profiles", ownerId), { force: true }),
        rm(this.path("settings", ownerId), { force: true }),
        this.keys.clear(ownerId),
      ]);
      return true;
    });
  }

  async mergeOwners(input: { sourceOwnerId: string; targetOwnerId: string; memoryCount?: number; sessionCount?: number }): Promise<OwnerMergeSummary> {
    if (input.sourceOwnerId === input.targetOwnerId) throw new Error("owner_merge_same_owner");
    return this.mutex.runExclusive(`owner-merge:${[input.sourceOwnerId, input.targetOwnerId].sort().join(":")}`, async () => {
      const source = await this.loadUser(input.sourceOwnerId);
      const target = await this.loadUser(input.targetOwnerId);
      if (!source || !target) throw new Error("owner_not_found");
      const projects = await this.listProjects(input.sourceOwnerId);
      for (const project of projects) {
        project.owner_id = input.targetOwnerId;
        await this.saveProject(project);
      }
      const sourceProfile = await this.loadProfile(input.sourceOwnerId);
      const targetProfile = await this.loadProfile(input.targetOwnerId);
      const mergedProfile: LearnerProfile = {
        ...targetProfile,
        enabled: targetProfile.enabled && sourceProfile.enabled,
        languages: [...new Set([...targetProfile.languages, ...sourceProfile.languages])].slice(0, 50),
        goals: [...new Set([...targetProfile.goals, ...sourceProfile.goals])].slice(0, 50),
        explanation_preference: targetProfile.explanation_preference || sourceProfile.explanation_preference,
        experience_level: targetProfile.experience_level || sourceProfile.experience_level,
        inferred: [...targetProfile.inferred, ...sourceProfile.inferred]
          .filter((claim, index, all) => all.findIndex((row) => row.claim_id === claim.claim_id) === index)
          .slice(-200),
        last_inferred_message_id: targetProfile.last_inferred_message_id ?? sourceProfile.last_inferred_message_id ?? null,
        updated_at: nowIso(),
        memory_summary: targetProfile.memory_summary_mode === "edited"
          ? targetProfile.memory_summary
          : sourceProfile.memory_summary_mode === "edited"
            ? sourceProfile.memory_summary
            : "",
        memory_summary_mode: targetProfile.memory_summary_mode === "edited" || sourceProfile.memory_summary_mode === "edited"
          ? "edited"
          : "generated",
        memory_summary_updated_at: targetProfile.memory_summary_mode === "edited"
          ? targetProfile.memory_summary_updated_at
          : sourceProfile.memory_summary_mode === "edited"
            ? sourceProfile.memory_summary_updated_at
            : null,
      };
      await this.saveProfile(input.targetOwnerId, mergedProfile);
      const sourceSettings = await this.loadSettings(input.sourceOwnerId);
      const targetSettings = await this.loadSettings(input.targetOwnerId);
      const connectionIds = new Set([
        "legacy",
        ...sourceSettings.connections.map((connection) => connection.connection_id),
        ...targetSettings.connections.map((connection) => connection.connection_id),
      ]);
      for (const connectionId of connectionIds) {
        const sourceKey = this.keys.get(input.sourceOwnerId, connectionId);
        if (sourceKey && !this.keys.get(input.targetOwnerId, connectionId)) {
          await this.keys.set(input.targetOwnerId, sourceKey, connectionId);
        }
      }
      await this.saveSettings(input.targetOwnerId, {
        ...targetSettings,
        model: targetSettings.model || sourceSettings.model,
        thinking_level: targetSettings.model ? targetSettings.thinking_level : sourceSettings.thinking_level,
        connections: [
          ...targetSettings.connections,
          ...sourceSettings.connections.filter((row) => !targetSettings.connections.some((item) => item.connection_id === row.connection_id)),
        ],
      });
      const { readdir } = await import("node:fs/promises");
      let traces = 0;
      let feedbackRequests = 0;
      for (const [directory, kind] of [[this.dirs.traces, "trace"], [this.dirs.evolutionFeedbackRequests, "feedback"], [join(this.root, "quota-events"), "quota"]] as const) {
        for (const name of await readdir(directory).catch(() => [] as string[])) {
          if (!name.endsWith(".json")) continue;
          const path = join(directory, name);
          const payload = await readJson<Record<string, unknown>>(path);
          const ownerIds = Array.isArray(payload?.owner_ids)
            ? payload.owner_ids.filter((value): value is string => typeof value === "string")
            : [];
          if (!payload || (payload.owner_id !== input.sourceOwnerId
            && payload.source_owner_id !== input.sourceOwnerId
            && !ownerIds.includes(input.sourceOwnerId))) continue;
          if (payload.owner_id === input.sourceOwnerId) payload.owner_id = input.targetOwnerId;
          if (payload.source_owner_id === input.sourceOwnerId) payload.source_owner_id = input.targetOwnerId;
          if (ownerIds.includes(input.sourceOwnerId)) {
            payload.owner_ids = [...new Set(ownerIds.map((value) => value === input.sourceOwnerId ? input.targetOwnerId : value))].slice(0, 100);
          }
          await writeJson(path, payload);
          if (kind === "trace") traces += 1;
          if (kind === "feedback") feedbackRequests += 1;
        }
      }
      const summary: OwnerMergeSummary = {
        source_owner_id: input.sourceOwnerId,
        target_owner_id: input.targetOwnerId,
        projects: projects.length,
        messages: projects.reduce((sum, project) => sum + project.messages.length, 0),
        memories: input.memoryCount ?? 0,
        sessions: input.sessionCount ?? 0,
        traces,
        feedback_requests: feedbackRequests,
        merged_at: nowIso(),
      };
      target.merge_receipt = summary;
      await this.saveUser(input.targetOwnerId, target);
      await rm(this.path("users", input.sourceOwnerId), { force: true });
      await rm(this.path("profiles", input.sourceOwnerId), { force: true });
      await rm(this.path("settings", input.sourceOwnerId), { force: true });
      await this.keys.clear(input.sourceOwnerId);
      return summary;
    });
  }

  async consumeOwnerMergeReceipt(ownerId: string): Promise<OwnerMergeSummary | null> {
    const user = await this.loadUser(ownerId);
    const receipt = user?.merge_receipt as OwnerMergeSummary | undefined;
    if (!receipt) return null;
    delete user!.merge_receipt;
    // `saveUser` intentionally merges with the existing record. That is useful
    // for partial updates, but would put a consumed receipt back into the file.
    // Rewrite the complete record here so the one-shot contract is real.
    await writeJson(this.path("users", ownerId), {
      ...user,
      owner_id: ownerId,
      last_seen_at: typeof user!.last_seen_at === "string" ? user!.last_seen_at : nowIso(),
    });
    return receipt;
  }
  async saveTrace(eventId: string, payload: unknown, fence?: AnalysisLeaseFence): Promise<void> {
    await this.withAnalysisLease(fence, () => this.writeJsonWithAnalysisLease(this.path("traces", eventId), payload, fence));
  }
  async listTraces(projectId: string): Promise<Record<string, unknown>[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.traces).catch(() => [] as string[]);
    const rows = await mapWithConcurrency(
      names.filter((name) => name.endsWith(".json")),
      16,
      (name) => readJson<Record<string, unknown>>(join(this.dirs.traces, name)),
    );
    return rows.filter((row): row is Record<string, unknown> => Boolean(row && row.project_id === projectId));
  }
  async listRunTraces(projectId: string, runId: string): Promise<Record<string, unknown>[]> {
    const finalTrace = await readJson<Record<string, unknown>>(this.path("traces", runId));
    if (
      finalTrace
      && finalTrace.project_id === projectId
      && (finalTrace.run_id === runId || finalTrace.trace_id === runId)
      && Array.isArray(finalTrace.events)
    ) return [finalTrace];
    return [];
  }

  async saveEvolutionFeedbackRequest(request: EvolutionFeedbackRequest): Promise<void> {
    await writeJson(this.path("evolutionFeedbackRequests", request.request_id), request);
  }

  async upsertEvolutionFeedbackRequest(
    request: EvolutionFeedbackRequest,
  ): Promise<EvolutionFeedbackRequest> {
    return this.mutex.runExclusive("evolution-feedback-queue", async () => {
      const existing = (await this.listEvolutionFeedbackRequests("pending"))
        .find((row) => row.dedupe_key === request.dedupe_key);
      const next = existing ? mergeEvolutionFeedbackRequests(existing, request) : request;
      await this.saveEvolutionFeedbackRequest(next);
      return next;
    });
  }

  async loadEvolutionFeedbackRequest(requestId: string): Promise<EvolutionFeedbackRequest | null> {
    return readJson<EvolutionFeedbackRequest>(this.path("evolutionFeedbackRequests", requestId));
  }

  async listEvolutionFeedbackRequests(
    status?: EvolutionFeedbackRequestStatus,
  ): Promise<EvolutionFeedbackRequest[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.evolutionFeedbackRequests).catch(() => [] as string[]);
    const rows = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJson<EvolutionFeedbackRequest>(join(this.dirs.evolutionFeedbackRequests, name))),
    );
    return rows
      .filter((row): row is EvolutionFeedbackRequest => Boolean(row && (!status || row.status === status)))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async updateEvolutionFeedbackRequest(
    requestId: string,
    mutate: (request: EvolutionFeedbackRequest) => void,
  ): Promise<EvolutionFeedbackRequest | null> {
    return this.mutex.runExclusive(`evolution-feedback:${requestId}`, async () => {
      const request = await this.loadEvolutionFeedbackRequest(requestId);
      if (!request) return null;
      mutate(request);
      request.updated_at = nowIso();
      await this.saveEvolutionFeedbackRequest(request);
      return request;
    });
  }

  private async removeProjectArtifacts(projectId: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    for (const directory of [this.dirs.jobs, this.dirs.traces, this.dirs.evolutionFeedbackRequests, join(this.root, "quota-events")]) {
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        const path = join(directory, name);
        const payload = await readJson<Record<string, unknown>>(path);
        if (payload?.project_id === projectId) {
          await rm(path, { force: true });
        }
      }
    }
    for (const name of await readdir(this.dirs.repositoryUpdateProjects).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dirs.repositoryUpdateProjects, name);
      const payload = await readJson<Record<string, unknown>>(path);
      if (payload?.project_id === projectId) await rm(path, { force: true });
    }
  }

  private async reconcileRepositoryUpdatesAfterProjectRemoval(projectId: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.dirs.repositoryUpdates).catch(() => [] as string[]);
    const jobs = await this.listJobs();
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const update = await readJson<RepositoryUpdate>(join(this.dirs.repositoryUpdates, name));
      if (!update) continue;
      const remaining = await this.listRepositoryUpdateProjects(update.update_id);
      if (!remaining.length) {
        await rm(this.path("repositoryUpdates", update.update_id), { force: true });
        continue;
      }
      if (update.leader_project_id !== projectId) continue;
      const replacement = remaining[0];
      await writeJson(this.path("repositoryUpdates", update.update_id), {
        ...update,
        leader_project_id: replacement.project_id,
        updated_at: nowIso(),
      });
      const replacementJob = jobs.find((job) =>
        job.project_id === replacement.project_id
        && job.repository_update_id === update.update_id
        && (job.status === "queued" || job.status === "running"));
      if (replacementJob && replacementJob.execution_role === "waiter") {
        await this.saveJob({ ...replacementJob, execution_role: "leader", updated_at: nowIso() });
      }
    }
  }

  private async cancelRepositoryUpdateMembership(
    updateId: string,
    projectId: string,
    cancelledJobId: string,
    timestamp: string,
  ): Promise<void> {
    const update = await readJson<RepositoryUpdate>(this.path("repositoryUpdates", updateId));
    if (!update) return;
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(this.dirs.repositoryUpdateProjects).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dirs.repositoryUpdateProjects, name);
      const row = await readJson<{ project_id?: string; update_id?: string }>(path);
      if (row?.update_id === updateId && row.project_id === projectId) await rm(path, { force: true });
    }
    const jobs = (await this.listJobs()).filter((job) => job.repository_update_id === updateId);
    const active = jobs
      .filter((job) => job.job_id !== cancelledJobId && (job.status === "queued" || job.status === "running"))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    if (!active.length) {
      if (update.status === "queued" || update.status === "running") {
        await writeJson(this.path("repositoryUpdates", updateId), {
          ...update,
          status: "cancelled",
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: timestamp,
          error: "分析已停止，可重新分析。",
          updated_at: timestamp,
          completed_at: timestamp,
        });
      }
      return;
    }
    const wasLeader = update.leader_project_id === projectId
      || jobs.find((job) => job.job_id === cancelledJobId)?.execution_role === "leader";
    if (!wasLeader) return;
    const replacement = active.find((job) => job.execution_role === "waiter" || job.execution_role === "leader");
    if (!replacement) return;
    await writeJson(this.path("repositoryUpdates", updateId), {
      ...update,
      leader_project_id: replacement.project_id,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: timestamp,
      updated_at: timestamp,
    });
    await this.saveJob({ ...replacement, execution_role: "leader", updated_at: timestamp });
  }

  private async cancelSnapshotLanguageJob(
    overlayKey: string,
    cancelledJobId: string,
    timestamp: string,
  ): Promise<void> {
    const jobs = (await this.listJobs()).filter((job) => job.language_overlay_key === overlayKey);
    const active = jobs
      .filter((job) => job.job_id !== cancelledJobId && (job.status === "queued" || job.status === "running"))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    const cancelled = jobs.find((job) => job.job_id === cancelledJobId);
    if (active.length) {
      if (cancelled?.execution_role !== "overlay") return;
      const replacement = active.find((job) => job.execution_role === "waiter" || job.execution_role === "overlay");
      if (replacement) await this.saveJob({ ...replacement, execution_role: "overlay", updated_at: timestamp });
      return;
    }
    const [publicKey, language] = overlayKey.split(":");
    if (!publicKey || !language) return;
    const overlay = await this.loadSnapshotLanguageOverlay(publicKey, language);
    if (!overlay || overlay.status === "ready" || overlay.status === "degraded") return;
    await this.saveSnapshotLanguageOverlay({
      publicKey,
      language,
      status: "failed",
      payload: null,
      error: "分析已停止，可重新分析。",
    });
  }

  private async checkCreationQuotas(ownerId: string, includeProject: boolean): Promise<void> {
    if (includeProject && (await this.listProjects(ownerId)).length >= this.quotaLimits.maxProjects) {
      throw new QuotaExceededError("projects", this.quotaLimits.maxProjects);
    }
    const jobs = await this.listJobs();
    const ownedProjects = new Set((await this.listProjects(ownerId)).map((project) => project.project_id));
    const active = jobs.filter((job) => ownedProjects.has(job.project_id) && (job.status === "queued" || job.status === "running"));
    if (active.length >= this.quotaLimits.maxActiveAnalysisJobs) {
      throw new QuotaExceededError("active_analysis_jobs", this.quotaLimits.maxActiveAnalysisJobs);
    }
    const events = await this.readQuotaEvents(ownerId);
    const cutoff = Date.now() - 60 * 60 * 1000;
    if (events.filter((event) => Date.parse(event.created_at) >= cutoff).length >= this.quotaLimits.maxCreationsPerHour) {
      throw new QuotaExceededError("creation_rate", this.quotaLimits.maxCreationsPerHour);
    }
  }

  private async readQuotaEvents(ownerId: string): Promise<Array<{ owner_id: string; created_at: string }>> {
    const directory = join(this.root, "quota-events");
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(directory).catch(() => [] as string[]);
    const rows = await Promise.all(names.map((name) => readJson<{ owner_id: string; created_at: string }>(join(directory, name))));
    return rows.filter((row): row is { owner_id: string; created_at: string } => Boolean(row?.owner_id === ownerId));
  }

  private async writeQuotaEvent(ownerId: string, projectId: string): Promise<void> {
    const directory = join(this.root, "quota-events");
    const id = createHash("sha256").update(`${ownerId}:${projectId}:${Date.now()}:${Math.random()}`).digest("hex");
    await writeJson(join(directory, `${id}.json`), {
      event_id: id,
      owner_id: ownerId,
      project_id: projectId,
      event_kind: "analysis_create",
      created_at: nowIso(),
    });
  }
}
