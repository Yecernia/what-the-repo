import { randomUUID, createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  emptyProfile,
  emptySettings,
  normalizeProfile,
  normalizeSettings,
  nowIso,
  REPOSITORY_ANALYSIS_OWNER_ID,
  recordAnalysisProgress,
  type LearnerProfile,
  type Message,
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
  RepositoryMigrationAction,
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
  encodeSnapshotQueryCursor,
  querySnapshotQueryDirectory,
  type SnapshotQueryDirectory,
  type SnapshotQueryEdgeRow,
  type SnapshotQueryMembershipRow,
  type SnapshotQueryProjectionRow,
  type SnapshotQueryAggregateRow,
  type SnapshotQueryInput,
  type SnapshotQueryNodeRow,
  type SnapshotQueryResult,
} from "../domain/snapshot-query.js";
import { estimateQueryTokens } from "../domain/query-relevance.js";
import { EncryptedPostgresKeyVault } from "./encrypted-key-vault.js";
import { FileStore } from "./file-store.js";
import { insertSnapshotRows } from "./postgres-snapshot-rows.js";
import { applyMigrations } from "./migrations.js";
import {
  analysisPayloadChunkKeys,
  assembleAnalysisPayload,
  defaultAnalysisChunkKey,
  prepareStoredAnalysisPayload,
} from "./analysis-payload.js";
import {
  jsonBytes,
  LocalSnapshotObjectStore,
  normalizeSourceSnapshotPath,
  parseSourceSnapshotManifest,
  parseSnapshotManifest,
  parseJsonObject,
  putSourceSnapshot,
  snapshotObjectDigest,
  type SourceSnapshotManifest,
  type SourceSnapshotManifestFile,
  type SnapshotManifest,
  type SnapshotObjectStore,
  type StoredSourceSnapshot,
  verifySnapshotObject,
  verifySourceSnapshotObject,
} from "./snapshot-object-store.js";
import {
  DEFAULT_QUOTA_LIMITS,
  AnalysisLeaseLostError,
  QuotaExceededError,
  type AnalysisLeaseFence,
  type QuotaLimits,
  type PublicSnapshotBundle,
  type RepositoryIdentityInput,
  type RepositoryUpdatePublication,
  type SnapshotLanguageOverlayPublication,
  type SnapshotPublicationTimings,
} from "./store.js";

type Db = Pool | PoolClient;

export const MAX_INLINE_PUBLIC_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export function shouldInlinePublicSnapshotPayload(fileBytes: number): boolean {
  return fileBytes <= MAX_INLINE_PUBLIC_SNAPSHOT_BYTES;
}

interface PostgresStoreOptions {
  databaseUrl: string;
  root: string;
  migrationsRoot: string;
  encryptionSecret: string;
  applicationRole?: string;
  quotaLimits?: QuotaLimits;
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  objectStore?: SnapshotObjectStore;
}

export interface PostgresPoolSettings {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export const POSTGRES_APPLICATION_PREFIX = "what-the-repo:";

export function postgresApplicationName(role = "runtime"): string {
  const normalized = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "runtime";
  return `${POSTGRES_APPLICATION_PREFIX}${normalized}`;
}

export function postgresPoolSettings(input: {
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
} = {}): PostgresPoolSettings {
  return {
    max: Math.max(1, Math.min(100, Math.floor(input.poolMax ?? 10))),
    idleTimeoutMillis: Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.idleTimeoutMs ?? 30_000))),
    connectionTimeoutMillis: Math.max(1_000, Math.min(60_000, Math.floor(input.connectionTimeoutMs ?? 10_000))),
  };
}

function jsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function projectPayload(project: Project): Project {
  return { ...structuredClone(project), messages: [] };
}

function mergeProfiles(source: LearnerProfile, target: LearnerProfile): LearnerProfile {
  return {
    ...structuredClone(target),
    enabled: target.enabled && source.enabled,
    languages: [...new Set([...(target.languages ?? []), ...(source.languages ?? [])])].slice(0, 50),
    goals: [...new Set([...(target.goals ?? []), ...(source.goals ?? [])])].slice(0, 50),
    explanation_preference: target.explanation_preference || source.explanation_preference,
    experience_level: target.experience_level || source.experience_level,
    inferred: [...(target.inferred ?? []), ...(source.inferred ?? [])]
      .filter((claim, index, all) => all.findIndex((row) => row.claim_id === claim.claim_id) === index)
      .slice(-200),
    last_inferred_message_id: target.last_inferred_message_id ?? source.last_inferred_message_id ?? null,
    updated_at: nowIso(),
    memory_summary: target.memory_summary_mode === "edited"
      ? target.memory_summary
      : source.memory_summary_mode === "edited"
        ? source.memory_summary
        : "",
    memory_summary_mode: target.memory_summary_mode === "edited" || source.memory_summary_mode === "edited"
      ? "edited"
      : "generated",
    memory_summary_updated_at: target.memory_summary_mode === "edited"
      ? target.memory_summary_updated_at
      : source.memory_summary_mode === "edited"
        ? source.memory_summary_updated_at
        : null,
  };
}

function mergeSettings(source: ProviderSettings, target: ProviderSettings): ProviderSettings {
  const connections = [...target.connections];
  for (const sourceConnection of source.connections) {
    if (!connections.some((connection) => connection.connection_id === sourceConnection.connection_id)) {
      connections.push(structuredClone(sourceConnection));
    }
  }
  return {
    ...structuredClone(target),
    model: target.model || source.model,
    thinking_level: target.model ? target.thinking_level : source.thinking_level,
    connections,
  };
}

function jobFromRow(row: Record<string, unknown>): AnalysisJob {
  return {
    config_version: row.config_version == null ? undefined : Number(row.config_version),
    job_id: String(row.job_id),
    project_id: String(row.project_id),
    idempotency_key: String(row.idempotency_key),
    status: String(row.status) as AnalysisJob["status"],
    attempt: Number(row.attempt),
    max_attempts: Number(row.max_attempts),
    lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
    lease_expires_at: iso(row.lease_expires_at),
    heartbeat_at: iso(row.heartbeat_at),
    created_at: iso(row.created_at) ?? nowIso(),
    updated_at: iso(row.updated_at) ?? nowIso(),
    available_at: iso(row.available_at) ?? nowIso(),
    completed_at: iso(row.completed_at),
    error: row.error === null ? null : String(row.error),
    error_code: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    repository_update_id: row.repository_update_id === null || row.repository_update_id === undefined
      ? null
      : String(row.repository_update_id),
    execution_role: row.execution_role === null || row.execution_role === undefined
      ? "standalone"
      : String(row.execution_role) as AnalysisJob["execution_role"],
    language_overlay_key: row.language_overlay_key === null || row.language_overlay_key === undefined
      ? null
      : String(row.language_overlay_key),
  };
}

function semanticBatchFromRow(row: Record<string, unknown>): SemanticBatch {
  return {
    batch_id: String(row.batch_id),
    job_id: String(row.job_id),
    snapshot_id: String(row.snapshot_id),
    phase: String(row.phase) as SemanticBatch["phase"],
    ordinal: Number(row.ordinal),
    input_digest: String(row.input_digest),
    output_digest: row.output_digest === null || row.output_digest === undefined ? null : String(row.output_digest),
    status: String(row.status) as SemanticBatch["status"],
    attempt: Number(row.attempt),
    lease_owner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    lease_expires_at: iso(row.lease_expires_at),
    checkpoint: jsonObject<Record<string, unknown>>(row.checkpoint),
    output: row.output ?? null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    created_at: iso(row.created_at) ?? nowIso(),
    updated_at: iso(row.updated_at) ?? nowIso(),
    completed_at: iso(row.completed_at),
  };
}

function repositoryHeadFromRow(row: Record<string, unknown>): RepositoryHead {
  return {
    repository_identity: String(row.repository_identity),
    analyzer_bundle_version: String(row.analyzer_bundle_version),
    analysis_config_digest: String(row.analysis_config_digest),
    current_public_snapshot_key: row.current_public_snapshot_key === null ? null : String(row.current_public_snapshot_key),
    current_commit_sha: row.current_commit_sha === null ? null : String(row.current_commit_sha),
    last_checked_at: iso(row.last_checked_at),
    updated_at: iso(row.updated_at) ?? nowIso(),
  };
}

function repositoryUpdateFromRow(row: Record<string, unknown>): RepositoryUpdate {
  return {
    update_id: String(row.update_id),
    repository_identity: String(row.repository_identity),
    analyzer_bundle_version: String(row.analyzer_bundle_version),
    analysis_config_digest: String(row.analysis_config_digest),
    target_commit_sha: row.target_commit_sha === null ? null : String(row.target_commit_sha),
    status: String(row.status) as RepositoryUpdate["status"],
    leader_project_id: String(row.leader_project_id),
    lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
    lease_expires_at: iso(row.lease_expires_at),
    heartbeat_at: iso(row.heartbeat_at),
    result_public_snapshot_key: row.result_public_snapshot_key === null ? null : String(row.result_public_snapshot_key),
    error: row.error === null ? null : String(row.error),
    created_at: iso(row.created_at) ?? nowIso(),
    updated_at: iso(row.updated_at) ?? nowIso(),
    completed_at: iso(row.completed_at),
  };
}

interface SourceManifestRow {
  analysis_snapshot_id: string;
  source_storage_key: string | null;
  source_manifest_sha256: string | null;
  source_manifest_bytes: string | null;
  source_file_count: string | number | null;
  payload_purged_at: Date | string | null;
}

interface CachedSourceManifest {
  manifest: SourceSnapshotManifest;
  files: Map<string, SourceSnapshotManifestFile>;
}

function sourceLines(
  body: Uint8Array,
  start: number,
  end: number,
): { lines: string[]; truncated: boolean } {
  const all = Buffer.from(body).toString("utf8").split(/\r?\n/);
  const safeStart = Math.max(1, Math.floor(start));
  const safeEnd = Math.min(all.length, Math.max(safeStart, Math.floor(end)), safeStart + 399);
  return {
    lines: all.slice(safeStart - 1, safeEnd),
    truncated: safeEnd < all.length && safeEnd < end,
  };
}

export class PostgresStore extends FileStore {
  override readonly kind: "postgres" = "postgres";
  readonly pool: Pool;
  private readonly migrationsRoot: string;
  private readonly limits: QuotaLimits;
  readonly snapshotObjects: SnapshotObjectStore;
  private readonly sourceManifestCache = new Map<string, CachedSourceManifest>();

  constructor(options: PostgresStoreOptions) {
    const poolSettings = postgresPoolSettings(options);
    const pool = new Pool({
      connectionString: options.databaseUrl,
      application_name: postgresApplicationName(options.applicationRole),
      ...poolSettings,
    });
    const limits = options.quotaLimits ?? DEFAULT_QUOTA_LIMITS;
    super(options.root, limits, new EncryptedPostgresKeyVault(pool, options.encryptionSecret));
    // pg removes the idle client before emitting this event. Active queries still
    // reject normally; an idle disconnect must not crash the entire Worker or
    // dump a client object (which can contain credentials) through an unhandled event.
    pool.on("error", (error: Error & { code?: string }) => {
      const code = typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : "unknown";
      console.error("postgres_idle_connection_error", code);
    });
    this.pool = pool;
    this.migrationsRoot = options.migrationsRoot;
    this.limits = limits;
    this.snapshotObjects = options.objectStore ?? new LocalSnapshotObjectStore(options.root);
  }

  override async init(): Promise<void> {
    await applyMigrations(this.pool, this.migrationsRoot);
    await this.saveUser("system:runtime", {
      owner_id: "system:runtime",
      login: "system",
      display_name: "System",
      avatar_url: null,
      kind: "system",
    });
    await this.saveUser(REPOSITORY_ANALYSIS_OWNER_ID, {
      owner_id: REPOSITORY_ANALYSIS_OWNER_ID,
      login: "repository-analysis",
      display_name: "Repository Analysis",
      avatar_url: null,
      kind: "system",
      purpose: "repository-analysis",
    });
    await super.init();
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }

  override async checkHealth(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  private rememberSourceManifest(
    manifest: SourceSnapshotManifest,
    manifestSha256: string,
  ): CachedSourceManifest {
    const cacheKey = `${manifest.public_snapshot_key}:${manifest.snapshot_id}:${manifestSha256}`;
    const cached = {
      manifest,
      files: new Map(manifest.files.map((file) => [file.path, file])),
    };
    this.sourceManifestCache.delete(cacheKey);
    this.sourceManifestCache.set(cacheKey, cached);
    while (this.sourceManifestCache.size > 8) {
      const oldest = this.sourceManifestCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sourceManifestCache.delete(oldest);
    }
    return cached;
  }

  private forgetSourceManifest(publicKey: string): void {
    for (const key of this.sourceManifestCache.keys()) {
      if (key.startsWith(`${publicKey}:`)) this.sourceManifestCache.delete(key);
    }
  }

  private async sourceManifestFromRow(
    publicKey: string,
    snapshotId: string,
    row: SourceManifestRow,
  ): Promise<CachedSourceManifest | null> {
    const fields = [row.source_manifest_sha256, row.source_manifest_bytes, row.source_file_count];
    const hasManifest = fields.some((value) => value !== null);
    if (!hasManifest) return null;
    if (!row.source_storage_key || fields.some((value) => value === null)) {
      throw new Error("public_source_manifest_metadata_invalid");
    }
    const manifestBytes = Number(row.source_manifest_bytes);
    const fileCount = Number(row.source_file_count);
    if (!Number.isSafeInteger(manifestBytes) || manifestBytes < 0
      || !Number.isSafeInteger(fileCount) || fileCount < 0) {
      throw new Error("public_source_manifest_metadata_invalid");
    }
    const cacheKey = `${publicKey}:${snapshotId}:${row.source_manifest_sha256}`;
    const cached = this.sourceManifestCache.get(cacheKey);
    if (cached) return cached;
    const body = verifySourceSnapshotObject(
      await this.snapshotObjects.get(row.source_storage_key),
      { bytes: manifestBytes, sha256: row.source_manifest_sha256 as string },
    );
    const manifest = parseSourceSnapshotManifest(body, { publicKey, snapshotId });
    if (manifest.files.length !== fileCount) {
      throw new Error("public_source_manifest_metadata_mismatch");
    }
    return this.rememberSourceManifest(manifest, row.source_manifest_sha256 as string);
  }

  private async boundSourceManifest(
    projectId: string,
    snapshotId: string,
  ): Promise<CachedSourceManifest | null> {
    const result = await this.pool.query<SourceManifestRow & {
      project_snapshot_id: string | null;
      public_snapshot_key: string | null;
    }>(
      `SELECT
         project.payload #>> '{analysis,snapshot_id}' AS project_snapshot_id,
         binding.public_snapshot_key,
         public.analysis_snapshot_id,
         public.source_storage_key,
         public.source_manifest_sha256,
         public.source_manifest_bytes,
         public.source_file_count,
         public.payload_purged_at
       FROM projects AS project
       LEFT JOIN project_public_snapshot_bindings AS binding ON binding.project_id = project.project_id
       LEFT JOIN canonical_public_repository_snapshots AS public
         ON public.public_snapshot_key = binding.public_snapshot_key
       WHERE project.project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row || row.project_snapshot_id !== snapshotId) throw new Error("snapshot_not_bound");
    if (!row.public_snapshot_key) return null;
    if (row.analysis_snapshot_id !== snapshotId || row.payload_purged_at) throw new Error("snapshot_not_bound");
    return this.sourceManifestFromRow(row.public_snapshot_key, snapshotId, row);
  }

  private async publicSourceManifest(
    publicKey: string,
    snapshotId: string,
  ): Promise<CachedSourceManifest | null> {
    const result = await this.pool.query<SourceManifestRow>(
      `SELECT analysis_snapshot_id, source_storage_key,
              source_manifest_sha256, source_manifest_bytes, source_file_count,
              payload_purged_at
       FROM canonical_public_repository_snapshots
       WHERE public_snapshot_key = $1`,
      [publicKey],
    );
    const row = result.rows[0];
    if (!row || row.analysis_snapshot_id !== snapshotId || row.payload_purged_at) {
      throw new Error("snapshot_not_found");
    }
    return this.sourceManifestFromRow(publicKey, snapshotId, row);
  }

  private async readStoredSourceLines(
    source: CachedSourceManifest,
    relativePath: string,
    start: number,
    end: number,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const descriptor = source.files.get(relativePath);
    if (!descriptor) throw new Error("source_file_not_found");
    const body = verifySourceSnapshotObject(
      await this.snapshotObjects.get(descriptor.key),
      descriptor,
    );
    return sourceLines(body, start, end);
  }

  override async listSourceFiles(projectId: string, snapshotId: string): Promise<string[]> {
    const source = await this.boundSourceManifest(projectId, snapshotId);
    return source ? source.manifest.files.map((file) => file.path) : super.listSourceFiles(projectId, snapshotId);
  }

  override async readSourceLines(
    projectId: string,
    snapshotId: string,
    relativePath: string,
    start: number,
    end: number,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const path = normalizeSourceSnapshotPath(relativePath);
    const source = await this.boundSourceManifest(projectId, snapshotId);
    return source
      ? this.readStoredSourceLines(source, path, start, end)
      : super.readSourceLines(projectId, snapshotId, path, start, end);
  }

  override async readPublicSourceLines(
    publicKey: string,
    snapshotId: string,
    relativePath: string,
    start: number,
    end: number,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const path = normalizeSourceSnapshotPath(relativePath);
    const source = await this.publicSourceManifest(publicKey, snapshotId);
    return source
      ? this.readStoredSourceLines(source, path, start, end)
      : super.readPublicSourceLines(publicKey, snapshotId, path, start, end);
  }

  override async saveProject(project: Project): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.saveProjectWithClient(client, project);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async loadProject(projectId: string, ownerId?: string): Promise<Project | null> {
    return this.loadProjectWithDb(this.pool, projectId, ownerId);
  }

  override async listProjects(ownerId: string): Promise<Project[]> {
    const result = await this.pool.query<{ owner_id: string; payload: Project }>(
      "SELECT owner_id, payload FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC",
      [ownerId],
    );
    return result.rows.map((row) => ({
      ...jsonObject<Project>(row.payload),
      owner_id: row.owner_id,
      messages: [],
    }));
  }

  override async updateProject(
    projectId: string,
    ownerId: string,
    mutate: (project: Project) => void,
    fence?: AnalysisLeaseFence,
  ): Promise<Project | null> {
    const update = async (client: PoolClient): Promise<Project | null> => {
      await client.query("SELECT project_id FROM projects WHERE project_id = $1 FOR UPDATE", [projectId]);
      const project = await this.loadProjectWithDb(client, projectId, ownerId);
      if (!project) return null;
      const previousMessageIds = project.messages.map(message => message.message_id);
      mutate(project);
      const retainedIds = new Set(project.messages.map(message => message.message_id));
      const removedIds = previousMessageIds.filter(id => !retainedIds.has(id));
      if (removedIds.length) await client.query(
        "DELETE FROM project_messages WHERE project_id = $1 AND message_id = ANY($2::text[])",
        [projectId, removedIds],
      );
      project.updated_at = nowIso();
      await this.saveProjectWithClient(client, project);
      return project;
    };
    if (fence) return this.withAnalysisLeaseTransaction(fence, update);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await update(client);
      if (!project) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return project;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async deleteProject(projectId: string, ownerId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, ownerId);
      await this.lockProject(client, projectId);
      const project = await client.query(
        "SELECT project_id FROM projects WHERE project_id = $1 AND owner_id = $2 FOR UPDATE",
        [projectId, ownerId],
      );
      if (!project.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const leaderUpdates = await client.query<{ update_id: string }>(
        `SELECT update_id
         FROM repository_analysis_updates
         WHERE leader_project_id = $1
         FOR UPDATE`,
        [projectId],
      );
      for (const row of leaderUpdates.rows) {
        const replacement = await client.query<{ project_id: string }>(
          `SELECT joined.project_id
           FROM repository_analysis_update_projects AS joined
           JOIN projects AS remaining ON remaining.project_id = joined.project_id
           WHERE joined.update_id = $1 AND joined.project_id <> $2
           ORDER BY joined.created_at
           LIMIT 1
           FOR UPDATE`,
          [row.update_id, projectId],
        );
        const replacementProjectId = replacement.rows[0]?.project_id;
        if (!replacementProjectId) continue;
        await client.query(
          "UPDATE repository_analysis_updates SET leader_project_id = $2, updated_at = now() WHERE update_id = $1",
          [row.update_id, replacementProjectId],
        );
        await client.query(
          `UPDATE analysis_jobs
           SET execution_role = 'leader', updated_at = now()
           WHERE job_id = (
             SELECT job_id FROM analysis_jobs
             WHERE repository_update_id = $1
               AND project_id = $2
               AND execution_role = 'waiter'
               AND status IN ('queued', 'running')
             ORDER BY created_at
             LIMIT 1
           )`,
          [row.update_id, replacementProjectId],
        );
      }
      await client.query("DELETE FROM projects WHERE project_id = $1", [projectId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await rm(this.sourceSnapshotRoot(projectId, "deleted"), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(this.root, "source-snapshots", projectId), { recursive: true, force: true }).catch(() => undefined);
    await this.clearAnalysisCheckpoint(projectId).catch(() => undefined);
    return true;
  }

  override async createProjectWithJob(project: Project, job: AnalysisJob): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, project.owner_id);
      await this.checkDbCreationQuotas(client, project.owner_id, true);
      await this.saveProjectWithClient(client, project);
      await this.saveJobWithDb(client, job);
      await this.recordQuotaEvent(client, project.owner_id, project.project_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async enqueueAnalysisJob(ownerId: string, projectId: string, job: AnalysisJob): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, ownerId);
      const project = await client.query(
        "SELECT 1 FROM projects WHERE project_id = $1 AND owner_id = $2",
        [projectId, ownerId],
      );
      if (!project.rowCount) throw new Error("project_not_found");
      await this.checkDbCreationQuotas(client, ownerId, false);
      await this.saveJobWithDb(client, job);
      await this.recordQuotaEvent(client, ownerId, projectId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async saveSnapshot(projectId: string, payload: unknown): Promise<void> {
    const snapshot = jsonObject<Record<string, unknown>>(payload);
    await this.pool.query(
      `INSERT INTO project_snapshots(project_id, analysis_snapshot_id, view_payload, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT(project_id) DO UPDATE SET
         analysis_snapshot_id = EXCLUDED.analysis_snapshot_id,
         view_payload = EXCLUDED.view_payload,
         updated_at = now()`,
      [projectId, String(snapshot.snapshot_id ?? "pending"), JSON.stringify(snapshot)],
    );
  }

  override async loadSnapshot<T = Record<string, unknown>>(projectId: string, displayLanguage?: string): Promise<T | null> {
    const binding = await this.pool.query<{ public_snapshot_key: string }>(
      "SELECT public_snapshot_key FROM project_public_snapshot_bindings WHERE project_id = $1",
      [projectId],
    );
    const publicKey = binding.rows[0]?.public_snapshot_key;
    if (publicKey) {
      const [bundle, project] = await Promise.all([
        this.loadPublicSnapshot<unknown>(publicKey),
        this.loadProject(projectId),
      ]);
      if (!bundle) return null;
      if (!bundle.metadata.language_overlay_version) return bundle.view as T;
      const snapshot = asEvidenceSnapshot(bundle.view);
      if (!snapshot || !project) return null;
      const languages = new Set([
        normalizeDisplayLanguage(displayLanguage ?? project.display_language),
        normalizeDisplayLanguage(project.display_language),
      ]);
      // Display selection only reads existing overlays; it never queues translation.
      for (const language of languages) {
        const overlay = await this.loadSnapshotLanguageOverlay(publicKey, language);
        const payload = asSnapshotLanguageOverlayPayload(overlay?.payload);
        if (!overlay || !payload || (overlay.status !== "ready" && overlay.status !== "degraded")) continue;
        const assembled = applySnapshotLanguageOverlay(snapshot, payload);
        assembled.language_overlay_status = overlay.status;
        return assembled as T;
      }
      return null;
    }
    const local = await this.pool.query<{ view_payload: T }>(
      "SELECT view_payload FROM project_snapshots WHERE project_id = $1",
      [projectId],
    );
    return local.rows[0] ? jsonObject<T>(local.rows[0].view_payload) : null;
  }

  override async saveAnalysisResult(projectId: string, payload: unknown): Promise<void> {
    const project = await this.loadProject(projectId);
    await this.pool.query(
      `INSERT INTO project_snapshots(project_id, analysis_snapshot_id, view_payload, analysis_payload, updated_at)
       VALUES ($1, $2, '{}'::jsonb, $3::jsonb, now())
       ON CONFLICT(project_id) DO UPDATE SET
         analysis_snapshot_id = EXCLUDED.analysis_snapshot_id,
         analysis_payload = EXCLUDED.analysis_payload,
         updated_at = now()`,
      [projectId, project?.analysis.snapshot_id ?? "pending", JSON.stringify(payload)],
    );
  }

  override async loadAnalysisResult<T = Record<string, unknown>>(projectId: string): Promise<T | null> {
    const binding = await this.pool.query<{ public_snapshot_key: string }>(
      "SELECT public_snapshot_key FROM project_public_snapshot_bindings WHERE project_id = $1",
      [projectId],
    );
    const publicKey = binding.rows[0]?.public_snapshot_key;
    if (publicKey) return (await this.loadPublicSnapshot<T>(publicKey))?.analysis as T ?? null;
    const local = await this.pool.query<{ analysis_payload: T | null }>(
      "SELECT analysis_payload FROM project_snapshots WHERE project_id = $1",
      [projectId],
    );
    return local.rows[0]?.analysis_payload ? jsonObject<T>(local.rows[0].analysis_payload) : null;
  }

  override async boundSourceSnapshotRoot(projectId: string, snapshotId: string): Promise<string> {
    const result = await this.pool.query<{
      project_snapshot_id: string | null;
      public_snapshot_id: string | null;
      public_snapshot_key: string | null;
    }>(
      `SELECT
         project.payload #>> '{analysis,snapshot_id}' AS project_snapshot_id,
         public.analysis_snapshot_id AS public_snapshot_id,
         binding.public_snapshot_key
       FROM projects AS project
       LEFT JOIN project_public_snapshot_bindings AS binding ON binding.project_id = project.project_id
       LEFT JOIN canonical_public_repository_snapshots AS public
         ON public.public_snapshot_key = binding.public_snapshot_key
       WHERE project.project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row || row.project_snapshot_id !== snapshotId) throw new Error("snapshot_not_bound");
    if (row.public_snapshot_key) {
      if (row.public_snapshot_id !== snapshotId) throw new Error("snapshot_not_bound");
      return this.publicSourceSnapshotRoot(row.public_snapshot_key, snapshotId);
    }
    return this.sourceSnapshotRoot(projectId, snapshotId);
  }

  override async loadPublicSnapshot<T = Record<string, unknown>>(publicKey: string): Promise<PublicSnapshotBundle<T> | null> {
    const result = await this.pool.query<{
      repository_identity: string;
      commit_sha: string;
      analyzer_bundle_version: string;
      analysis_config_digest: string;
      analysis_snapshot_id: string;
      source_storage_key: string;
      reuse_count: string;
      logical_bytes: string;
      created_at: Date | string;
      last_used_at: Date | string | null;
      view_payload: T | null;
      analysis_payload: Record<string, unknown> | null;
      view_storage_key: string | null;
      analysis_storage_key: string | null;
      manifest_storage_key: string | null;
      manifest_sha256: string | null;
      manifest_bytes: string | null;
      view_sha256: string | null;
      view_bytes: string | null;
      analysis_sha256: string | null;
      analysis_bytes: string | null;
      source_manifest_sha256: string | null;
      source_manifest_bytes: string | null;
      source_file_count: string | number | null;
      language_overlay_version: string | null;
      retired_at: Date | string | null;
      purge_after: Date | string | null;
      payload_purged_at: Date | string | null;
    }>(
      "SELECT * FROM canonical_public_repository_snapshots WHERE public_snapshot_key = $1",
      [publicKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.payload_purged_at) return null;
    let externalView: T | null = null;
    let externalAnalysis: Record<string, unknown> | null = null;
    if (row.view_payload === null || row.analysis_payload === null) {
      const manifestFields = [
        row.manifest_storage_key,
        row.manifest_sha256,
        row.manifest_bytes,
        row.view_sha256,
        row.view_bytes,
        row.analysis_sha256,
        row.analysis_bytes,
      ];
      const hasManifest = manifestFields.some((value) => value !== null);
      if (hasManifest && manifestFields.some((value) => value === null)) {
        throw new Error("public_snapshot_manifest_metadata_invalid");
      }
      if (hasManifest) {
        const manifestBody = await this.snapshotObjects.get(row.manifest_storage_key as string);
        verifySnapshotObject<Record<string, unknown>>(manifestBody, {
          bytes: Number(row.manifest_bytes),
          sha256: row.manifest_sha256 as string,
        });
        const manifest = parseSnapshotManifest(manifestBody, {
          publicKey,
          snapshotId: row.analysis_snapshot_id,
        });
        const viewDescriptor = manifest.objects.find((item) => item.kind === "view");
        const analysisDescriptor = manifest.objects.find((item) => item.kind === "analysis");
        if (!viewDescriptor || !analysisDescriptor
          || viewDescriptor.key !== row.view_storage_key
          || viewDescriptor.sha256 !== row.view_sha256
          || viewDescriptor.bytes !== Number(row.view_bytes)
          || analysisDescriptor.key !== row.analysis_storage_key
          || analysisDescriptor.sha256 !== row.analysis_sha256
          || analysisDescriptor.bytes !== Number(row.analysis_bytes)) {
          throw new Error("public_snapshot_manifest_metadata_mismatch");
        }
        if (row.view_payload === null) {
          externalView = verifySnapshotObject<T>(
            await this.snapshotObjects.get(viewDescriptor.key),
            viewDescriptor,
          );
        }
        if (row.analysis_payload === null) {
          externalAnalysis = verifySnapshotObject<Record<string, unknown>>(
            await this.snapshotObjects.get(analysisDescriptor.key),
            analysisDescriptor,
          );
        }
      } else {
        if (row.view_payload === null) {
          externalView = parseJsonObject<T>(await this.snapshotObjects.get(
            row.view_storage_key ?? `public-repository-snapshots/${publicKey}/view.json`,
          ));
        }
        if (row.analysis_payload === null) {
          externalAnalysis = parseJsonObject<Record<string, unknown>>(await this.snapshotObjects.get(
            row.analysis_storage_key ?? `public-repository-snapshots/${publicKey}/analysis.json`,
          ));
        }
      }
    }
    if ((row.view_payload === null && !externalView) || (row.analysis_payload === null && !externalAnalysis)) {
      throw new Error("public_snapshot_payload_missing");
    }
    const storedAnalysis = row.analysis_payload === null
      ? externalAnalysis
      : jsonObject<Record<string, unknown>>(row.analysis_payload);
    const analysis = storedAnalysis === null
      ? null
      : await assembleAnalysisPayload(storedAnalysis, (key) => this.snapshotObjects.get(key));
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      throw new Error("public_snapshot_payload_missing");
    }
    return {
      metadata: {
        contract: "canonical-public-repository-snapshot-v1",
        public_snapshot_key: publicKey,
        identity: {
          repository_identity: row.repository_identity,
          commit_sha: row.commit_sha,
          analyzer_bundle_version: row.analyzer_bundle_version,
          analysis_config_digest: row.analysis_config_digest,
        },
        analysis_snapshot_id: row.analysis_snapshot_id,
        source_storage_key: row.source_storage_key,
        view_storage_key: row.view_storage_key,
        analysis_storage_key: row.analysis_storage_key,
        manifest_storage_key: row.manifest_storage_key,
        manifest_sha256: row.manifest_sha256,
        manifest_bytes: row.manifest_bytes === null ? null : Number(row.manifest_bytes),
        view_sha256: row.view_sha256,
        view_bytes: row.view_bytes === null ? null : Number(row.view_bytes),
        analysis_sha256: row.analysis_sha256,
        analysis_bytes: row.analysis_bytes === null ? null : Number(row.analysis_bytes),
        source_manifest_sha256: row.source_manifest_sha256,
        source_manifest_bytes: row.source_manifest_bytes === null ? null : Number(row.source_manifest_bytes),
        source_file_count: row.source_file_count === null ? null : Number(row.source_file_count),
        language_overlay_version: row.language_overlay_version,
        retired_at: iso(row.retired_at),
        purge_after: iso(row.purge_after),
        payload_purged_at: iso(row.payload_purged_at),
        logical_bytes: Number(row.logical_bytes),
        reuse_count: Number(row.reuse_count),
        created_at: iso(row.created_at),
        last_used_at: iso(row.last_used_at),
      },
      view: row.view_payload === null ? externalView as T : jsonObject<T>(row.view_payload),
      analysis: analysis as Record<string, unknown>,
    };
  }

  override async loadPublicSnapshotMetadata(publicKey: string): Promise<PublicSnapshotMetadata | null> {
    const result = await this.pool.query(
      `SELECT public_snapshot_key, repository_identity, commit_sha,
              analyzer_bundle_version, analysis_config_digest, analysis_snapshot_id,
              language_overlay_version, retired_at, purge_after, payload_purged_at
       FROM canonical_public_repository_snapshots
       WHERE public_snapshot_key = $1`,
      [publicKey],
    );
    const row = result.rows[0];
    return row ? {
      public_snapshot_key: String(row.public_snapshot_key),
      repository_identity: String(row.repository_identity),
      commit_sha: String(row.commit_sha),
      analyzer_bundle_version: String(row.analyzer_bundle_version),
      analysis_config_digest: String(row.analysis_config_digest),
      analysis_snapshot_id: String(row.analysis_snapshot_id),
      language_overlay_version: row.language_overlay_version === null ? null : String(row.language_overlay_version),
      retired_at: iso(row.retired_at),
      purge_after: iso(row.purge_after),
      payload_purged_at: iso(row.payload_purged_at),
    } : null;
  }

  override async loadLatestPublicSnapshot<T = Record<string, unknown>>(input: {
    repository: string;
    analyzerBundleVersion: string;
    analysisConfigDigest: string;
    excludeCommitSha?: string;
  }): Promise<PublicSnapshotBundle<T> | null> {
    const result = await this.pool.query<{ public_snapshot_key: string }>(
      `SELECT public_snapshot_key
       FROM canonical_public_repository_snapshots
       WHERE repository_identity = $1
         AND analyzer_bundle_version = $2
         AND analysis_config_digest = $3
         AND ($4::text IS NULL OR commit_sha <> $4)
       ORDER BY created_at DESC
       LIMIT 1`,
      [
        input.repository.toLowerCase(),
        input.analyzerBundleVersion,
        input.analysisConfigDigest,
        input.excludeCommitSha ?? null,
      ],
    );
    const publicKey = result.rows[0]?.public_snapshot_key;
    return publicKey ? this.loadPublicSnapshot<T>(publicKey) : null;
  }

  override async preparePublicSnapshotSource(input: {
    publicKey: string; snapshotId: string; sourceRoot: string; fence?: AnalysisLeaseFence; signal?: AbortSignal;
  }): Promise<StoredSourceSnapshot> {
    input.signal?.throwIfAborted();
    if (input.fence) await this.withAnalysisLeaseTransaction(input.fence, async () => undefined);
    return putSourceSnapshot({ ...input, objectStore: this.snapshotObjects });
  }

  override async savePublicSnapshot(input: {
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
  }): Promise<SnapshotPublicationTimings> {
    const started = performance.now();
    const timings: SnapshotPublicationTimings = {};
    const measure = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try { return await operation(); } finally { timings[name] = performance.now() - start; }
    };
    const sourceRoot = input.sourceRoot ?? this.publicSourceSnapshotRoot(input.publicKey, input.snapshotId);
    const createdAt = nowIso();
    type PreparedSnapshotObjects = {
      viewKey: string;
      analysisKey: string;
      viewBody: Uint8Array;
      analysisBody: Uint8Array;
      analysisChunked: boolean;
      viewObject: Awaited<ReturnType<SnapshotObjectStore["put"]>>;
      analysisObject: Awaited<ReturnType<SnapshotObjectStore["put"]>>;
      analysisChunks: Awaited<ReturnType<typeof prepareStoredAnalysisPayload>>["chunks"];
      sourceSnapshot: Awaited<ReturnType<typeof putSourceSnapshot>>;
      manifestObject: Awaited<ReturnType<SnapshotObjectStore["put"]>>;
    };
    if (input.fence) {
      // Preflight while holding the row lock only briefly. Object uploads must
      // happen outside the transaction so the worker heartbeat can extend the
      // lease during a large source snapshot upload.
      await this.withAnalysisLeaseTransaction(input.fence, async () => undefined);
    }
    const viewStart = performance.now();
    const viewBody = jsonBytes(input.view);
    const viewKey = `public-repository-snapshots/${input.publicKey}/view-${snapshotObjectDigest(viewBody)}.json`;
    timings.view_serialization_ms = performance.now() - viewStart;
    const [viewObject, preparedAnalysis, sourceSnapshot] = await Promise.all([
      measure("view_upload_ms", () => this.snapshotObjects.put(viewKey, viewBody, "application/json")),
      measure("analysis_prepare_ms", () => prepareStoredAnalysisPayload(
        input.analysis,
        (path, index, sha256) => defaultAnalysisChunkKey(
          `public-repository-snapshots/${input.publicKey}`,
          path,
          index,
          sha256,
        ),
        (key, body) => this.snapshotObjects.put(key, body, "application/json"),
      )),
      measure("source_upload_ms", async () => input.preparedSource ?? putSourceSnapshot({
        objectStore: this.snapshotObjects,
        sourceRoot,
        publicKey: input.publicKey,
        snapshotId: input.snapshotId,
        createdAt,
      })),
    ]);
    // A resumed assembly may carry a previously uploaded immutable manifest.
    // Verify its identity and bytes before binding it to the published snapshot.
    const sourceManifestBody = jsonBytes(sourceSnapshot.manifest);
    if (sourceSnapshot.manifest.public_snapshot_key !== input.publicKey
      || sourceSnapshot.manifest.snapshot_id !== input.snapshotId
      || sourceSnapshot.manifestObject.sha256 !== snapshotObjectDigest(sourceManifestBody)
      || sourceSnapshot.manifestObject.bytes !== sourceManifestBody.byteLength) {
      throw new Error("prepared_source_snapshot_mismatch");
    }
    const analysisStart = performance.now();
    const analysisBody = jsonBytes(preparedAnalysis.value);
    const analysisKey = `public-repository-snapshots/${input.publicKey}/analysis-${snapshotObjectDigest(analysisBody)}.json`;
    const analysisObject = await this.snapshotObjects.put(analysisKey, analysisBody, "application/json");
    timings.analysis_upload_ms = performance.now() - analysisStart;
    const directoryStart = performance.now();
    const directory = buildSnapshotQueryDirectory(
      input.publicKey,
      input.snapshotId,
      input.view,
      input.analysis,
    );
    timings.directory_build_ms = performance.now() - directoryStart;
    const manifest: SnapshotManifest = {
      schema_version: 1,
      public_snapshot_key: input.publicKey,
      snapshot_id: input.snapshotId,
      objects: [
        { kind: "view", key: viewKey, bytes: viewObject.bytes, sha256: viewObject.sha256 },
        { kind: "analysis", key: analysisKey, bytes: analysisObject.bytes, sha256: analysisObject.sha256 },
      ],
      query_directory: {
        digest: directory.digest,
        nodes: directory.nodes.length,
        edges: directory.edges.length,
        evidence: directory.evidence.length,
        layers: directory.layers.length,
        value_points: directory.value_points.length,
      },
      created_at: createdAt,
    };
    const manifestBody = jsonBytes(manifest);
    const manifestKey = `public-repository-snapshots/${input.publicKey}/manifest-${snapshotObjectDigest(manifestBody)}.json`;
    const manifestObject = await measure("manifest_upload_ms", () => this.snapshotObjects.put(manifestKey, manifestBody, "application/json"));
    const prepared: PreparedSnapshotObjects = {
      viewKey,
      analysisKey,
      viewBody,
      analysisBody,
      analysisChunked: preparedAnalysis.envelope !== null,
      viewObject,
      analysisObject,
      analysisChunks: preparedAnalysis.chunks,
      sourceSnapshot,
      manifestObject,
    };
    const persist = async (
      client: PoolClient,
      prepared: PreparedSnapshotObjects,
    ): Promise<void> => {
      const { viewObject, analysisObject, analysisChunks, sourceSnapshot, manifestObject } = prepared;
      const logicalBytes = sourceSnapshot.manifest.total_bytes
        + viewObject.bytes
        + analysisObject.bytes
        + analysisChunks.reduce((total, chunk) => total + chunk.bytes, 0);
      const sourceStorageKey = sourceSnapshot.manifestObject.key;
      const viewStorageKey = prepared.viewKey;
      const analysisStorageKey = prepared.analysisKey;
      // PostgreSQL jsonb has a much larger nominal value limit, but a single array
      // element cannot exceed 256 MiB. Keep a wide safety margin for dense graphs.
      const viewPayload = shouldInlinePublicSnapshotPayload(viewObject.bytes)
        ? Buffer.from(prepared.viewBody.buffer, prepared.viewBody.byteOffset, prepared.viewBody.byteLength - 1).toString("utf8")
        : null;
      const analysisPayload = !prepared.analysisChunked
        && shouldInlinePublicSnapshotPayload(analysisObject.bytes)
        ? Buffer.from(prepared.analysisBody.buffer, prepared.analysisBody.byteOffset, prepared.analysisBody.byteLength - 1).toString("utf8")
        : null;
      await client.query(
        `INSERT INTO canonical_public_repository_snapshots(
         public_snapshot_key, repository_identity, commit_sha,
         analyzer_bundle_version, analysis_config_digest, analysis_snapshot_id,
         view_payload, analysis_payload, source_storage_key,
         view_storage_key, analysis_storage_key, manifest_storage_key,
         manifest_sha256, manifest_bytes, view_sha256, view_bytes,
         analysis_sha256, analysis_bytes, logical_bytes,
         source_manifest_sha256, source_manifest_bytes, source_file_count,
         reuse_count, created_at, last_used_at, language_overlay_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22, 0, now(), now(), $23
       )
       ON CONFLICT(public_snapshot_key) DO UPDATE SET
         view_payload = EXCLUDED.view_payload,
         analysis_payload = EXCLUDED.analysis_payload,
         source_storage_key = EXCLUDED.source_storage_key,
         view_storage_key = EXCLUDED.view_storage_key,
         analysis_storage_key = EXCLUDED.analysis_storage_key,
         manifest_storage_key = EXCLUDED.manifest_storage_key,
         manifest_sha256 = EXCLUDED.manifest_sha256,
         manifest_bytes = EXCLUDED.manifest_bytes,
         view_sha256 = EXCLUDED.view_sha256,
         view_bytes = EXCLUDED.view_bytes,
         analysis_sha256 = EXCLUDED.analysis_sha256,
         analysis_bytes = EXCLUDED.analysis_bytes,
         logical_bytes = EXCLUDED.logical_bytes,
         source_manifest_sha256 = EXCLUDED.source_manifest_sha256,
         source_manifest_bytes = EXCLUDED.source_manifest_bytes,
         source_file_count = EXCLUDED.source_file_count,
         language_overlay_version = EXCLUDED.language_overlay_version,
         retired_at = NULL,
         purge_after = NULL,
         payload_purged_at = NULL,
         last_used_at = now()`,
        [
          input.publicKey,
          input.repository.toLowerCase(),
          input.commitSha,
          input.analyzerBundleVersion ?? "typescript-0.1.0",
          input.analysisConfigDigest ?? "tree-sitter-nine-language-v1",
          input.snapshotId,
          viewPayload,
          analysisPayload,
          sourceStorageKey,
          viewStorageKey,
          analysisStorageKey,
          manifestObject.key,
          manifestObject.sha256,
          manifestObject.bytes,
          viewObject.sha256,
          viewObject.bytes,
          analysisObject.sha256,
          analysisObject.bytes,
          logicalBytes,
          sourceSnapshot.manifestObject.sha256,
          sourceSnapshot.manifestObject.bytes,
          sourceSnapshot.manifest.files.length,
          input.languageOverlayVersion ?? null,
        ],
      );
      await measure("directory_write_ms", () => this.saveSnapshotQueryDirectory(directory, client));
    };
    const transactionStart = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let fencedProjectId: string | undefined;
      if (input.fence) {
        fencedProjectId = await this.lockAnalysisProject(client, input.fence);
        await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      }
      await persist(client, prepared);
      if (input.fence) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      timings.transaction_ms = performance.now() - transactionStart;
    }
    this.rememberSourceManifest(prepared.sourceSnapshot.manifest, prepared.sourceSnapshot.manifestObject.sha256);
    timings.total_ms = performance.now() - started;
    return timings;
  }

  private async saveSnapshotQueryDirectory(
    directory: SnapshotQueryDirectory,
    transactionClient?: PoolClient,
  ): Promise<void> {
    const client = transactionClient ?? await this.pool.connect();
    const ownsTransaction = transactionClient === undefined;
    try {
      if (ownsTransaction) await client.query("BEGIN");
      await client.query(
        `INSERT INTO snapshot_query_directories(
           public_snapshot_key, snapshot_id, schema_version, directory_digest,
           node_count, edge_count, evidence_count, layer_count, value_point_count, ready_at
         ) VALUES ($1, $2, 2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT(public_snapshot_key) DO UPDATE SET
           snapshot_id = EXCLUDED.snapshot_id,
           schema_version = EXCLUDED.schema_version,
           directory_digest = EXCLUDED.directory_digest,
           node_count = EXCLUDED.node_count,
           edge_count = EXCLUDED.edge_count,
           evidence_count = EXCLUDED.evidence_count,
           layer_count = EXCLUDED.layer_count,
           value_point_count = EXCLUDED.value_point_count,
           ready_at = EXCLUDED.ready_at`,
        [
          directory.public_snapshot_key,
          directory.snapshot_id,
          directory.digest,
          directory.nodes.length,
          directory.edges.length,
          directory.evidence.length,
          directory.layers.length,
          directory.value_points.length,
        ],
      );
      await client.query("DELETE FROM snapshot_query_evidence_links WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_evidence WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_edges WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_nodes WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_layers WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_value_points WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_projection_edges WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_projection_nodes WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await client.query("DELETE FROM snapshot_query_overlay_memberships WHERE public_snapshot_key = $1", [directory.public_snapshot_key]);
      await insertSnapshotRows(
        client,
        "snapshot_query_nodes",
        ["public_snapshot_key", "snapshot_id", "node_key", "node_id", "node_kind", "entity_kind", "parent_entity_id", "depth", "label", "name", "responsibility", "path", "language", "layer_id", "layer_name", "certainty", "lifecycle_status", "payload"],
        directory.nodes,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_edges",
        ["public_snapshot_key", "snapshot_id", "edge_key", "edge_id", "edge_kind", "source_node_key", "target_node_key", "relation_kind", "label", "description", "certainty", "weight", "lifecycle_status", "payload"],
        directory.edges,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_evidence",
        ["public_snapshot_key", "snapshot_id", "evidence_id", "label", "path", "start_line", "end_line", "kind", "source_id", "target_id", "payload"],
        directory.evidence,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_evidence_links",
        ["public_snapshot_key", "evidence_id", "owner_kind", "owner_key", "role"],
        directory.evidence_links,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_layers",
        ["public_snapshot_key", "snapshot_id", "layer_id", "name", "responsibility", "certainty", "payload"],
        directory.layers,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_value_points",
        ["public_snapshot_key", "snapshot_id", "value_point_id", "kind", "title", "claim", "certainty", "connectivity", "payload"],
        directory.value_points,
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_overlay_memberships",
        ["public_snapshot_key", "snapshot_id", "overlay_id", "overlay_kind", "entity_id", "relation_id", "role", "payload"],
        directory.memberships ?? [],
        row => ({ ...row, relation_id: row.relation_id ?? "" }),
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_projection_nodes",
        ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_node_id", "entity_id", "parent_projection_node_id", "depth", "aggregate_member_entity_ids", "evidence_ids", "overlay_ids", "payload"],
        directory.projections ?? [],
        row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }),
      );
      await insertSnapshotRows(
        client,
        "snapshot_query_projection_edges",
        ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_edge_id", "relation_id", "source_projection_node_id", "target_projection_node_id", "source_entity_id", "target_entity_id", "aggregate_relation_ids", "evidence_ids", "overlay_ids", "payload"],
        directory.aggregates ?? [],
        row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }),
      );
      if (ownsTransaction) await client.query("COMMIT");
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  override async queryPublicSnapshot(input: {
    publicKey: string;
    snapshotId: string;
    query: SnapshotQueryInput;
  }): Promise<SnapshotQueryResult> {
    const directory = await this.pool.query<{ snapshot_id: string; directory_digest: string; ready_at: Date | string }>(
      `SELECT snapshot_id, directory_digest, ready_at FROM snapshot_query_directories
       WHERE public_snapshot_key = $1`,
      [input.publicKey],
    );
    if (!directory.rows[0] || directory.rows[0].snapshot_id !== input.snapshotId) {
      const bundle = await this.loadPublicSnapshot(input.publicKey);
      if (!bundle || String(bundle.metadata.analysis_snapshot_id ?? "") !== input.snapshotId) {
        throw new Error("snapshot_query_not_found");
      }
      return querySnapshotQueryDirectory(
        buildSnapshotQueryDirectory(input.publicKey, input.snapshotId, bundle.view, bundle.analysis),
        input.query,
      );
    }

    const expandHops = Math.max(0, Math.min(2, Math.floor(input.query.expand_hops ?? 0)));
    const advancedDirectoryQuery = expandHops > 0
      || Boolean(input.query.text?.trim()
        || input.query.paths?.length
        || input.query.languages?.length
        || input.query.symbol_ids?.length
        || input.query.component_ids?.length
        || input.query.entity_ids?.length
        || input.query.entity_kinds?.length
        || input.query.scope
        || input.query.projection
        || input.query.depth !== undefined
        || input.query.personalized_entity_ids?.length
        || input.query.evidence_budget_tokens !== undefined
        || input.query.relation_kinds?.length
        || input.query.cursor);
    if (advancedDirectoryQuery) {
      // Expansion is defined by the shared directory query implementation. Load
      // the immutable snapshot directory so PostgreSQL and FileStore use exactly
      // the same hop, filter, cursor and evidence semantics.
      const [nodes, edges, evidence, evidenceLinks, layers, valuePoints, memberships, projections, aggregates] = await Promise.all([
        this.pool.query<SnapshotQueryNodeRow>(
          `SELECT * FROM snapshot_query_nodes
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY node_key`,
          [input.publicKey, input.snapshotId],
        ),
        this.pool.query<SnapshotQueryEdgeRow>(
          `SELECT * FROM snapshot_query_edges
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY edge_key`,
          [input.publicKey, input.snapshotId],
        ),
        this.pool.query(
          `SELECT * FROM snapshot_query_evidence
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY evidence_id`,
          [input.publicKey, input.snapshotId],
        ),
        this.pool.query(
          `SELECT * FROM snapshot_query_evidence_links
           WHERE public_snapshot_key = $1
           ORDER BY evidence_id, owner_kind, owner_key, role`,
          [input.publicKey],
        ),
        this.pool.query(
          `SELECT * FROM snapshot_query_layers
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY layer_id`,
          [input.publicKey, input.snapshotId],
        ),
        this.pool.query(
          `SELECT * FROM snapshot_query_value_points
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY value_point_id`,
          [input.publicKey, input.snapshotId],
        ),
        this.pool.query<SnapshotQueryMembershipRow>(
          `SELECT * FROM snapshot_query_overlay_memberships
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY overlay_id, entity_id, relation_id, role`,
          [input.publicKey, input.snapshotId],
        ).catch(() => ({ rows: [] as SnapshotQueryMembershipRow[] })),
        this.pool.query<SnapshotQueryProjectionRow>(
          `SELECT * FROM snapshot_query_projection_nodes
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY projection_kind, projection_node_id`,
          [input.publicKey, input.snapshotId],
        ).catch(() => ({ rows: [] as SnapshotQueryProjectionRow[] })),
        this.pool.query<SnapshotQueryAggregateRow>(
          `SELECT * FROM snapshot_query_projection_edges
           WHERE public_snapshot_key = $1 AND snapshot_id = $2
           ORDER BY projection_kind, projection_edge_id`,
          [input.publicKey, input.snapshotId],
        ).catch(() => ({ rows: [] as SnapshotQueryAggregateRow[] })),
      ]);
      const directoryRows: SnapshotQueryDirectory = {
        public_snapshot_key: input.publicKey,
        snapshot_id: input.snapshotId,
        nodes: nodes.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
        edges: edges.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
        evidence: evidence.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
        evidence_links: evidenceLinks.rows.map((row) => ({
          ...row,
          owner_kind: row.owner_kind as SnapshotQueryDirectory["evidence_links"][number]["owner_kind"],
          role: row.role as SnapshotQueryDirectory["evidence_links"][number]["role"],
        })),
        layers: layers.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
        value_points: valuePoints.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
        memberships: memberships.rows.map((row) => ({
          ...row,
          relation_id: row.relation_id || null,
          payload: jsonObject<Record<string, unknown>>(row.payload),
        })),
        projections: projections.rows.map((row) => ({
          ...row,
          aggregate_member_entity_ids: Array.isArray(row.aggregate_member_entity_ids) ? row.aggregate_member_entity_ids : [],
          evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
          overlay_ids: Array.isArray(row.overlay_ids) ? row.overlay_ids : [],
          payload: jsonObject<Record<string, unknown>>(row.payload),
        })),
        aggregates: aggregates.rows.map((row) => ({
          ...row,
          aggregate_relation_ids: Array.isArray(row.aggregate_relation_ids) ? row.aggregate_relation_ids : [],
          evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
          overlay_ids: Array.isArray(row.overlay_ids) ? row.overlay_ids : [],
          payload: jsonObject<Record<string, unknown>>(row.payload),
        })),
        digest: directory.rows[0]?.directory_digest ?? "",
      };
      return querySnapshotQueryDirectory(directoryRows, { ...input.query, expand_hops: expandHops });
    }

    const limit = Math.max(1, Math.min(100, Math.floor(input.query.limit ?? 20)));
    let cursor: string | null = null;
    if (input.query.cursor) {
      try {
        const decoded = Buffer.from(input.query.cursor, "base64url").toString("utf8");
        cursor = decoded.startsWith("k:") ? decoded.slice(2) : null;
      } catch {
        cursor = null;
      }
    }
    const cursorKind = cursor?.slice(0, 2);
    const cursorValue = cursor?.slice(2) ?? null;
    const nodeParams: unknown[] = [input.publicKey, input.snapshotId];
    const nodeWhere = ["public_snapshot_key = $1", "snapshot_id = $2"];
    if (cursorKind === "1:") nodeWhere.push("FALSE");
    else if (cursorKind === "0:") {
      nodeParams.push(cursorValue);
      nodeWhere.push(`node_key > $${nodeParams.length}`);
    }
    const textQuery = input.query.text?.trim();
    if (textQuery) {
      nodeParams.push(`%${textQuery}%`);
      const index = nodeParams.length;
      nodeWhere.push(`(node_key ILIKE $${index} OR node_id ILIKE $${index} OR name ILIKE $${index} OR label ILIKE $${index} OR responsibility ILIKE $${index} OR path ILIKE $${index} OR payload::text ILIKE $${index})`);
    }
    if (input.query.paths?.length) {
      nodeParams.push(input.query.paths.map((value) => `%${value}%`));
      nodeWhere.push(`path ILIKE ANY($${nodeParams.length}::text[])`);
    }
    if (input.query.languages?.length) {
      nodeParams.push(input.query.languages.map((value) => value.toLowerCase()));
      nodeWhere.push(`language = ANY($${nodeParams.length}::text[])`);
    }
    if (input.query.symbol_ids?.length) {
      nodeParams.push(input.query.symbol_ids);
      nodeWhere.push(`(node_id = ANY($${nodeParams.length}::text[]) OR node_key = ANY($${nodeParams.length}::text[]))`);
    }
    if (input.query.component_ids?.length) {
      nodeParams.push(input.query.component_ids);
      nodeWhere.push(`(node_id = ANY($${nodeParams.length}::text[]) OR node_key = ANY($${nodeParams.length}::text[]))`);
    }
    if (input.query.entity_ids?.length) {
      nodeParams.push(input.query.entity_ids);
      nodeWhere.push(`(node_id = ANY($${nodeParams.length}::text[]) OR node_key = ANY($${nodeParams.length}::text[]))`);
    }
    if (input.query.entity_kinds?.length) {
      nodeParams.push(input.query.entity_kinds);
      nodeWhere.push(`entity_kind = ANY($${nodeParams.length}::text[])`);
    }
    if (input.query.depth !== undefined) {
      nodeParams.push(Math.max(0, Math.min(100, Math.floor(input.query.depth))));
      nodeWhere.push(`depth <= $${nodeParams.length}`);
    }
    const nodeRows = await this.pool.query<SnapshotQueryNodeRow>(
      `SELECT * FROM snapshot_query_nodes WHERE ${nodeWhere.join(" AND ")} ORDER BY node_key LIMIT ${limit + 1}`,
      nodeParams,
    );

    const edgeParams: unknown[] = [input.publicKey, input.snapshotId];
    const edgeWhere = ["public_snapshot_key = $1", "snapshot_id = $2"];
    if (cursorKind === "1:") {
      edgeParams.push(cursorValue);
      edgeWhere.push(`edge_key > $${edgeParams.length}`);
    }
    if (textQuery) {
      edgeParams.push(`%${textQuery}%`);
      const index = edgeParams.length;
      edgeWhere.push(`(edge_key ILIKE $${index} OR edge_id ILIKE $${index} OR relation_kind ILIKE $${index} OR label ILIKE $${index} OR description ILIKE $${index} OR source_node_key ILIKE $${index} OR target_node_key ILIKE $${index})`);
    }
    if (input.query.relation_kinds?.length) {
      edgeParams.push(input.query.relation_kinds);
      edgeWhere.push(`relation_kind = ANY($${edgeParams.length}::text[])`);
    }
    const edgeRows = await this.pool.query<SnapshotQueryEdgeRow>(
      `SELECT * FROM snapshot_query_edges WHERE ${edgeWhere.join(" AND ")} ORDER BY edge_key LIMIT ${limit + 1}`,
      edgeParams,
    );
    const combined = [
      ...nodeRows.rows.map((row) => ({ key: `0:${row.node_key}`, row, kind: "node" as const })),
      ...edgeRows.rows.map((row) => ({ key: `1:${row.edge_key}`, row, kind: "edge" as const })),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const page = combined.slice(0, limit);
    const nodes = page.filter((row): row is { key: string; row: SnapshotQueryNodeRow; kind: "node" } => row.kind === "node").map((row) => ({
      ...row.row,
      payload: jsonObject<Record<string, unknown>>(row.row.payload),
    }));
    const edges = page.filter((row): row is { key: string; row: SnapshotQueryEdgeRow; kind: "edge" } => row.kind === "edge").map((row) => ({
      ...row.row,
      payload: jsonObject<Record<string, unknown>>(row.row.payload),
    }));
    const ownerTokens = [
      ...nodes.map((row) => `node:${row.node_key}`),
      ...edges.map((row) => `edge:${row.edge_key}`),
    ];
    const links = ownerTokens.length
      ? await this.pool.query<{ evidence_id: string; owner_kind: string; owner_key: string; role: string }>(
        `SELECT evidence_id, owner_kind, owner_key, role FROM snapshot_query_evidence_links
         WHERE public_snapshot_key = $1 AND (owner_kind || ':' || owner_key) = ANY($2::text[])`,
        [input.publicKey, ownerTokens],
      )
      : { rows: [] };
    const evidenceIds = [...new Set(links.rows.map((row) => row.evidence_id))];
    const evidence = evidenceIds.length
      ? await this.pool.query(
        `SELECT * FROM snapshot_query_evidence
         WHERE public_snapshot_key = $1 AND evidence_id = ANY($2::text[])
         ORDER BY evidence_id`,
        [input.publicKey, evidenceIds],
      )
      : { rows: [] };
    const layers = await this.pool.query("SELECT * FROM snapshot_query_layers WHERE public_snapshot_key = $1 ORDER BY layer_id", [input.publicKey]);
    const valuePoints = await this.pool.query("SELECT * FROM snapshot_query_value_points WHERE public_snapshot_key = $1 ORDER BY value_point_id", [input.publicKey]);
    const [memberships, projections, aggregates] = await Promise.all([
      this.pool.query<SnapshotQueryMembershipRow>(
        "SELECT * FROM snapshot_query_overlay_memberships WHERE public_snapshot_key = $1 ORDER BY overlay_id, entity_id, relation_id, role",
        [input.publicKey],
      ).catch(() => ({ rows: [] as SnapshotQueryMembershipRow[] })),
      this.pool.query<SnapshotQueryProjectionRow>(
        "SELECT * FROM snapshot_query_projection_nodes WHERE public_snapshot_key = $1 ORDER BY projection_kind, projection_node_id",
        [input.publicKey],
      ).catch(() => ({ rows: [] as SnapshotQueryProjectionRow[] })),
      this.pool.query<SnapshotQueryAggregateRow>(
        "SELECT * FROM snapshot_query_projection_edges WHERE public_snapshot_key = $1 ORDER BY projection_kind, projection_edge_id",
        [input.publicKey],
      ).catch(() => ({ rows: [] as SnapshotQueryAggregateRow[] })),
    ]);
    const hasMore = combined.length > page.length;
    const pageEvidence = evidence.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) }));
    return {
      public_snapshot_key: input.publicKey,
      snapshot_id: input.snapshotId,
      nodes,
      edges,
      evidence: pageEvidence,
      evidence_links: links.rows.map((row) => ({
        public_snapshot_key: input.publicKey,
        evidence_id: row.evidence_id,
        owner_kind: row.owner_kind as "node" | "edge" | "layer" | "value_point",
        owner_key: row.owner_key,
        role: row.role as "evidence" | "member",
      })),
      layers: layers.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
      value_points: valuePoints.rows.map((row) => ({ ...row, payload: jsonObject<Record<string, unknown>>(row.payload) })),
      memberships: memberships.rows.map((row) => ({
        ...row,
        relation_id: row.relation_id || null,
        payload: jsonObject<Record<string, unknown>>(row.payload),
      })),
      projections: projections.rows.map((row) => ({
        ...row,
        aggregate_member_entity_ids: Array.isArray(row.aggregate_member_entity_ids) ? row.aggregate_member_entity_ids : [],
        evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
        overlay_ids: Array.isArray(row.overlay_ids) ? row.overlay_ids : [],
        payload: jsonObject<Record<string, unknown>>(row.payload),
      })),
      aggregates: aggregates.rows.map((row) => ({
        ...row,
        aggregate_relation_ids: Array.isArray(row.aggregate_relation_ids) ? row.aggregate_relation_ids : [],
        evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
        overlay_ids: Array.isArray(row.overlay_ids) ? row.overlay_ids : [],
        payload: jsonObject<Record<string, unknown>>(row.payload),
      })),
      next_cursor: hasMore && page.length ? encodeSnapshotQueryCursor(page[page.length - 1]!.key) : null,
      truncated: hasMore,
      estimated_tokens: estimateQueryTokens({ nodes, edges, evidence: pageEvidence }),
      budget_tokens: input.query.evidence_budget_tokens ?? null,
      returned_evidence_count: pageEvidence.length,
      truncation_reason: hasMore ? "limit" : null,
    };
  }

  override async loadRepositoryHead(input: RepositoryIdentityInput): Promise<RepositoryHead | null> {
    const result = await this.pool.query(
      `SELECT * FROM canonical_public_repository_heads
       WHERE repository_identity = $1
         AND analyzer_bundle_version = $2
         AND analysis_config_digest = $3`,
      [input.repository.toLowerCase(), input.analyzerBundleVersion, input.analysisConfigDigest],
    );
    return result.rows[0] ? repositoryHeadFromRow(result.rows[0]) : null;
  }

  override async saveRepositoryHead(head: RepositoryHead): Promise<void> {
    await this.pool.query(
      `INSERT INTO canonical_public_repository_heads(
         repository_identity, analyzer_bundle_version, analysis_config_digest,
         current_public_snapshot_key, current_commit_sha, last_checked_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(repository_identity, analyzer_bundle_version, analysis_config_digest)
       DO UPDATE SET
         current_public_snapshot_key = EXCLUDED.current_public_snapshot_key,
         current_commit_sha = EXCLUDED.current_commit_sha,
         last_checked_at = EXCLUDED.last_checked_at,
         updated_at = EXCLUDED.updated_at`,
      [
        head.repository_identity.toLowerCase(),
        head.analyzer_bundle_version,
        head.analysis_config_digest,
        head.current_public_snapshot_key,
        head.current_commit_sha,
        head.last_checked_at,
        head.updated_at,
      ],
    );
  }

  override async createOrJoinRepositoryUpdate(input: {
    project: Project;
    job: AnalysisJob;
    identity: RepositoryIdentityInput;
    targetCommitSha?: string | null;
    newProject: boolean;
  }): Promise<{ update: RepositoryUpdate; job: AnalysisJob; leader: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, input.project.owner_id);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`repository-update:${input.identity.repository.toLowerCase()}:${input.identity.analyzerBundleVersion}:${input.identity.analysisConfigDigest}`],
      );
      await this.checkDbCreationQuotas(client, input.project.owner_id, input.newProject);
      if (input.newProject) {
        await this.saveProjectWithClient(client, input.project);
      } else {
        const existingProject = await client.query(
          "SELECT 1 FROM projects WHERE project_id = $1 AND owner_id = $2 FOR UPDATE",
          [input.project.project_id, input.project.owner_id],
        );
        if (!existingProject.rowCount) throw new Error("project_not_found");
        await this.saveProjectWithClient(client, input.project);
      }
      const active = await client.query(
        `SELECT * FROM repository_analysis_updates
         WHERE repository_identity = $1
           AND analyzer_bundle_version = $2
           AND analysis_config_digest = $3
           AND status IN ('queued', 'running')
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE`,
        [
          input.identity.repository.toLowerCase(),
          input.identity.analyzerBundleVersion,
          input.identity.analysisConfigDigest,
        ],
      );
      const leader = !active.rows[0];
      let update: RepositoryUpdate;
      if (active.rows[0]) {
        update = repositoryUpdateFromRow(active.rows[0]);
      } else {
        const updateId = randomUUID().replaceAll("-", "");
        const inserted = await client.query(
          `INSERT INTO repository_analysis_updates(
             update_id, repository_identity, analyzer_bundle_version,
             analysis_config_digest, target_commit_sha, status,
             leader_project_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'queued', $6, now(), now())
           RETURNING *`,
          [
            updateId,
            input.identity.repository.toLowerCase(),
            input.identity.analyzerBundleVersion,
            input.identity.analysisConfigDigest,
            input.targetCommitSha ?? null,
            input.project.project_id,
          ],
        );
        update = repositoryUpdateFromRow(inserted.rows[0]);
      }
      await client.query(
        `INSERT INTO repository_analysis_update_projects(update_id, project_id, created_at)
         VALUES ($1, $2, now())
         ON CONFLICT(update_id, project_id) DO NOTHING`,
        [update.update_id, input.project.project_id],
      );
      const queuedJob: AnalysisJob = {
        ...input.job,
        repository_update_id: update.update_id,
        execution_role: leader ? "leader" : "waiter",
      };
      await this.saveJobWithDb(client, queuedJob);
      await this.recordQuotaEvent(client, input.project.owner_id, input.project.project_id);
      await client.query("COMMIT");
      return { update, job: queuedJob, leader };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async loadRepositoryUpdateForProject(projectId: string): Promise<RepositoryUpdate | null> {
    const result = await this.pool.query(
      `SELECT update.*
       FROM repository_analysis_update_projects AS joined
       JOIN repository_analysis_updates AS update ON update.update_id = joined.update_id
       WHERE joined.project_id = $1
       ORDER BY joined.created_at DESC
       LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? repositoryUpdateFromRow(result.rows[0]) : null;
  }

  override async listRepositoryUpdateProjects(updateId: string): Promise<Project[]> {
    const result = await this.pool.query<{ project_id: string }>(
      `SELECT project_id FROM repository_analysis_update_projects
       WHERE update_id = $1 ORDER BY created_at`,
      [updateId],
    );
    const projects = await Promise.all(result.rows.map((row) => this.loadProject(row.project_id)));
    return projects.filter((row): row is Project => Boolean(row));
  }

  override async publishRepositoryUpdate(input: RepositoryUpdatePublication & { fence?: AnalysisLeaseFence }): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const fencedProjectId = input.fence
        ? await this.resolveAnalysisProjectId(client, input.fence)
        : undefined;
      const scopeLocked = await this.lockRepositoryUpdateScope(
        client,
        input.updateId,
        fencedProjectId ? [fencedProjectId] : [],
        true,
      );
      if (!scopeLocked) throw new Error("repository_update_not_found");
      if (input.fence) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      const locked = await client.query(
        "SELECT * FROM repository_analysis_updates WHERE update_id = $1 FOR UPDATE",
        [input.updateId],
      );
      if (!locked.rows[0]) throw new Error("repository_update_not_found");
      const update = repositoryUpdateFromRow(locked.rows[0]);
      const previousHead = await client.query<{ current_public_snapshot_key: string | null }>(
        `SELECT current_public_snapshot_key FROM canonical_public_repository_heads
         WHERE repository_identity = $1
           AND analyzer_bundle_version = $2
           AND analysis_config_digest = $3
         FOR UPDATE`,
        [update.repository_identity, update.analyzer_bundle_version, update.analysis_config_digest],
      );
      const previousPublicKey = previousHead.rows[0]?.current_public_snapshot_key ?? null;
      await client.query(
        `INSERT INTO canonical_public_repository_heads(
           repository_identity, analyzer_bundle_version, analysis_config_digest,
           current_public_snapshot_key, current_commit_sha, last_checked_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT(repository_identity, analyzer_bundle_version, analysis_config_digest)
         DO UPDATE SET
           current_public_snapshot_key = EXCLUDED.current_public_snapshot_key,
           current_commit_sha = EXCLUDED.current_commit_sha,
           last_checked_at = EXCLUDED.last_checked_at,
           updated_at = EXCLUDED.updated_at`,
        [
          update.repository_identity,
          update.analyzer_bundle_version,
          update.analysis_config_digest,
          input.publicKey,
          input.commitSha,
          input.completedAt,
        ],
      );
      await client.query(
        `UPDATE canonical_public_repository_snapshots
         SET retired_at = NULL, purge_after = NULL, payload_purged_at = NULL, last_used_at = $2
         WHERE public_snapshot_key = $1`,
        [input.publicKey, input.completedAt],
      );
      if (previousPublicKey && previousPublicKey !== input.publicKey) {
        await client.query(
          `INSERT INTO repository_revision_links(
             repository_identity, from_public_snapshot_key, to_public_snapshot_key, created_at
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT(from_public_snapshot_key, to_public_snapshot_key) DO NOTHING`,
          [update.repository_identity, previousPublicKey, input.publicKey, input.completedAt],
        );
      }
      await client.query(
        `UPDATE canonical_public_repository_snapshots
         SET retired_at = $4::timestamptz, purge_after = $4::timestamptz
         WHERE repository_identity = $1
           AND analyzer_bundle_version = $2
           AND analysis_config_digest = $3
           AND public_snapshot_key <> $5`,
        [
          update.repository_identity,
          update.analyzer_bundle_version,
          update.analysis_config_digest,
          input.completedAt,
          input.publicKey,
        ],
      );
      const joined = await client.query<{ project_id: string }>(
        `SELECT project.project_id
         FROM projects AS project
         WHERE EXISTS (
           SELECT 1
           FROM project_public_snapshot_bindings AS binding
           JOIN canonical_public_repository_snapshots AS snapshot
             ON snapshot.public_snapshot_key = binding.public_snapshot_key
           WHERE binding.project_id = project.project_id
             AND snapshot.repository_identity = $1
             AND snapshot.analyzer_bundle_version = $2
             AND snapshot.analysis_config_digest = $3
         )
         OR EXISTS (
           SELECT 1
           FROM repository_analysis_update_projects AS joined_project
           WHERE joined_project.update_id = $4
             AND joined_project.project_id = project.project_id
         )
         ORDER BY project.project_id
         FOR UPDATE OF project`,
        [update.repository_identity, update.analyzer_bundle_version, update.analysis_config_digest, input.updateId],
      );
      const affectedProjectIds = joined.rows.map((row) => row.project_id);
      const activeJobs = affectedProjectIds.length
        ? await client.query(
          `SELECT * FROM analysis_jobs
           WHERE project_id = ANY($1::text[])
             AND status IN ('queued', 'running')
           ORDER BY created_at DESC
           FOR UPDATE`,
          [affectedProjectIds],
        )
        : { rows: [] as Record<string, unknown>[] };
      const jobsByProject = new Map<string, AnalysisJob>();
      for (const row of activeJobs.rows) {
        const projectId = String(row.project_id);
        if (!jobsByProject.has(projectId)) jobsByProject.set(projectId, jobFromRow(row));
      }
      const activeOverlayLeaders = await client.query<{ language_overlay_key: string }>(
        `SELECT language_overlay_key FROM analysis_jobs
         WHERE execution_role = 'overlay'
           AND status IN ('queued', 'running')
           AND language_overlay_key LIKE $1
         FOR UPDATE`,
        [`${input.publicKey}:%`],
      );
      const overlayLeaders = new Set(activeOverlayLeaders.rows.map((row) => row.language_overlay_key));
      let fencedJobFinalized = false;
      const snapshotMode = await client.query<{ language_overlay_version: string | null }>(
        "SELECT language_overlay_version FROM canonical_public_repository_snapshots WHERE public_snapshot_key = $1",
        [input.publicKey],
      );
      const usesOverlays = Boolean(snapshotMode.rows[0]?.language_overlay_version);
      const readyLanguage = input.readyLanguage
        ? normalizeDisplayLanguage(input.readyLanguage).toLowerCase()
        : null;
      for (const row of joined.rows) {
        const project = await this.loadProjectWithDb(client, row.project_id);
        if (!project) continue;
        const previousProjectKey = project.analysis.canonical_snapshot_key;
        const previousSnapshotId = project.analysis.snapshot_id;
        const job = jobsByProject.get(project.project_id);
        const migrated = Boolean(previousProjectKey && previousProjectKey !== input.publicKey);
        let previousMetadata: { analysis_snapshot_id: string; commit_sha: string } | null = null;
        if (migrated && previousProjectKey) {
          const projectPreviousMetadata = await client.query<{
            analysis_snapshot_id: string;
            commit_sha: string;
          }>(
            `SELECT analysis_snapshot_id, commit_sha
             FROM canonical_public_repository_snapshots
            WHERE public_snapshot_key = $1`,
            [previousProjectKey],
          );
          previousMetadata = projectPreviousMetadata.rows[0] ?? null;
        }
        const projectLanguage = normalizeDisplayLanguage(project.display_language).toLowerCase();
        const existingOverlay = await client.query<{ status: SnapshotLanguageOverlay["status"] }>(
          `SELECT status FROM public_snapshot_language_overlays
           WHERE public_snapshot_key = $1 AND language = $2`,
          [input.publicKey, projectLanguage],
        );
        const overlayReady = !usesOverlays || projectLanguage === readyLanguage
          || ["ready", "degraded"].includes(existingOverlay.rows[0]?.status ?? "");
        const fromCommit = previousMetadata?.commit_sha ?? project.source.commit_sha ?? "";
        if (overlayReady) {
          recordAnalysisProgress(project.analysis, "interpreting", "completed", input.completedAt);
          recordAnalysisProgress(project.analysis, "completed", "completed", input.completedAt);
        } else {
          recordAnalysisProgress(project.analysis, "interpreting", "running", input.completedAt);
        }
        project.analysis.stage = overlayReady ? "done" : "interpreting";
        project.analysis.snapshot_id = input.snapshotId;
        project.analysis.file_count = input.fileCount;
        project.analysis.symbol_count = input.symbolCount;
        project.analysis.call_count = input.callCount;
        project.analysis.languages = [...input.languages];
        project.analysis.error = null;
        project.analysis.canonical_snapshot_key = input.publicKey;
        project.analysis.completed_at = overlayReady ? input.completedAt : null;
        project.source.commit_sha = input.commitSha;
        if (migrated && previousProjectKey) {
          project.repository_migration = {
            migration_id: randomUUID().replaceAll("-", ""),
            from_public_snapshot_key: previousProjectKey,
            to_public_snapshot_key: input.publicKey,
            from_snapshot_id: previousMetadata?.analysis_snapshot_id ?? previousSnapshotId ?? "",
            to_snapshot_id: input.snapshotId,
            from_commit_sha: fromCommit,
            to_commit_sha: input.commitSha,
            status: "executed",
            route_replanned: false,
            resume_step: project.study.current_step,
            summary: `仓库已自动迁移到 commit ${input.commitSha.slice(0, 12)}；历史回答仍标注原 commit ${fromCommit.slice(0, 12)}。`,
            created_at: input.completedAt,
            resolved_at: input.completedAt,
            executed_at: input.completedAt,
            error: null,
          };
        }
        project.updated_at = input.completedAt;
        await this.saveProjectWithClient(client, project, false);
        if (overlayReady) {
          if (job) {
            if (input.fence && !fencedJobFinalized) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
            await client.query(
              `UPDATE analysis_jobs SET
                 status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
                 heartbeat_at = $2, updated_at = $2, completed_at = $2,
                 error = NULL, error_code = NULL, language_overlay_key = NULL
               WHERE job_id = $1`,
              [job.job_id, input.completedAt],
            );
            if (input.fence && job.job_id === input.fence.jobId) fencedJobFinalized = true;
          }
          continue;
        }
        const overlayKey = snapshotLanguageOverlayKey(input.publicKey, projectLanguage);
        await client.query(
          `INSERT INTO public_snapshot_language_overlays(
             public_snapshot_key, language, status, payload, generated_at, error, updated_at
           ) VALUES ($1, $2, 'pending', NULL, NULL, NULL, now())
           ON CONFLICT(public_snapshot_key, language) DO UPDATE SET
             status = 'pending', payload = NULL, generated_at = NULL,
             error = NULL, updated_at = now()
           WHERE public_snapshot_language_overlays.status NOT IN ('ready', 'degraded')`,
          [input.publicKey, projectLanguage],
        );
        const keepsLeadership = job?.execution_role === "overlay" && job.language_overlay_key === overlayKey;
        const active = keepsLeadership || overlayLeaders.has(overlayKey);
        overlayLeaders.add(overlayKey);
        const overlayJob = job ?? {
          ...newAnalysisJob(project.project_id, `migration-overlay:${project.project_id}:${input.publicKey}:${randomUUID()}`),
          created_at: input.completedAt,
        };
        if (job) {
          if (input.fence && !fencedJobFinalized) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
          await client.query(
            `UPDATE analysis_jobs SET
               status = 'queued', attempt = 0, repository_update_id = NULL,
               execution_role = $2, language_overlay_key = $3,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
               updated_at = $4, completed_at = NULL, error = NULL, error_code = NULL
             WHERE job_id = $1`,
            [job.job_id, active ? "waiter" : "overlay", overlayKey, input.completedAt],
          );
        } else {
          await this.saveJobWithDb(client, {
            ...overlayJob,
            status: "queued",
            attempt: 0,
            repository_update_id: null,
            execution_role: active ? "waiter" : "overlay",
            language_overlay_key: overlayKey,
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
            updated_at: input.completedAt,
            available_at: input.completedAt,
            completed_at: null,
            error: null,
            error_code: null,
          });
        }
        if (input.fence && overlayJob.job_id === input.fence.jobId) fencedJobFinalized = true;
      }
       await client.query(
         `UPDATE repository_analysis_updates SET
           target_commit_sha = $2, status = 'succeeded', result_public_snapshot_key = $3,
           error = NULL, updated_at = $4, completed_at = $4,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = $4
         WHERE update_id = $1`,
         [input.updateId, input.commitSha, input.publicKey, input.completedAt],
       );
      await this.saveRevisionRedirectsWithDb(client, input.redirects);
      if (input.fence && !fencedJobFinalized) {
        // If the fenced job was not part of the joined update rows, it still
        // owns a running lease and must be checked before committing.
        await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      }
      await client.query("COMMIT");
      return joined.rows.map((row) => row.project_id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async failRepositoryUpdate(updateId: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const fencedProjectId = fence
        ? await this.resolveAnalysisProjectId(client, fence)
        : undefined;
      const scopeLocked = await this.lockRepositoryUpdateScope(
        client,
        updateId,
        fencedProjectId ? [fencedProjectId] : [],
      );
      if (!scopeLocked) {
        await client.query("ROLLBACK");
        return [];
      }
      if (fence) await this.assertAnalysisLeaseWithDb(client, fence, fencedProjectId);
      const update = await client.query(
        "SELECT update_id FROM repository_analysis_updates WHERE update_id = $1 FOR UPDATE",
        [updateId],
      );
      if (!update.rowCount) {
        await client.query("ROLLBACK");
        return [];
      }
      const timestamp = nowIso();
      const joined = await client.query<{ project_id: string }>(
        "SELECT project_id FROM repository_analysis_update_projects WHERE update_id = $1 FOR UPDATE",
        [updateId],
      );
      for (const row of joined.rows) {
        const project = await this.loadProjectWithDb(client, row.project_id);
        if (!project) continue;
        // A failed update must not destroy a usable previous snapshot. New
        // projects without a bound snapshot remain failed and retryable.
        recordAnalysisProgress(project.analysis, "failed", "failed", timestamp);
        if (project.analysis.canonical_snapshot_key) {
          project.analysis.stage = "done";
          project.analysis.error = null;
        } else {
          project.analysis.stage = "failed";
          project.analysis.error = error;
        }
        project.analysis.completed_at = timestamp;
        project.updated_at = timestamp;
        await this.saveProjectWithClient(client, project);
      }
      if (fence) await this.assertAnalysisLeaseWithDb(client, fence, fencedProjectId);
      await client.query(
        `UPDATE repository_analysis_updates SET
           status = 'failed', error = $2, updated_at = $3, completed_at = $3,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = $3
         WHERE update_id = $1`,
        [updateId, error, timestamp],
      );
      await client.query(
        `UPDATE analysis_jobs SET
           status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = $3, updated_at = $3, completed_at = $3,
           error = $2, error_code = 'repository_update_failed'
         WHERE repository_update_id = $1 AND status IN ('queued', 'running')`,
        [updateId, error, timestamp],
      );
      await client.query("COMMIT");
      return joined.rows.map((row) => row.project_id);
    } catch (caught) {
      await client.query("ROLLBACK");
      throw caught;
    } finally {
      client.release();
    }
  }

  override async loadSnapshotLanguageOverlay(publicKey: string, language: string): Promise<SnapshotLanguageOverlay | null> {
    const result = await this.pool.query<{
      public_snapshot_key: string;
      language: string;
      status: SnapshotLanguageOverlay["status"];
      payload: Record<string, unknown> | null;
      generated_at: Date | string | null;
      error: string | null;
    }>(
      `SELECT public_snapshot_key, language, status, payload, generated_at, error
       FROM public_snapshot_language_overlays
       WHERE public_snapshot_key = $1 AND language = $2`,
      [publicKey, language.toLowerCase()],
    );
    const row = result.rows[0];
    return row ? {
      public_snapshot_key: row.public_snapshot_key,
      language: row.language,
      status: row.status,
      payload: row.payload ? jsonObject<Record<string, unknown>>(row.payload) : null,
      generated_at: iso(row.generated_at),
      error: row.error,
    } : null;
  }

  override async listSnapshotLanguageOverlays(publicKey: string): Promise<SnapshotLanguageOverlay[]> {
    const result = await this.pool.query(
      `SELECT public_snapshot_key, language, status, payload, generated_at, error
       FROM public_snapshot_language_overlays
       WHERE public_snapshot_key = $1 ORDER BY language`,
      [publicKey],
    );
    return result.rows.map((row) => ({
      public_snapshot_key: String(row.public_snapshot_key),
      language: String(row.language),
      status: String(row.status) as SnapshotLanguageOverlay["status"],
      payload: row.payload ? jsonObject<Record<string, unknown>>(row.payload) : null,
      generated_at: iso(row.generated_at),
      error: row.error === null ? null : String(row.error),
    }));
  }

  override async saveSnapshotLanguageOverlay(input: {
    publicKey: string;
    language: string;
    status: SnapshotLanguageOverlay["status"];
    payload: SnapshotLanguageOverlayPayload | null;
    error?: string | null;
    fence?: AnalysisLeaseFence;
  }): Promise<void> {
    const write = (client: Db): Promise<unknown> => client.query(
      `INSERT INTO public_snapshot_language_overlays(
         public_snapshot_key, language, status, payload, generated_at, error, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
       ON CONFLICT(public_snapshot_key, language) DO UPDATE SET
         status = EXCLUDED.status, payload = EXCLUDED.payload,
         generated_at = EXCLUDED.generated_at, error = EXCLUDED.error,
         updated_at = now()`,
      [
        input.publicKey,
        input.language.toLowerCase(),
        input.status,
        input.payload ? JSON.stringify(input.payload) : null,
        input.payload ? input.payload.generated_at : null,
        input.error ?? null,
      ],
    );
    if (input.fence) {
      await this.withAnalysisLeaseTransaction(input.fence, async (client) => {
        await write(client);
      });
      return;
    }
    await write(this.pool);
  }

  override async createOrJoinSnapshotLanguageOverlay(input: {
    project: Project;
    job: AnalysisJob;
    publicKey: string;
    language: string;
    newProject: boolean;
    systemManaged?: boolean;
  }): Promise<{ job: AnalysisJob; ready: boolean }> {
    const language = normalizeDisplayLanguage(input.language).toLowerCase();
    const overlayKey = snapshotLanguageOverlayKey(input.publicKey, language);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, input.project.owner_id);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`snapshot-language:${overlayKey}`]);
      if (!input.systemManaged) await this.checkDbCreationQuotas(client, input.project.owner_id, input.newProject);
      if (!input.newProject) {
        const existingProject = await client.query(
          "SELECT 1 FROM projects WHERE project_id = $1 AND owner_id = $2 FOR UPDATE",
          [input.project.project_id, input.project.owner_id],
        );
        if (!existingProject.rowCount) throw new Error("project_not_found");
      }
      const overlay = await client.query<{ status: SnapshotLanguageOverlay["status"] }>(
        `SELECT status FROM public_snapshot_language_overlays
         WHERE public_snapshot_key = $1 AND language = $2 FOR UPDATE`,
        [input.publicKey, language],
      );
      const ready = ["ready", "degraded"].includes(overlay.rows[0]?.status ?? "");
      const timestamp = nowIso();
      input.project.analysis.stage = ready ? "done" : "interpreting";
      input.project.analysis.completed_at = ready ? timestamp : null;
      input.project.updated_at = timestamp;
      await this.saveProjectWithClient(client, input.project, !input.systemManaged);
      const active = ready ? false : Boolean((await client.query(
        `SELECT 1 FROM analysis_jobs
         WHERE language_overlay_key = $1 AND execution_role = 'overlay'
           AND status IN ('queued', 'running')
         LIMIT 1 FOR UPDATE`,
        [overlayKey],
      )).rowCount);
      if (!ready) {
        await client.query(
          `INSERT INTO public_snapshot_language_overlays(
             public_snapshot_key, language, status, payload, generated_at, error, updated_at
           ) VALUES ($1, $2, 'pending', NULL, NULL, NULL, now())
           ON CONFLICT(public_snapshot_key, language) DO UPDATE SET
             status = 'pending', payload = NULL, generated_at = NULL,
             error = NULL, updated_at = now()
           WHERE public_snapshot_language_overlays.status NOT IN ('ready', 'degraded')`,
          [input.publicKey, language],
        );
      }
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
      await this.saveJobWithDb(client, queued);
      if (!input.systemManaged) await this.recordQuotaEvent(client, input.project.owner_id, input.project.project_id);
      await client.query("COMMIT");
      return { job: queued, ready };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async publishSnapshotLanguageOverlay(input: SnapshotLanguageOverlayPublication & { fence?: AnalysisLeaseFence }): Promise<string[]> {
    const language = normalizeDisplayLanguage(input.language).toLowerCase();
    const overlayKey = snapshotLanguageOverlayKey(input.publicKey, language);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const fencedProjectId = input.fence
        ? await this.resolveAnalysisProjectId(client, input.fence)
        : undefined;
      await this.lockSnapshotLanguage(client, overlayKey);
      await this.lockSnapshotLanguageProjects(
        client,
        overlayKey,
        fencedProjectId ? [fencedProjectId] : [],
      );
      if (input.fence) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      await client.query(
        `INSERT INTO public_snapshot_language_overlays(
           public_snapshot_key, language, status, payload, generated_at, error, updated_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
         ON CONFLICT(public_snapshot_key, language) DO UPDATE SET
           status = EXCLUDED.status, payload = EXCLUDED.payload,
           generated_at = EXCLUDED.generated_at, error = EXCLUDED.error,
           updated_at = now()`,
        [input.publicKey, language, input.status, JSON.stringify(input.payload), input.payload.generated_at, input.error ?? null],
      );
      const jobs = await client.query(
        `SELECT * FROM analysis_jobs
         WHERE language_overlay_key = $1 AND status IN ('queued', 'running')
         ORDER BY created_at FOR UPDATE`,
        [overlayKey],
      );
      for (const row of jobs.rows) {
        const job = jobFromRow(row);
        const project = await this.loadProjectWithDb(client, job.project_id);
        if (project) {
          recordAnalysisProgress(project.analysis, "interpreting", "completed", input.completedAt);
          recordAnalysisProgress(project.analysis, "completed", input.status === "degraded" ? "degraded" : "completed", input.completedAt);
          project.analysis.stage = "done";
          project.analysis.error = null;
          project.analysis.completed_at = input.completedAt;
          if (project.repository_migration?.status === "confirmed"
            && project.repository_migration.to_public_snapshot_key === input.publicKey) {
            project.repository_migration.status = "executed";
            project.repository_migration.executed_at = input.completedAt;
            project.repository_migration.resolved_at ??= input.completedAt;
            project.repository_migration.error = null;
          }
          project.updated_at = input.completedAt;
          await this.saveProjectWithClient(client, project);
        }
      }
      if (input.fence) await this.assertAnalysisLeaseWithDb(client, input.fence, fencedProjectId);
      await client.query(
        `UPDATE analysis_jobs SET
           status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = $2, updated_at = $2, completed_at = $2,
           error = NULL, error_code = NULL
         WHERE language_overlay_key = $1 AND status IN ('queued', 'running')`,
        [overlayKey, input.completedAt],
      );
      await client.query("COMMIT");
      return jobs.rows.map((row) => String(row.project_id));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async failSnapshotLanguageOverlay(publicKey: string, languageValue: string, error: string, fence?: AnalysisLeaseFence): Promise<string[]> {
    const language = normalizeDisplayLanguage(languageValue).toLowerCase();
    const overlayKey = snapshotLanguageOverlayKey(publicKey, language);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const fencedProjectId = fence
        ? await this.resolveAnalysisProjectId(client, fence)
        : undefined;
      await this.lockSnapshotLanguage(client, overlayKey);
      await this.lockSnapshotLanguageProjects(
        client,
        overlayKey,
        fencedProjectId ? [fencedProjectId] : [],
      );
      if (fence) await this.assertAnalysisLeaseWithDb(client, fence, fencedProjectId);
      const timestamp = nowIso();
      await client.query(
        `INSERT INTO public_snapshot_language_overlays(
           public_snapshot_key, language, status, payload, generated_at, error, updated_at
         ) VALUES ($1, $2, 'failed', NULL, NULL, $3, now())
         ON CONFLICT(public_snapshot_key, language) DO UPDATE SET
           status = 'failed', payload = NULL, generated_at = NULL,
           error = EXCLUDED.error, updated_at = now()`,
        [publicKey, language, error],
      );
      const jobs = await client.query(
        `SELECT * FROM analysis_jobs
         WHERE language_overlay_key = $1 AND status IN ('queued', 'running')
         ORDER BY created_at FOR UPDATE`,
        [overlayKey],
      );
      for (const row of jobs.rows) {
        const job = jobFromRow(row);
        const project = await this.loadProjectWithDb(client, job.project_id);
        if (project) {
          recordAnalysisProgress(project.analysis, "failed", "failed", timestamp);
          project.analysis.stage = "failed";
          project.analysis.error = error;
          project.analysis.completed_at = timestamp;
          if (project.repository_migration?.status === "confirmed"
            && project.repository_migration.to_public_snapshot_key === publicKey) {
            project.repository_migration.status = "failed";
            project.repository_migration.error = error;
            project.repository_migration.resolved_at ??= timestamp;
          }
          project.updated_at = timestamp;
          await this.saveProjectWithClient(client, project);
        }
      }
      if (fence) await this.assertAnalysisLeaseWithDb(client, fence, fencedProjectId);
      await client.query(
        `UPDATE analysis_jobs SET
           status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = $2, updated_at = $2, completed_at = $2,
           error = $3, error_code = 'language_overlay_failed'
         WHERE language_overlay_key = $1 AND status IN ('queued', 'running')`,
        [overlayKey, timestamp, error],
      );
      await client.query("COMMIT");
      return jobs.rows.map((row) => String(row.project_id));
    } catch (caught) {
      await client.query("ROLLBACK");
      throw caught;
    } finally {
      client.release();
    }
  }

  override async saveRevisionRedirects(redirects: RevisionRedirect[]): Promise<void> {
    await this.saveRevisionRedirectsWithDb(this.pool, redirects);
  }

  override async saveRevisionLink(link: RevisionLink): Promise<void> {
    await this.pool.query(
      `INSERT INTO repository_revision_links(
         repository_identity, from_public_snapshot_key, to_public_snapshot_key, created_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT(from_public_snapshot_key, to_public_snapshot_key) DO UPDATE SET
         repository_identity = EXCLUDED.repository_identity,
         created_at = EXCLUDED.created_at`,
      [
        link.repository_identity.toLowerCase(),
        link.from_public_snapshot_key,
        link.to_public_snapshot_key,
        link.created_at,
      ],
    );
  }

  override async listRevisionLinks(repositoryIdentity: string): Promise<RevisionLink[]> {
    const result = await this.pool.query(
      `SELECT repository_identity, from_public_snapshot_key, to_public_snapshot_key, created_at
       FROM repository_revision_links
       WHERE repository_identity = $1
       ORDER BY created_at`,
      [repositoryIdentity.toLowerCase()],
    );
    return result.rows.map((row) => ({
      repository_identity: String(row.repository_identity),
      from_public_snapshot_key: String(row.from_public_snapshot_key),
      to_public_snapshot_key: String(row.to_public_snapshot_key),
      created_at: iso(row.created_at) ?? nowIso(),
    }));
  }

  override async listRevisionRedirects(repositoryIdentity: string): Promise<RevisionRedirect[]> {
    const result = await this.pool.query(
      `SELECT * FROM repository_revision_redirects
       WHERE repository_identity = $1
       ORDER BY created_at, old_path`,
      [repositoryIdentity.toLowerCase()],
    );
    return result.rows.map((row) => ({
      repository_identity: String(row.repository_identity),
      from_public_snapshot_key: String(row.from_public_snapshot_key),
      to_public_snapshot_key: String(row.to_public_snapshot_key),
      old_path: String(row.old_path),
      old_stable_id: row.old_stable_id ? String(row.old_stable_id) : null,
      kind: String(row.redirect_kind) as RevisionRedirect["kind"],
      candidates: jsonObject<RevisionRedirect["candidates"]>(row.candidates),
      created_at: iso(row.created_at) ?? nowIso(),
    }));
  }

  override async resolveRevisionRedirect(input: {
    fromPublicKey: string;
    toPublicKey: string;
    oldPath: string;
    oldStableId?: string | null;
  }): Promise<RevisionRedirect | null> {
    const endpointLinks = await this.pool.query(
      `SELECT repository_identity
       FROM repository_revision_links
       WHERE from_public_snapshot_key = $1 OR to_public_snapshot_key = $2
       ORDER BY created_at DESC LIMIT 1`,
      [input.fromPublicKey, input.toPublicKey],
    );
    const endpointRedirects = await this.pool.query<{ repository_identity: string }>(
      `SELECT repository_identity
       FROM repository_revision_redirects
       WHERE from_public_snapshot_key = $1 OR to_public_snapshot_key = $2
       ORDER BY created_at DESC LIMIT 1`,
      [input.fromPublicKey, input.toPublicKey],
    );
    const repository = endpointLinks.rows[0]?.repository_identity ?? endpointRedirects.rows[0]?.repository_identity;
    if (!repository) return null;
    const redirectsResult = await this.pool.query(
      `SELECT * FROM repository_revision_redirects
       WHERE repository_identity = $1`,
      [repository],
    );
    const redirects = redirectsResult.rows.map((row) => ({
      repository_identity: String(row.repository_identity),
      from_public_snapshot_key: String(row.from_public_snapshot_key),
      to_public_snapshot_key: String(row.to_public_snapshot_key),
      old_path: String(row.old_path),
      old_stable_id: row.old_stable_id ? String(row.old_stable_id) : null,
      kind: String(row.redirect_kind) as RevisionRedirect["kind"],
      candidates: jsonObject<RevisionRedirect["candidates"]>(row.candidates),
      created_at: iso(row.created_at) ?? nowIso(),
    }));
    const linksResult = await this.pool.query(
      `SELECT repository_identity, from_public_snapshot_key, to_public_snapshot_key, created_at
       FROM repository_revision_links
       WHERE repository_identity = $1`,
      [repository],
    );
    const links = linksResult.rows.map((row) => ({
      repository_identity: String(row.repository_identity),
      from_public_snapshot_key: String(row.from_public_snapshot_key),
      to_public_snapshot_key: String(row.to_public_snapshot_key),
      created_at: iso(row.created_at) ?? nowIso(),
    }));
    return resolveRevisionRedirectChain({ ...input, links, redirects });
  }

  override async findPublicSnapshotKeyBySnapshotId(snapshotId: string): Promise<string | null> {
    const result = await this.pool.query<{ public_snapshot_key: string }>(
      `SELECT public_snapshot_key FROM canonical_public_repository_snapshots
       WHERE analysis_snapshot_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [snapshotId],
    );
    return result.rows[0]?.public_snapshot_key ?? null;
  }

  override async listPurgeablePublicSnapshots(now: string): Promise<PublicSnapshotMetadata[]> {
    const result = await this.pool.query(
      `SELECT snapshot.public_snapshot_key, snapshot.repository_identity, snapshot.commit_sha,
              snapshot.analyzer_bundle_version, snapshot.analysis_config_digest,
              snapshot.analysis_snapshot_id, snapshot.language_overlay_version,
              snapshot.retired_at, snapshot.purge_after, snapshot.payload_purged_at
       FROM canonical_public_repository_snapshots AS snapshot
       WHERE snapshot.payload_purged_at IS NULL
         AND snapshot.purge_after IS NOT NULL
         AND snapshot.purge_after <= $1
         AND NOT EXISTS (
           SELECT 1 FROM project_public_snapshot_bindings AS binding
           WHERE binding.public_snapshot_key = snapshot.public_snapshot_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM canonical_public_repository_heads AS head
           WHERE head.current_public_snapshot_key = snapshot.public_snapshot_key
         )
       ORDER BY snapshot.purge_after`,
      [now],
    );
    return result.rows.map((row) => ({
      public_snapshot_key: String(row.public_snapshot_key),
      repository_identity: String(row.repository_identity),
      commit_sha: String(row.commit_sha),
      analyzer_bundle_version: String(row.analyzer_bundle_version),
      analysis_config_digest: String(row.analysis_config_digest),
      analysis_snapshot_id: String(row.analysis_snapshot_id),
      language_overlay_version: row.language_overlay_version === null ? null : String(row.language_overlay_version),
      retired_at: iso(row.retired_at),
      purge_after: iso(row.purge_after),
      payload_purged_at: iso(row.payload_purged_at),
    }));
  }

  async adminDeleteRepository(repository: string, expectedToken: string, actor: string): Promise<void> {
    if(!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('admin_invalid_repository');
    const client=await this.pool.connect();
    const maintenanceKey='repository-cleanup:'+repository;
    let acquired=false, staged=false;
    let affectedProjectIds:string[]=[];
    const fail=(code:string)=>Object.assign(new Error(code),{code,statusCode:409});
    try {
      acquired=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtextextended('repository-payload-use',0)) AS acquired")).rows[0].acquired);
      if(!acquired) throw fail('admin_repository_in_use');
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query('LOCK TABLE analysis_jobs,project_public_snapshot_bindings,canonical_public_repository_heads,canonical_public_repository_snapshots,projects IN SHARE ROW EXCLUSIVE MODE');
      if(Number((await client.query("SELECT count(*) AS n FROM analysis_jobs WHERE status IN ('queued','running')")).rows[0].n)) throw fail('admin_snapshot_busy');
      const snapshots=(await client.query('SELECT public_snapshot_key,payload_purged_at FROM canonical_public_repository_snapshots WHERE repository_identity=$1 ORDER BY public_snapshot_key',[repository])).rows;
      const bindings=(await client.query(`SELECT b.project_id,b.public_snapshot_key FROM project_public_snapshot_bindings b
        JOIN canonical_public_repository_snapshots s USING(public_snapshot_key) WHERE s.repository_identity=$1 ORDER BY b.project_id`,[repository])).rows;
      const legacy=(await client.query(`SELECT s.project_id,s.analysis_snapshot_id FROM project_snapshots s JOIN projects p USING(project_id)
        WHERE lower(regexp_replace(regexp_replace(p.payload->'source'->>'value','^https?://github.com/','','i'),'(\\.git)?/?$',''))=$1
        AND p.payload->'source'->>'kind'='github'
        AND NOT EXISTS(SELECT 1 FROM project_public_snapshot_bindings b WHERE b.project_id=p.project_id) ORDER BY s.project_id`,[repository])).rows;
      const token=createHash('sha256').update(JSON.stringify({repository,snapshots,bindings,legacy})).digest('hex');
      if(token!==expectedToken) throw fail('admin_repository_changed');
      const keys=snapshots.map(s=>String(s.public_snapshot_key));
      if(keys.some(key=>!/^([a-f0-9]{64})$/.test(key))) throw fail('admin_invalid_snapshot');
      const prior=(await client.query('SELECT value FROM admin_documents WHERE key=$1',[maintenanceKey])).rows[0]?.value;
      const currentProjects=[...bindings.map(b=>String(b.project_id)),...legacy.map(p=>String(p.project_id))];
      affectedProjectIds=[...new Set<string>([...currentProjects,...(Array.isArray(prior?.projectIds)?prior.projectIds.filter((v:unknown)=>typeof v==='string'):[])])];
      if(!keys.length&&!affectedProjectIds.length) throw fail('admin_repository_not_found');
      // First commit a durable withdrawal. Partial object deletion must never restore a usable-looking snapshot.
      await client.query(`UPDATE projects SET payload=jsonb_set(payload,'{analysis}',
        (payload->'analysis')||jsonb_build_object('stage','failed','snapshot_id',NULL,'canonical_snapshot_key',NULL,'removed_by_admin',true,
        'error','管理员已清理此仓库的分析资料；对话历史保留，请重新分析后继续。')),updated_at=clock_timestamp()
        WHERE project_id=ANY($1::text[])`,[currentProjects]);
      await client.query('DELETE FROM project_snapshots WHERE project_id=ANY($1::text[])',[currentProjects]);
      await client.query('DELETE FROM semantic_batches WHERE job_id IN (SELECT job_id FROM analysis_jobs WHERE project_id=ANY($1::text[]))',[currentProjects]);
      await client.query('DELETE FROM project_public_snapshot_bindings WHERE public_snapshot_key=ANY($1::text[])',[keys]);
      await client.query('DELETE FROM canonical_public_repository_heads WHERE repository_identity=$1',[repository]);
      await client.query(`UPDATE canonical_public_repository_snapshots SET retired_at=clock_timestamp(),purge_after=clock_timestamp(),
        payload_purged_at=COALESCE(payload_purged_at,clock_timestamp()) WHERE public_snapshot_key=ANY($1::text[])`,[keys]);
      await client.query(`INSERT INTO admin_documents(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,
        [maintenanceKey,{status:'pending',actor,keys,projectIds:affectedProjectIds,updatedAt:new Date().toISOString()}]);
      await client.query('COMMIT'); staged=true;
      for(const key of keys) if(!await this.purgePublicSnapshotPayload(key,new Date().toISOString(),true,client)) throw fail('admin_snapshot_busy');
      for(const id of affectedProjectIds) {
        if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw fail('admin_invalid_project');
        await rm(join(this.root,'source-snapshots',id),{recursive:true,force:true});
        for(const folder of ['snapshots','analysis-results','analysis-checkpoints']) await rm(join(this.root,folder,id+'.json'),{force:true});
      }
      await client.query(`UPDATE admin_documents SET value=value||jsonb_build_object('status','completed','updatedAt',clock_timestamp()),updated_at=clock_timestamp() WHERE key=$1`,[maintenanceKey]);
    } catch(error) {
      await client.query('ROLLBACK');
      if(staged) await client.query(`UPDATE admin_documents SET value=value||jsonb_build_object('status','failed','updatedAt',clock_timestamp()),updated_at=clock_timestamp() WHERE key=$1`,[maintenanceKey]);
      throw error;
    } finally {
      try { if(acquired) await client.query("SELECT pg_advisory_unlock(hashtextextended('repository-payload-use',0))"); }
      finally { client.release(); }
    }
  }

  override async purgePublicSnapshotPayload(publicKey: string, purgedAt: string, administrator = false, maintenanceClient?: PoolClient): Promise<boolean> {
    const client = maintenanceClient ?? await this.pool.connect();
    let metadata: PublicSnapshotMetadata | null = null;
    let objectKeys: string[] = [];
    let sourceManifestObject: { key: string; bytes: number; sha256: string } | null = null;
    let analysisObject: { key: string; bytes: number; sha256: string } | null = null;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE analysis_jobs, project_public_snapshot_bindings, canonical_public_repository_heads IN SHARE ROW EXCLUSIVE MODE");
      const locked = await client.query(
        `SELECT public_snapshot_key, repository_identity, commit_sha,
                analyzer_bundle_version, analysis_config_digest, analysis_snapshot_id,
                language_overlay_version, retired_at, purge_after, payload_purged_at,
                source_storage_key, source_manifest_sha256, source_manifest_bytes, source_file_count,
                view_storage_key, analysis_storage_key, manifest_storage_key,
                analysis_sha256, analysis_bytes
         FROM canonical_public_repository_snapshots
         WHERE public_snapshot_key = $1 FOR UPDATE`,
        [publicKey],
      );
      const row = locked.rows[0];
      if (!row || (!administrator && row.payload_purged_at) || !row.purge_after || new Date(row.purge_after).getTime() > Date.parse(purgedAt)) {
        await client.query("ROLLBACK");
        return false;
      }
      const referenced = await client.query(
        `SELECT 1
         WHERE EXISTS (SELECT 1 FROM analysis_jobs WHERE status IN ('queued','running'))
            OR EXISTS (SELECT 1 FROM project_public_snapshot_bindings WHERE public_snapshot_key = $1)
            OR EXISTS (SELECT 1 FROM canonical_public_repository_heads WHERE current_public_snapshot_key = $1)`,
        [publicKey],
      );
      if (referenced.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      metadata = {
        public_snapshot_key: String(row.public_snapshot_key),
        repository_identity: String(row.repository_identity),
        commit_sha: String(row.commit_sha),
        analyzer_bundle_version: String(row.analyzer_bundle_version),
        analysis_config_digest: String(row.analysis_config_digest),
        analysis_snapshot_id: String(row.analysis_snapshot_id),
        language_overlay_version: row.language_overlay_version === null ? null : String(row.language_overlay_version),
        retired_at: iso(row.retired_at),
        purge_after: iso(row.purge_after),
        payload_purged_at: null,
      };
      objectKeys = [
        row.view_storage_key ?? `public-repository-snapshots/${publicKey}/view.json`,
        row.analysis_storage_key ?? `public-repository-snapshots/${publicKey}/analysis.json`,
        row.manifest_storage_key ?? `public-repository-snapshots/${publicKey}/manifest.json`,
      ];
      if (row.analysis_storage_key && row.analysis_sha256 !== null && row.analysis_bytes !== null) {
        analysisObject = {
          key: String(row.analysis_storage_key),
          bytes: Number(row.analysis_bytes),
          sha256: String(row.analysis_sha256),
        };
      }
      const sourceFields = [row.source_manifest_sha256, row.source_manifest_bytes, row.source_file_count];
      const hasSourceManifest = sourceFields.some((value) => value !== null);
      if (hasSourceManifest) {
        if (!row.source_storage_key || sourceFields.some((value) => value === null)) {
          throw new Error("public_source_manifest_metadata_invalid");
        }
        sourceManifestObject = {
          key: String(row.source_storage_key),
          bytes: Number(row.source_manifest_bytes),
          sha256: String(row.source_manifest_sha256),
        };
        objectKeys.push(sourceManifestObject.key);
      }
      await client.query(
        "DELETE FROM snapshot_query_directories WHERE public_snapshot_key = $1",
        [publicKey],
      );
      await client.query('DELETE FROM public_snapshot_language_overlays WHERE public_snapshot_key=$1',[publicKey]);
      if(administrator) await client.query(`DELETE FROM semantic_batches WHERE snapshot_id=$1 AND job_id IN (
        SELECT j.job_id FROM analysis_jobs j JOIN projects p USING(project_id)
        WHERE lower(regexp_replace(regexp_replace(p.payload->'source'->>'value','^https?://github.com/','','i'),'(\\.git)?/?$',''))=$2
      )`,[row.analysis_snapshot_id,row.repository_identity]);
      await client.query(
        `UPDATE canonical_public_repository_snapshots SET
           view_payload = NULL, analysis_payload = NULL,
           source_storage_key = NULL, view_storage_key = NULL, analysis_storage_key = NULL,
           manifest_storage_key = NULL, manifest_sha256 = NULL, manifest_bytes = NULL,
           view_sha256 = NULL, view_bytes = NULL,
           analysis_sha256 = NULL, analysis_bytes = NULL,
           source_manifest_sha256 = NULL, source_manifest_bytes = NULL, source_file_count = NULL,
           logical_bytes = 0, payload_purged_at = $2
         WHERE public_snapshot_key = $1`,
        [publicKey, purgedAt],
      );
      if (!metadata) throw new Error("snapshot_metadata_missing");
      if (analysisObject) {
        try {
          const body = verifySnapshotObject<unknown>(
            await this.snapshotObjects.get(analysisObject.key),
            analysisObject,
          );
          objectKeys.push(...analysisPayloadChunkKeys(body));
        } catch {
          // The unreferenced row stays locked. Never trust a damaged analysis
          // envelope for deletion; the scoped object inventory below covers remaining chunks.
        }
      }
      if (sourceManifestObject) {
        try {
          const body = verifySourceSnapshotObject(
            await this.snapshotObjects.get(sourceManifestObject.key),
            sourceManifestObject,
          );
          const manifest = parseSourceSnapshotManifest(body, {
            publicKey,
            snapshotId: metadata.analysis_snapshot_id,
          });
          objectKeys.push(...manifest.files.map((file) => file.key));
        } catch {
          // The unreferenced row stays locked. Never trust a damaged manifest
          // for deletion; the scoped object inventory below covers remaining objects.
        }
      }
      if (this.snapshotObjects.inventory) {
        const objects = await this.snapshotObjects.inventory();
        objectKeys.push(...objects.filter(object => object.key.startsWith(`public-repository-snapshots/${publicKey}/`)).map(object => object.key));
      }
      this.forgetSourceManifest(publicKey);
      const deletions = await Promise.allSettled([
        ...[...new Set(objectKeys)].map((key) => this.snapshotObjects.purge?.(key) ?? this.snapshotObjects.delete(key)),
        rm(join(this.root, "public-repository-snapshots", publicKey, "view.json"), { force: true }),
        rm(join(this.root, "public-repository-snapshots", publicKey, "analysis.json"), { force: true }),
        rm(join(this.root, "public-repository-snapshots", publicKey, "analysis-chunks"), { recursive: true, force: true }),
        rm(join(this.root, "snapshot-language-overlays", publicKey), { recursive: true, force: true }),
        rm(this.publicSourceSnapshotRoot(publicKey, metadata.analysis_snapshot_id), { recursive: true, force: true }),
      ]);
      if (deletions.some(result => result.status === "rejected")) throw new Error("storage_delete_incomplete");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!maintenanceClient) client.release();
    }
    return true;
  }

  override async executeRepositoryMigration(input: {
    projectId: string;
    ownerId: string;
    migrationId: string;
    routeReplanned?: boolean;
    summary?: string | null;
    migration?: RepositoryMigrationAction;
  }): Promise<Project | null> {
    const initialProject = await this.loadProject(input.projectId, input.ownerId);
    const initialMigration = input.migration ?? initialProject?.repository_migration;
    if (!initialProject || !initialMigration || initialMigration.migration_id !== input.migrationId) return null;
    if (!input.migration && initialMigration.status === "executed") return initialProject;
    if (initialMigration.status !== "pending" && initialMigration.status !== "confirmed") throw new Error("repository_migration_not_pending");
    const metadata = await this.loadPublicSnapshotMetadata(initialMigration.to_public_snapshot_key);
    const bundle = await this.loadPublicSnapshot<Record<string, unknown>>(initialMigration.to_public_snapshot_key);
    if (!metadata || !bundle) throw new Error("repository_migration_target_missing");
    const view = bundle.view;
    const summary = view && typeof view === "object" && !Array.isArray(view)
      ? (view as Record<string, unknown>).summary as Record<string, unknown> | undefined
      : undefined;
    const languages = view && typeof view === "object" && !Array.isArray(view)
      && Array.isArray((view as Record<string, unknown>).languages)
      ? (view as Record<string, unknown>).languages as Array<{ language?: unknown }>
      : [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockProject(client, input.projectId);
      await client.query("SELECT project_id FROM projects WHERE project_id = $1 FOR UPDATE", [input.projectId]);
      const project = await this.loadProjectWithDb(client, input.projectId, input.ownerId);
      if (!project) {
        await client.query("ROLLBACK");
        return null;
      }
      const migration = input.migration ?? project.repository_migration;
      if (!migration || migration.migration_id !== input.migrationId) {
        await client.query("ROLLBACK");
        return null;
      }
      if (!input.migration && migration.status === "executed") {
        await client.query("COMMIT");
        return project;
      }
      if (project.analysis.canonical_snapshot_key
        && project.analysis.canonical_snapshot_key !== migration.from_public_snapshot_key
        && project.analysis.canonical_snapshot_key !== migration.to_public_snapshot_key) {
        await client.query("COMMIT");
        return project;
      }
      if (migration.status !== "pending" && migration.status !== "confirmed") throw new Error("repository_migration_not_pending");
      const language = normalizeDisplayLanguage(project.display_language).toLowerCase();
      const overlayResult = metadata.language_overlay_version
        ? await client.query<{ status: SnapshotLanguageOverlay["status"] }>(
          `SELECT status FROM public_snapshot_language_overlays
           WHERE public_snapshot_key = $1 AND language = $2`,
          [migration.to_public_snapshot_key, language],
        )
        : { rows: [] as Array<{ status: SnapshotLanguageOverlay["status"] }> };
      const overlayReady = !metadata.language_overlay_version
        || ["ready", "degraded"].includes(overlayResult.rows[0]?.status ?? "");
      const timestamp = nowIso();
      project.analysis = {
        ...project.analysis,
        stage: overlayReady ? "done" : "interpreting",
        snapshot_id: metadata.analysis_snapshot_id,
        file_count: Number(summary?.file_count ?? project.analysis.file_count),
        symbol_count: Number(summary?.symbol_count ?? project.analysis.symbol_count),
        call_count: Number(summary?.call_count ?? project.analysis.call_count),
        languages: languages.map((item) => typeof item.language === "string" ? item.language : "").filter(Boolean),
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
      await this.saveProjectWithClient(client, project, false);
      await client.query("COMMIT");
      return project;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async saveJob(job: AnalysisJob): Promise<void> {
    await this.saveJobWithDb(this.pool, job);
  }

  override async loadJob(jobId: string): Promise<AnalysisJob | null> {
    const result = await this.pool.query("SELECT * FROM analysis_jobs WHERE job_id = $1", [jobId]);
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  override async listJobs(): Promise<AnalysisJob[]> {
    const result = await this.pool.query("SELECT * FROM analysis_jobs ORDER BY created_at");
    return result.rows.map(jobFromRow);
  }

  override async latestJob(projectId: string): Promise<AnalysisJob | null> {
    const result = await this.pool.query(
      "SELECT * FROM analysis_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  override async cancelAnalysisJob(
    projectId: string,
    ownerId: string,
    expectedJobId?: string,
  ): Promise<AnalysisJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const projectRow = await client.query(
        "SELECT project_id FROM projects WHERE project_id = $1 AND owner_id = $2",
        [projectId, ownerId],
      );
      if (!projectRow.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const candidateResult = await client.query(
        `SELECT * FROM analysis_jobs
         WHERE project_id = $1
           AND status IN ('queued', 'running')
           ${expectedJobId ? "AND job_id = $2" : ""}
         ORDER BY created_at DESC
         LIMIT 1`,
        expectedJobId ? [projectId, expectedJobId] : [projectId],
      );
      if (!candidateResult.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const candidate = jobFromRow(candidateResult.rows[0]);
      if (candidate.repository_update_id) {
        const locked = await this.lockRepositoryUpdateScope(client, candidate.repository_update_id, [projectId]);
        if (!locked) await this.lockProject(client, projectId);
      } else if (candidate.language_overlay_key) {
        await this.lockSnapshotLanguage(client, candidate.language_overlay_key);
        await this.lockSnapshotLanguageProjects(client, candidate.language_overlay_key, [projectId]);
      } else {
        await this.lockProject(client, projectId);
      }

      const lockedJobResult = await client.query(
        "SELECT * FROM analysis_jobs WHERE job_id = $1 FOR UPDATE",
        [candidate.job_id],
      );
      const current = lockedJobResult.rows[0] ? jobFromRow(lockedJobResult.rows[0]) : null;
      if (!current
        || current.project_id !== projectId
        || (expectedJobId && current.job_id !== expectedJobId)
        || (current.status !== "queued" && current.status !== "running")) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.repository_update_id !== candidate.repository_update_id
        || current.language_overlay_key !== candidate.language_overlay_key) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        "SELECT project_id FROM projects WHERE project_id = $1 AND owner_id = $2 FOR UPDATE",
        [projectId, ownerId],
      );
      const timestamp = nowIso();
      await client.query(
        `UPDATE analysis_jobs SET
           status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = $2, updated_at = $2, completed_at = $2,
           error = $3, error_code = 'analysis_cancelled'
         WHERE job_id = $1`,
        [current.job_id, timestamp, "分析已停止，可重新分析。"],
      );

      if (current.repository_update_id) {
        await client.query(
          `DELETE FROM repository_analysis_update_projects
           WHERE update_id = $1 AND project_id = $2`,
          [current.repository_update_id, projectId],
        );
        const active = await client.query<{ job_id: string; project_id: string; execution_role: string }>(
          `SELECT job_id, project_id, execution_role
           FROM analysis_jobs
           WHERE repository_update_id = $1 AND status IN ('queued', 'running')
           ORDER BY created_at FOR UPDATE`,
          [current.repository_update_id],
        );
        if (!active.rowCount) {
          await client.query(
            `UPDATE repository_analysis_updates SET
               status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = $2,
               error = CASE WHEN status IN ('queued', 'running') THEN $3 ELSE error END,
               updated_at = $2,
               completed_at = CASE WHEN status IN ('queued', 'running') THEN $2 ELSE completed_at END
             WHERE update_id = $1`,
            [current.repository_update_id, timestamp, "分析已停止，可重新分析。"],
          );
        } else if (current.execution_role === "leader") {
          const replacement = active.rows.find((row) => row.execution_role === "waiter" || row.execution_role === "leader");
          if (replacement) {
            await client.query(
              `UPDATE repository_analysis_updates
               SET leader_project_id = $2, lease_owner = NULL, lease_expires_at = NULL,
                   heartbeat_at = $3, updated_at = $3
               WHERE update_id = $1`,
              [current.repository_update_id, replacement.project_id, timestamp],
            );
            await client.query(
              "UPDATE analysis_jobs SET execution_role = 'leader', updated_at = $2 WHERE job_id = $1",
              [replacement.job_id, timestamp],
            );
          }
        }
      } else if (current.language_overlay_key) {
        const active = await client.query<{ job_id: string; project_id: string; execution_role: string }>(
          `SELECT job_id, project_id, execution_role
           FROM analysis_jobs
           WHERE language_overlay_key = $1 AND status IN ('queued', 'running')
           ORDER BY created_at FOR UPDATE`,
          [current.language_overlay_key],
        );
        if (!active.rowCount) {
          const separator = current.language_overlay_key.indexOf(":");
          const publicKey = separator > 0 ? current.language_overlay_key.slice(0, separator) : "";
          const language = separator > 0 ? current.language_overlay_key.slice(separator + 1) : "";
          if (publicKey && language) {
            await client.query(
              `UPDATE public_snapshot_language_overlays SET
                 status = 'failed', payload = NULL, generated_at = NULL,
                 error = $3, updated_at = $2
               WHERE public_snapshot_key = $1 AND language = $4
                 AND status NOT IN ('ready', 'degraded')`,
              [publicKey, timestamp, "分析已停止，可重新分析。", language],
            );
          }
        } else if (current.execution_role === "overlay") {
          const replacement = active.rows.find((row) => row.execution_role === "waiter" || row.execution_role === "overlay");
          if (replacement) {
            await client.query(
              "UPDATE analysis_jobs SET execution_role = 'overlay', updated_at = $2 WHERE job_id = $1",
              [replacement.job_id, timestamp],
            );
          }
        }
      }

      const project = await this.loadProjectWithDb(client, projectId, ownerId);
      if (!project) {
        await client.query("ROLLBACK");
        return null;
      }
      project.analysis.stage = "failed";
      recordAnalysisProgress(project.analysis, "cancelled", "cancelled", timestamp);
      project.analysis.error = "分析已停止，可重新分析。";
      project.analysis.completed_at = timestamp;
      project.updated_at = timestamp;
      await this.saveProjectWithClient(client, project);
      await client.query("COMMIT");
      return {
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
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async claimAnalysisJob(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null> {
    await this.pool.query(
      `WITH expired AS (
         SELECT job_id FROM analysis_jobs
         WHERE status = 'running' AND attempt >= max_attempts
           AND lease_expires_at <= clock_timestamp()
         FOR UPDATE SKIP LOCKED
       )
       UPDATE analysis_jobs AS job SET
         status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
         heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(),
         completed_at = clock_timestamp(),
         error = 'analysis job lease expired after maximum attempts',
         error_code = 'lease_attempts_exhausted'
       FROM expired WHERE job.job_id = expired.job_id`,
    );
    const result = await this.pool.query(
      `WITH candidate AS (
       SELECT job_id FROM analysis_jobs
         WHERE execution_role <> 'waiter'
           AND attempt < max_attempts AND available_at <= clock_timestamp() AND (
           status = 'queued' OR (status = 'running' AND lease_expires_at <= clock_timestamp())
         )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE analysis_jobs AS job SET
         status = 'running', attempt = job.attempt + 1, lease_owner = $1,
         lease_expires_at = clock_timestamp() + ($2 * interval '1 second'),
         heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(),
         completed_at = NULL, error = NULL, error_code = NULL
       FROM candidate WHERE job.job_id = candidate.job_id
       RETURNING job.*`,
      [workerId, leaseSeconds],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  override async heartbeatAnalysisJob(
    jobId: string,
    workerId: string,
    attempt: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE analysis_jobs SET
         heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + ($4 * interval '1 second'),
         updated_at = clock_timestamp()
       WHERE job_id = $1 AND status = 'running' AND lease_owner = $2
         AND attempt = $3 AND lease_expires_at > clock_timestamp()`,
      [jobId, workerId, attempt, leaseSeconds],
    );
    return Boolean(result.rowCount);
  }

  override async finishAnalysisJob(job: AnalysisJob, workerId: string, attempt: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE analysis_jobs SET
         status = $4, lease_owner = $5, lease_expires_at = $6,
         heartbeat_at = $7, updated_at = $8, available_at = $9,
         completed_at = $10, error = $11, error_code = $12
       WHERE job_id = $1 AND status = 'running' AND lease_owner = $2
         AND attempt = $3 AND lease_expires_at > clock_timestamp()`,
      [
        job.job_id,
        workerId,
        attempt,
        job.status,
        job.lease_owner,
        job.lease_expires_at,
        job.heartbeat_at,
        job.updated_at,
        job.available_at,
        job.completed_at,
        job.error,
        job.error_code ?? null,
      ],
    );
    return Boolean(result.rowCount);
  }

  override async releaseAnalysisJobForResume(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE analysis_jobs SET
         status = 'queued', attempt = GREATEST(0, attempt - 1),
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         available_at = clock_timestamp(), updated_at = clock_timestamp(),
         completed_at = NULL, error = NULL, error_code = NULL
       WHERE job_id = $1 AND status = 'running' AND lease_owner = $2
         AND attempt = $3`,
      [jobId, workerId, attempt],
    );
    return Boolean(result.rowCount);
  }

  override async saveSemanticBatch(batch: SemanticBatch, fence?: AnalysisLeaseFence): Promise<void> {
    const write = async (db: Db): Promise<void> => {
      await db.query(
        `INSERT INTO semantic_batches(
           job_id, batch_id, snapshot_id, phase, ordinal, input_digest, output_digest,
           status, attempt, lease_owner, lease_expires_at, checkpoint, output, error,
           created_at, updated_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17)
         ON CONFLICT(job_id, batch_id) DO UPDATE SET
           snapshot_id = EXCLUDED.snapshot_id,
           phase = EXCLUDED.phase,
           ordinal = EXCLUDED.ordinal,
           input_digest = EXCLUDED.input_digest,
           output_digest = EXCLUDED.output_digest,
           status = EXCLUDED.status,
           attempt = EXCLUDED.attempt,
           lease_owner = EXCLUDED.lease_owner,
           lease_expires_at = EXCLUDED.lease_expires_at,
           checkpoint = EXCLUDED.checkpoint,
           output = EXCLUDED.output,
           error = EXCLUDED.error,
           updated_at = EXCLUDED.updated_at,
           completed_at = EXCLUDED.completed_at`,
        [
          batch.job_id, batch.batch_id, batch.snapshot_id, batch.phase, batch.ordinal,
          batch.input_digest, batch.output_digest, batch.status, batch.attempt,
          batch.lease_owner, batch.lease_expires_at, JSON.stringify(batch.checkpoint),
          batch.output === null || batch.output === undefined ? null : JSON.stringify(batch.output),
          batch.error, batch.created_at, batch.updated_at, batch.completed_at,
        ],
      );
    };
    if (fence) {
      await this.withAnalysisLeaseTransaction(fence, write);
      return;
    }
    await write(this.pool);
  }

  override async loadSemanticBatch(jobId: string, batchId: string): Promise<SemanticBatch | null> {
    const result = await this.pool.query(
      "SELECT * FROM semantic_batches WHERE job_id = $1 AND batch_id = $2",
      [jobId, batchId],
    );
    return result.rows[0] ? semanticBatchFromRow(result.rows[0]) : null;
  }

  override async listSemanticBatches(jobId: string): Promise<SemanticBatch[]> {
    const result = await this.pool.query(
      "SELECT * FROM semantic_batches WHERE job_id = $1 ORDER BY ordinal, batch_id",
      [jobId],
    );
    return result.rows.map(semanticBatchFromRow);
  }

  override async cancelSemanticBatches(
    jobId: string,
    reason: string,
    fence?: AnalysisLeaseFence,
  ): Promise<void> {
    const cancel = async (db: Db): Promise<void> => {
      await db.query(
        `UPDATE semantic_batches
         SET status = 'cancelled', error = $2, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = now(), completed_at = now()
         WHERE job_id = $1 AND status IN ('pending', 'running')`,
        [jobId, reason],
      );
    };
    if (fence) {
      await this.withAnalysisLeaseTransaction(fence, cancel);
      return;
    }
    await cancel(this.pool);
  }

  override async saveProfile(ownerId: string, profile: LearnerProfile): Promise<void> {
    await this.pool.query(
      `INSERT INTO learner_profiles(owner_id, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT(owner_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [ownerId, JSON.stringify(profile)],
    );
  }

  override async loadProfile(ownerId: string): Promise<LearnerProfile> {
    const result = await this.pool.query<{ payload: LearnerProfile }>(
      "SELECT payload FROM learner_profiles WHERE owner_id = $1",
      [ownerId],
    );
    return result.rows[0] ? normalizeProfile(jsonObject<unknown>(result.rows[0].payload)) : emptyProfile();
  }

  override async saveSettings(ownerId: string, settings: ProviderSettings): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_settings(owner_id, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT(owner_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [ownerId, JSON.stringify(settings)],
    );
  }

  override async loadSettings(ownerId: string): Promise<ProviderSettings> {
    const result = await this.pool.query<{ payload: ProviderSettings }>(
      "SELECT payload FROM provider_settings WHERE owner_id = $1",
      [ownerId],
    );
    return result.rows[0] ? normalizeSettings(result.rows[0].payload) : emptySettings();
  }

  override async saveUser(ownerId: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_users(owner_id, login, display_name, avatar_url, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT(owner_id) DO UPDATE SET
         login = EXCLUDED.login,
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         payload = EXCLUDED.payload,
         updated_at = now()`,
      [
        ownerId,
        String(payload.login ?? ownerId),
        String(payload.display_name ?? payload.login ?? ownerId),
        payload.avatar_url ?? null,
        JSON.stringify(payload),
      ],
    );
  }

  override async loadUser(ownerId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{
      owner_id: string;
      login: string;
      display_name: string;
      avatar_url: string | null;
      payload: Record<string, unknown>;
    }>("SELECT owner_id, login, display_name, avatar_url, payload FROM app_users WHERE owner_id = $1", [ownerId]);
    const row = result.rows[0];
    return row ? {
      ...jsonObject<Record<string, unknown>>(row.payload),
      owner_id: row.owner_id,
      login: row.login,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    } : null;
  }

  override async touchOwner(
    ownerId: string,
    seenAt: string,
    minimumIntervalMs: number,
  ): Promise<OwnerLifecycle | null> {
    const result = await this.pool.query<{
      owner_id: string;
      last_seen_at: Date | string;
      deleted_at: Date | string | null;
      purge_after: Date | string | null;
    }>(
      `UPDATE app_users
       SET last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at <= $2::timestamptz - ($3 * interval '1 millisecond')
             THEN $2::timestamptz
             ELSE last_seen_at
           END,
           deleted_at = CASE
             WHEN deleted_at IS NOT NULL AND (purge_after IS NULL OR purge_after > $2::timestamptz)
             THEN NULL ELSE deleted_at END,
           purge_after = CASE
             WHEN deleted_at IS NOT NULL AND (purge_after IS NULL OR purge_after > $2::timestamptz)
             THEN NULL ELSE purge_after END,
           updated_at = now()
       WHERE owner_id = $1
         AND (deleted_at IS NULL OR purge_after IS NULL OR purge_after > $2::timestamptz)
       RETURNING owner_id, last_seen_at, deleted_at, purge_after`,
      [ownerId, seenAt, Math.max(0, Math.floor(minimumIntervalMs))],
    );
    const row = result.rows[0];
    return row ? {
      owner_id: row.owner_id,
      last_seen_at: iso(row.last_seen_at) ?? seenAt,
      deleted_at: iso(row.deleted_at),
      purge_after: iso(row.purge_after),
    } : null;
  }

  override async listGuestRetentionCandidates(now: string): Promise<GuestRetentionCandidate[]> {
    const result = await this.pool.query<{
      owner_id: string;
      project_count: string;
      action: "soft_delete" | "delete";
    }>(
      `WITH owned AS (
         SELECT u.owner_id, u.last_seen_at, u.deleted_at, u.purge_after,
                COUNT(p.project_id)::text AS project_count,
                EXISTS(
                  SELECT 1 FROM analysis_jobs j
                  JOIN projects ap ON ap.project_id = j.project_id
                  WHERE ap.owner_id = u.owner_id
                    AND j.status IN ('queued', 'running')
                ) AS has_active_job
         FROM app_users u
         LEFT JOIN projects p ON p.owner_id = u.owner_id
         WHERE u.owner_id LIKE 'guest:%'
         GROUP BY u.owner_id, u.last_seen_at, u.deleted_at, u.purge_after
       )
       SELECT owner_id, project_count,
              CASE
                WHEN deleted_at IS NOT NULL AND purge_after <= $1::timestamptz THEN 'delete'
                WHEN project_count = '0'
                  AND last_seen_at <= $1::timestamptz - interval '7 days' THEN 'delete'
                WHEN project_count <> '0'
                  AND deleted_at IS NULL
                  AND last_seen_at <= $1::timestamptz - interval '30 days' THEN 'soft_delete'
                ELSE NULL
              END AS action
       FROM owned
       WHERE NOT has_active_job
         AND (
           (deleted_at IS NOT NULL AND purge_after <= $1::timestamptz)
           OR (project_count = '0' AND last_seen_at <= $1::timestamptz - interval '7 days')
           OR (project_count <> '0' AND deleted_at IS NULL AND last_seen_at <= $1::timestamptz - interval '30 days')
         )`,
      [now],
    );
    return result.rows.flatMap((row) => row.action
      ? [{ owner_id: row.owner_id, action: row.action, project_count: Number(row.project_count) }]
      : []);
  }

  override async softDeleteGuestOwner(ownerId: string, deletedAt: string, purgeAfter: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app_users AS u
       SET deleted_at = $2::timestamptz, purge_after = $3::timestamptz, updated_at = now()
       WHERE u.owner_id = $1
         AND u.owner_id LIKE 'guest:%'
         AND NOT EXISTS (
           SELECT 1 FROM analysis_jobs j
           JOIN projects p ON p.project_id = j.project_id
           WHERE p.owner_id = u.owner_id AND j.status IN ('queued', 'running')
         )`,
      [ownerId, deletedAt, purgeAfter],
    );
    return Boolean(result.rowCount);
  }

  override async deleteOwner(ownerId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockOwner(client, ownerId);
      const exists = await client.query("SELECT 1 FROM app_users WHERE owner_id = $1 FOR UPDATE", [ownerId]);
      if (!exists.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const active = await client.query(
        `SELECT 1 FROM analysis_jobs AS job
         JOIN projects AS project ON project.project_id = job.project_id
         WHERE project.owner_id = $1 AND job.status IN ('queued', 'running')
         LIMIT 1 FOR UPDATE`,
        [ownerId],
      );
      if (active.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const feedbackRows = await client.query<{ request_id: string; payload: EvolutionFeedbackRequest }>(
        `SELECT request_id, payload FROM evolution_feedback_requests
         WHERE payload->>'owner_id' = $1
            OR payload->>'source_owner_id' = $1
            OR COALESCE(payload->'owner_ids', '[]'::jsonb) ? $1
         FOR UPDATE`,
        [ownerId],
      );
      for (const row of feedbackRows.rows) {
        const next = removeOwnerFromEvolutionFeedbackRequest(jsonObject<EvolutionFeedbackRequest>(row.payload), ownerId);
        if (!next) {
          await client.query("DELETE FROM evolution_feedback_requests WHERE request_id = $1", [row.request_id]);
        } else {
          await client.query(
            "UPDATE evolution_feedback_requests SET payload = $2::jsonb, updated_at = now() WHERE request_id = $1",
            [row.request_id, JSON.stringify(next)],
          );
        }
      }
      const deleted = await client.query("DELETE FROM app_users WHERE owner_id = $1", [ownerId]);
      await client.query("COMMIT");
      return Boolean(deleted.rowCount);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async mergeOwners(input: {
    sourceOwnerId: string;
    targetOwnerId: string;
    memoryCount?: number;
    sessionCount?: number;
  }): Promise<OwnerMergeSummary> {
    if (input.sourceOwnerId === input.targetOwnerId) {
      throw new Error("owner_merge_same_owner");
    }
    const client = await this.pool.connect();
    const lockIds = [input.sourceOwnerId, input.targetOwnerId].sort();
    try {
      await client.query("BEGIN");
      for (const ownerId of lockIds) await this.lockOwner(client, ownerId);
      const owners = await client.query<{ owner_id: string }>(
        "SELECT owner_id FROM app_users WHERE owner_id = ANY($1::text[]) FOR UPDATE",
        [lockIds],
      );
      if (owners.rowCount !== 2) throw new Error("owner_not_found");

      const projectCounts = await client.query<{ projects: string; messages: string }>(
        `SELECT COUNT(DISTINCT p.project_id)::text AS projects,
                COUNT(m.message_id)::text AS messages
         FROM projects p
         LEFT JOIN project_messages m ON m.project_id = p.project_id
         WHERE p.owner_id = $1`,
        [input.sourceOwnerId],
      );
      const traceCount = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM traces WHERE owner_id = $1",
        [input.sourceOwnerId],
      );
      const feedbackCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM evolution_feedback_requests
          WHERE payload->>'owner_id' = $1
             OR payload->>'source_owner_id' = $1
             OR COALESCE(payload->'owner_ids', '[]'::jsonb) ? $1`,
        [input.sourceOwnerId],
      );

      const sourceProfile = await client.query<{ payload: LearnerProfile }>(
        "SELECT payload FROM learner_profiles WHERE owner_id = $1",
        [input.sourceOwnerId],
      );
      const targetProfile = await client.query<{ payload: LearnerProfile }>(
        "SELECT payload FROM learner_profiles WHERE owner_id = $1",
        [input.targetOwnerId],
      );
      const mergedProfile = mergeProfiles(
        sourceProfile.rows[0] ? normalizeProfile(jsonObject<unknown>(sourceProfile.rows[0].payload)) : emptyProfile(),
        targetProfile.rows[0] ? normalizeProfile(jsonObject<unknown>(targetProfile.rows[0].payload)) : emptyProfile(),
      );
      await client.query(
        `INSERT INTO learner_profiles(owner_id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT(owner_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [input.targetOwnerId, JSON.stringify(mergedProfile)],
      );

      const sourceSettings = await client.query<{ payload: ProviderSettings }>(
        "SELECT payload FROM provider_settings WHERE owner_id = $1",
        [input.sourceOwnerId],
      );
      const targetSettings = await client.query<{ payload: ProviderSettings }>(
        "SELECT payload FROM provider_settings WHERE owner_id = $1",
        [input.targetOwnerId],
      );
      const sourceSettingsValue = sourceSettings.rows[0]
        ? normalizeSettings(sourceSettings.rows[0].payload)
        : emptySettings();
      const targetSettingsValue = targetSettings.rows[0]
        ? normalizeSettings(targetSettings.rows[0].payload)
        : emptySettings();
      const mergedSettings = mergeSettings(sourceSettingsValue, targetSettingsValue);
      await client.query(
        `INSERT INTO provider_settings(owner_id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT(owner_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [input.targetOwnerId, JSON.stringify(mergedSettings)],
      );

      // node-postgres sends parameterized statements as prepared statements;
      // PostgreSQL rejects multiple commands in one such statement. Keep each
      // owner transfer in the same transaction, but execute them separately.
      await client.query(
        `UPDATE projects
         SET owner_id = $2,
             payload = jsonb_set(payload, '{owner_id}', to_jsonb($2::text), true)
         WHERE owner_id = $1`,
        [input.sourceOwnerId, input.targetOwnerId],
      );
      await client.query(
        `UPDATE traces
         SET owner_id = $2,
             payload = jsonb_set(payload, '{owner_id}', to_jsonb($2::text), true)
         WHERE owner_id = $1`,
        [input.sourceOwnerId, input.targetOwnerId],
      );
      await client.query(
        "UPDATE owner_quota_events SET owner_id = $2 WHERE owner_id = $1",
        [input.sourceOwnerId, input.targetOwnerId],
      );
      const feedbackRows = await client.query<{ request_id: string; payload: EvolutionFeedbackRequest }>(
        `SELECT request_id, payload FROM evolution_feedback_requests
         WHERE payload->>'owner_id' = $1
            OR payload->>'source_owner_id' = $1
            OR COALESCE(payload->'owner_ids', '[]'::jsonb) ? $1
         FOR UPDATE`,
        [input.sourceOwnerId],
      );
      for (const row of feedbackRows.rows) {
        const payload = jsonObject<EvolutionFeedbackRequest>(row.payload);
        if (payload.owner_id === input.sourceOwnerId) payload.owner_id = input.targetOwnerId;
        if (payload.source_owner_id === input.sourceOwnerId) payload.source_owner_id = input.targetOwnerId;
        const ownerIds = Array.isArray(payload.owner_ids)
          ? payload.owner_ids.filter((value): value is string => typeof value === "string")
          : payload.owner_id ? [payload.owner_id] : [];
        if (ownerIds.includes(input.sourceOwnerId)) {
          payload.owner_ids = [...new Set(ownerIds.map((value) => value === input.sourceOwnerId ? input.targetOwnerId : value))].slice(0, 100);
        }
        await client.query(
          "UPDATE evolution_feedback_requests SET payload = $2::jsonb, updated_at = now() WHERE request_id = $1",
          [row.request_id, JSON.stringify(payload)],
        );
      }

      // Explicit target keys win per connection. Source-only connections move
      // without deleting unrelated target credentials.
      const sourceKeys = await client.query<{ connection_id: string }>(
        "SELECT connection_id FROM provider_keys WHERE owner_id = $1",
        [input.sourceOwnerId],
      );
      const targetKeys = await client.query<{ connection_id: string }>(
        "SELECT connection_id FROM provider_keys WHERE owner_id = $1",
        [input.targetOwnerId],
      );
      const targetConnectionIds = new Set(targetKeys.rows.map((row) => row.connection_id));
      for (const row of sourceKeys.rows) {
        if (targetConnectionIds.has(row.connection_id)) {
          await client.query(
            "DELETE FROM provider_keys WHERE owner_id = $1 AND connection_id = $2",
            [input.sourceOwnerId, row.connection_id],
          );
        } else {
          await client.query(
            "UPDATE provider_keys SET owner_id = $2 WHERE owner_id = $1 AND connection_id = $3",
            [input.sourceOwnerId, input.targetOwnerId, row.connection_id],
          );
        }
      }

      // Session rows are rebuilt by PiSessionStore using the new owner-derived IDs.
      await client.query("DELETE FROM pi_sessions WHERE owner_id = $1", [input.sourceOwnerId]);
      await client.query("DELETE FROM app_users WHERE owner_id = $1", [input.sourceOwnerId]);

      const summary: OwnerMergeSummary = {
        source_owner_id: input.sourceOwnerId,
        target_owner_id: input.targetOwnerId,
        projects: Number(projectCounts.rows[0]?.projects ?? 0),
        messages: Number(projectCounts.rows[0]?.messages ?? 0),
        memories: input.memoryCount ?? 0,
        sessions: input.sessionCount ?? 0,
        traces: Number(traceCount.rows[0]?.count ?? 0),
        feedback_requests: Number(feedbackCount.rows[0]?.count ?? 0),
        merged_at: nowIso(),
      };
      await client.query(
        `INSERT INTO owner_merge_receipts(receipt_id, target_owner_id, payload, created_at)
         VALUES ($1, $2, $3::jsonb, now())`,
        [randomUUID().replaceAll("-", ""), input.targetOwnerId, JSON.stringify(summary)],
      );
      await client.query("COMMIT");
      return summary;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async consumeOwnerMergeReceipt(ownerId: string): Promise<OwnerMergeSummary | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ receipt_id: string; payload: OwnerMergeSummary }>(
        `SELECT receipt_id, payload FROM owner_merge_receipts
         WHERE target_owner_id = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [ownerId],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("UPDATE owner_merge_receipts SET consumed_at = now() WHERE receipt_id = $1", [result.rows[0].receipt_id]);
      await client.query("COMMIT");
      return jsonObject<OwnerMergeSummary>(result.rows[0].payload);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async saveTrace(eventId: string, payload: unknown, fence?: AnalysisLeaseFence): Promise<void> {
    const record = jsonObject<Record<string, unknown>>(payload);
    const projectId = typeof record.project_id === "string" ? record.project_id : null;
    const write = async (client: Db): Promise<void> => {
      let ownerId = typeof record.owner_id === "string" ? record.owner_id : null;
      if (!ownerId && projectId) {
        const owner = await client.query<{ owner_id: string }>(
          "SELECT owner_id FROM projects WHERE project_id = $1",
          [projectId],
        );
        ownerId = owner.rows[0]?.owner_id ?? null;
      }
      ownerId ??= "system:runtime";
      await client.query(
        `INSERT INTO traces(event_id, trace_id, owner_id, project_id, worker_run_id, event_type, created_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7::jsonb)
         ON CONFLICT(event_id) DO UPDATE SET payload = EXCLUDED.payload`,
        [
          eventId,
          String(record.trace_id ?? eventId),
          ownerId,
          projectId,
          typeof record.worker_run_id === "string" ? record.worker_run_id : null,
          String(record.event_type ?? record.worker ?? "runtime"),
          JSON.stringify(record),
        ],
      );
    };
    if (fence) {
      await this.withAnalysisLeaseTransaction(fence, write);
      return;
    }
    await write(this.pool);
  }

  override async listTraces(projectId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM traces WHERE project_id = $1 ORDER BY created_at",
      [projectId],
    );
    return result.rows.map((row) => jsonObject<Record<string, unknown>>(row.payload));
  }

  override async listRunTraces(projectId: string, runId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM traces WHERE project_id = $1 AND event_id = $2",
      [projectId, runId],
    );
    return result.rows.map((row) => jsonObject<Record<string, unknown>>(row.payload));
  }

  override async saveEvolutionFeedbackRequest(request: EvolutionFeedbackRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO evolution_feedback_requests(
         request_id, dedupe_key, status, created_at, updated_at, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT(request_id) DO UPDATE SET
         dedupe_key = EXCLUDED.dedupe_key,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         payload = EXCLUDED.payload`,
      [
        request.request_id,
        request.dedupe_key,
        request.status,
        request.created_at,
        request.updated_at,
        JSON.stringify(request),
      ],
    );
  }

  override async upsertEvolutionFeedbackRequest(
    request: EvolutionFeedbackRequest,
  ): Promise<EvolutionFeedbackRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 0)", [request.dedupe_key]);
      const existing = await client.query<{ payload: EvolutionFeedbackRequest }>(
        `SELECT payload FROM evolution_feedback_requests
         WHERE dedupe_key = $1 AND status = 'pending'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE`,
        [request.dedupe_key],
      );
      const next = existing.rows[0]
        ? mergeEvolutionFeedbackRequests(
            jsonObject<EvolutionFeedbackRequest>(existing.rows[0].payload),
            request,
          )
        : request;
      await client.query(
        `INSERT INTO evolution_feedback_requests(
           request_id, dedupe_key, status, created_at, updated_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT(request_id) DO UPDATE SET
           dedupe_key = EXCLUDED.dedupe_key,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           payload = EXCLUDED.payload`,
        [
          next.request_id,
          next.dedupe_key,
          next.status,
          next.created_at,
          next.updated_at,
          JSON.stringify(next),
        ],
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  override async loadEvolutionFeedbackRequest(requestId: string): Promise<EvolutionFeedbackRequest | null> {
    const result = await this.pool.query<{ payload: EvolutionFeedbackRequest }>(
      "SELECT payload FROM evolution_feedback_requests WHERE request_id = $1",
      [requestId],
    );
    return result.rows[0]
      ? jsonObject<EvolutionFeedbackRequest>(result.rows[0].payload)
      : null;
  }

  override async listEvolutionFeedbackRequests(
    status?: EvolutionFeedbackRequestStatus,
  ): Promise<EvolutionFeedbackRequest[]> {
    const result = await this.pool.query<{ payload: EvolutionFeedbackRequest }>(
      `SELECT payload FROM evolution_feedback_requests
       ${status ? "WHERE status = $1" : ""}
       ORDER BY created_at`,
      status ? [status] : [],
    );
    return result.rows.map((row) => jsonObject<EvolutionFeedbackRequest>(row.payload));
  }

  override async updateEvolutionFeedbackRequest(
    requestId: string,
    mutate: (request: EvolutionFeedbackRequest) => void,
  ): Promise<EvolutionFeedbackRequest | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ payload: EvolutionFeedbackRequest }>(
        "SELECT payload FROM evolution_feedback_requests WHERE request_id = $1 FOR UPDATE",
        [requestId],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const request = jsonObject<EvolutionFeedbackRequest>(result.rows[0].payload);
      mutate(request);
      request.updated_at = nowIso();
      await client.query(
        `UPDATE evolution_feedback_requests
         SET dedupe_key = $2, status = $3, updated_at = $4, payload = $5::jsonb
         WHERE request_id = $1`,
        [requestId, request.dedupe_key, request.status, request.updated_at, JSON.stringify(request)],
      );
      await client.query("COMMIT");
      return request;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadProjectWithDb(db: Db, projectId: string, ownerId?: string): Promise<Project | null> {
    const result = await db.query<{ owner_id: string; payload: Project }>(
      `SELECT owner_id, payload FROM projects WHERE project_id = $1${ownerId ? " AND owner_id = $2" : ""}`,
      ownerId ? [projectId, ownerId] : [projectId],
    );
    if (!result.rows[0]) return null;
    const project = jsonObject<Project>(result.rows[0].payload);
    project.owner_id = result.rows[0].owner_id;
    const messages = await db.query<{ payload: Message }>(
      "SELECT payload FROM project_messages WHERE project_id = $1 ORDER BY sequence",
      [projectId],
    );
    return {
      ...project,
      messages: messages.rowCount
        ? messages.rows.map((row) => jsonObject<Message>(row.payload))
        : Array.isArray(project.messages) ? project.messages : [],
    };
  }

  private async saveProjectWithClient(
    client: PoolClient,
    project: Project,
    enforceStorageQuota = true,
  ): Promise<void> {
    await client.query(
      `INSERT INTO projects(project_id, owner_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT(project_id) DO UPDATE SET
         owner_id = EXCLUDED.owner_id,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [project.project_id, project.owner_id, JSON.stringify(projectPayload(project)), project.created_at, project.updated_at],
    );
    if (project.messages.length) {
      await client.query(
        `INSERT INTO project_messages(message_id, project_id, role, created_at, payload)
         SELECT
           item->>'message_id', $1, item->>'role', (item->>'created_at')::timestamptz, item
         FROM jsonb_array_elements($2::jsonb) AS item
         ON CONFLICT(message_id) DO UPDATE SET payload = EXCLUDED.payload`,
        [project.project_id, JSON.stringify(project.messages)],
      );
    }
    const publicKey = project.analysis.canonical_snapshot_key;
    const current = await client.query<{ public_snapshot_key: string }>(
      "SELECT public_snapshot_key FROM project_public_snapshot_bindings WHERE project_id = $1",
      [project.project_id],
    );
    if (!publicKey) {
      if (current.rowCount) await client.query("DELETE FROM project_public_snapshot_bindings WHERE project_id = $1", [project.project_id]);
      return;
    }
    if (current.rows[0]?.public_snapshot_key !== publicKey) {
      // Shared snapshots have no per-owner byte quota; global capacity guards new work.
      void enforceStorageQuota;
      await client.query(
        `INSERT INTO project_public_snapshot_bindings(project_id, public_snapshot_key, bound_at)
         VALUES ($1, $2, now())
         ON CONFLICT(project_id) DO UPDATE SET public_snapshot_key = EXCLUDED.public_snapshot_key, bound_at = now()`,
        [project.project_id, publicKey],
      );
      await client.query(
        "UPDATE canonical_public_repository_snapshots SET reuse_count = reuse_count + 1, last_used_at = now() WHERE public_snapshot_key = $1",
        [publicKey],
      );
    }
  }

  private async saveJobWithDb(db: Db, job: AnalysisJob): Promise<void> {
    await db.query(
      `INSERT INTO analysis_jobs(
         job_id, project_id, idempotency_key, status, attempt, max_attempts,
         lease_owner, lease_expires_at, heartbeat_at, created_at, updated_at,
         available_at, completed_at, error, error_code,
         repository_update_id, execution_role, language_overlay_key, config_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, COALESCE($19,(SELECT ((value->'versions'->-1)->>'version')::int FROM admin_documents WHERE key='platform'),0))
       ON CONFLICT(job_id) DO UPDATE SET
         status = EXCLUDED.status,
         attempt = EXCLUDED.attempt,
         max_attempts = EXCLUDED.max_attempts,
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at,
         heartbeat_at = EXCLUDED.heartbeat_at,
         updated_at = EXCLUDED.updated_at,
         available_at = EXCLUDED.available_at,
         completed_at = EXCLUDED.completed_at,
         error = EXCLUDED.error,
         error_code = EXCLUDED.error_code,
         repository_update_id = EXCLUDED.repository_update_id,
         execution_role = EXCLUDED.execution_role,
         language_overlay_key = EXCLUDED.language_overlay_key`,
      [
        job.job_id,
        job.project_id,
        job.idempotency_key,
        job.status,
        job.attempt,
        job.max_attempts,
        job.lease_owner,
        job.lease_expires_at,
        job.heartbeat_at,
        job.created_at,
        job.updated_at,
        job.available_at,
        job.completed_at,
        job.error,
        job.error_code ?? null,
        job.repository_update_id ?? null,
        job.execution_role ?? "standalone",
        job.language_overlay_key ?? null,
        job.config_version ?? null,
      ],
    );
  }

  private async saveRevisionRedirectsWithDb(db: Db, redirects: RevisionRedirect[]): Promise<void> {
    for (const redirect of redirects) {
      await db.query(
        `INSERT INTO repository_revision_redirects(
           repository_identity, from_public_snapshot_key, to_public_snapshot_key,
           old_path, old_stable_id, redirect_kind, candidates, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT(from_public_snapshot_key, to_public_snapshot_key, old_path, old_stable_id)
         DO UPDATE SET
           repository_identity = EXCLUDED.repository_identity,
           redirect_kind = EXCLUDED.redirect_kind,
           candidates = EXCLUDED.candidates,
           created_at = EXCLUDED.created_at`,
        [
          redirect.repository_identity.toLowerCase(),
          redirect.from_public_snapshot_key,
          redirect.to_public_snapshot_key,
          redirect.old_path,
          redirect.old_stable_id ?? "",
          redirect.kind,
          JSON.stringify(redirect.candidates),
          redirect.created_at,
        ],
      );
    }
  }

  private async lockOwner(client: PoolClient, ownerId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
  }

  private async lockProject(client: PoolClient, projectId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`project:${projectId}`]);
  }

  private async lockProjects(client: PoolClient, projectIds: Iterable<string>): Promise<void> {
    const ids = [...new Set([...projectIds].filter((value) => value.trim()))].sort();
    for (const projectId of ids) await this.lockProject(client, projectId);
  }

  private async lockRepositoryUpdateScope(
    client: PoolClient,
    updateId: string,
    extraProjectIds: Iterable<string> = [],
    includeBoundProjects = false,
  ): Promise<boolean> {
    const update = await client.query<{
      repository_identity: string;
      analyzer_bundle_version: string;
      analysis_config_digest: string;
      leader_project_id: string;
    }>(
      `SELECT repository_identity, analyzer_bundle_version, analysis_config_digest, leader_project_id
       FROM repository_analysis_updates WHERE update_id = $1`,
      [updateId],
    );
    const row = update.rows[0];
    if (!row) return false;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`repository-update:${row.repository_identity}:${row.analyzer_bundle_version}:${row.analysis_config_digest}`],
    );
    const joined = await client.query<{ project_id: string }>(
      `SELECT project_id FROM repository_analysis_update_projects
       WHERE update_id = $1 ORDER BY project_id`,
      [updateId],
    );
    const bound = includeBoundProjects
      ? await client.query<{ project_id: string }>(
        `SELECT binding.project_id
         FROM project_public_snapshot_bindings AS binding
         JOIN canonical_public_repository_snapshots AS snapshot
           ON snapshot.public_snapshot_key = binding.public_snapshot_key
         WHERE snapshot.repository_identity = $1
           AND snapshot.analyzer_bundle_version = $2
           AND snapshot.analysis_config_digest = $3
         ORDER BY binding.project_id`,
        [row.repository_identity, row.analyzer_bundle_version, row.analysis_config_digest],
      )
      : { rows: [] as Array<{ project_id: string }> };
    const projectIds = [...new Set([
      row.leader_project_id,
      ...joined.rows.map((item) => item.project_id),
      ...bound.rows.map((item) => item.project_id),
      ...extraProjectIds,
    ].filter(Boolean))].sort();
    await this.lockProjects(client, projectIds);
    if (projectIds.length) {
      await client.query(
        "SELECT project_id FROM projects WHERE project_id = ANY($1::text[]) ORDER BY project_id FOR UPDATE",
        [projectIds],
      );
    }
    return true;
  }

  private async lockSnapshotLanguage(client: PoolClient, overlayKey: string): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`snapshot-language:${overlayKey}`],
    );
  }

  private async lockSnapshotLanguageProjects(
    client: PoolClient,
    overlayKey: string,
    extraProjectIds: Iterable<string> = [],
  ): Promise<void> {
    const jobs = await client.query<{ project_id: string }>(
      `SELECT project_id FROM analysis_jobs
       WHERE language_overlay_key = $1 AND status IN ('queued', 'running')
       ORDER BY project_id`,
      [overlayKey],
    );
    await this.lockProjects(client, [
      ...jobs.rows.map((row) => row.project_id),
      ...extraProjectIds,
    ]);
  }

  private async resolveAnalysisProjectId(client: PoolClient, fence: AnalysisLeaseFence): Promise<string> {
    if (fence.projectId) return fence.projectId;
    const result = await client.query<{ project_id: string }>(
      "SELECT project_id FROM analysis_jobs WHERE job_id = $1",
      [fence.jobId],
    );
    const projectId = result.rows[0]?.project_id;
    if (!projectId) throw new AnalysisLeaseLostError();
    return projectId;
  }

  private async lockAnalysisProject(client: PoolClient, fence: AnalysisLeaseFence): Promise<string> {
    const projectId = await this.resolveAnalysisProjectId(client, fence);
    await this.lockProject(client, projectId);
    return projectId;
  }

  private async assertAnalysisLeaseWithDb(
    client: PoolClient,
    fence: AnalysisLeaseFence,
    projectId = fence.projectId,
  ): Promise<void> {
    const projectClause = projectId ? " AND project_id = $4" : "";
    const result = await client.query(
      `SELECT job_id
       FROM analysis_jobs
       WHERE job_id = $1
         AND status = 'running'
         AND lease_owner = $2
         AND attempt = $3
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > clock_timestamp()
         ${projectClause}
       FOR UPDATE`,
      projectId
        ? [fence.jobId, fence.workerId, fence.attempt, projectId]
        : [fence.jobId, fence.workerId, fence.attempt],
    );
    if (!result.rowCount) throw new AnalysisLeaseLostError();
  }

  private async withAnalysisLeaseTransaction<T>(
    fence: AnalysisLeaseFence,
    task: (client: PoolClient) => Promise<T>,
    beforeProjectLock?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await beforeProjectLock?.(client);
      const projectId = await this.lockAnalysisProject(client, fence);
      await this.assertAnalysisLeaseWithDb(client, fence, projectId);
      const result = await task(client);
      await this.assertAnalysisLeaseWithDb(client, fence, projectId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async checkDbCreationQuotas(client: PoolClient, ownerId: string, includeProject: boolean): Promise<void> {
    if (includeProject) {
      const projects = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM projects WHERE owner_id = $1",
        [ownerId],
      );
      if (Number(projects.rows[0]?.count ?? 0) >= this.limits.maxProjects) {
        throw new QuotaExceededError("projects", this.limits.maxProjects);
      }
    }
    const events = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM owner_quota_events WHERE owner_id = $1 AND created_at >= now() - interval '1 hour'",
      [ownerId],
    );
    if (Number(events.rows[0]?.count ?? 0) >= this.limits.maxCreationsPerHour) {
      throw new QuotaExceededError("creation_rate", this.limits.maxCreationsPerHour);
    }
    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM analysis_jobs AS job
       JOIN projects AS project ON project.project_id = job.project_id
       WHERE project.owner_id = $1 AND job.status IN ('queued', 'running')`,
      [ownerId],
    );
    if (Number(active.rows[0]?.count ?? 0) >= this.limits.maxActiveAnalysisJobs) {
      throw new QuotaExceededError("active_analysis_jobs", this.limits.maxActiveAnalysisJobs);
    }
  }

  private async recordQuotaEvent(client: PoolClient, ownerId: string, projectId: string): Promise<void> {
    await client.query(
      `INSERT INTO owner_quota_events(event_id, owner_id, project_id, event_kind, created_at)
       VALUES ($1, $2, $3, 'analysis_create', now())`,
      [randomUUID(), ownerId, projectId],
    );
  }
}
