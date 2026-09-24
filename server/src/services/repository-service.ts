import { acquireRepositoryReadLease } from '../persistence/repository-read-lease.js';
import { createHash, randomUUID } from "node:crypto";
import {
  createProject,
  nowIso,
  recordAnalysisProgress,
  setAnalysisStrategy,
  type Project,
} from "../domain/conversation.js";
import { newAnalysisJob, type AnalysisJob } from "../domain/jobs.js";
import {
  asEvidenceSnapshot,
  type EvidenceSnapshot,
  type SnapshotEntityKind,
  type SnapshotProjectionKind,
} from "../domain/snapshot.js";
import {
  buildSnapshotQueryDirectory,
  querySnapshotQueryDirectory,
} from "../domain/snapshot-query.js";
import {
  DEFAULT_DISPLAY_LANGUAGE,
  projectDisplayLanguage,
  normalizeDisplayLanguage,
} from "../domain/display-language.js";
import type { ProductStore } from "../persistence/store.js";
import type { PublicSnapshotBundle } from "../persistence/store.js";
import {
  snapshotLanguageOverlayKey,
  type RepositoryMigrationAction,
} from "../domain/lifecycle.js";
import type { ConversationOwner } from "./conversation-service.js";
import { serviceError } from "./errors.js";
import {
  fetchPublicGithubHead,
  fetchPublicGithubComparison,
  parseGithubRepository,
  type GithubGatewayTransport,
  type GithubRepositoryHead,
} from "../analysis/github.js";
import {
  ANALYSIS_CONFIG_DIGEST,
  ANALYZER_BUNDLE_VERSION,
} from "../analysis/identity.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { ServerConfig } from "../config.js";
import { applyOwnedSnapshotLanguageOverlay, asSnapshotLanguageOverlayPayload } from "../domain/snapshot-language.js";
import type { BackgroundAdmission, RepositoryIdentityInput } from "../persistence/store.js";
import type { RepositoryHead, RepositoryUpdate, RepositoryViewStatus } from "../domain/lifecycle.js";
import { repositoryIdentityOf, resolveSnapshotView, snapshotExpired } from "./snapshot-view.js";
import { ensureLearningMigration, learningMigrationStatus } from "./learning-migration.js";

const DEFAULT_HEAD_FRESHNESS_MS = 60 * 60 * 1000;

export type GithubHeadResolver = (
  value: string,
  clientId?: string | null,
  clientSecret?: string | null,
  gateway?: GithubGatewayTransport | null,
  signal?: AbortSignal,
) => Promise<GithubRepositoryHead | null>;

export interface RepositoryServiceOptions {
  config?: ServerConfig;
  githubClientId?: string | null;
  githubClientSecret?: string | null;
  githubGateway?: GithubGatewayTransport | null;
  headFreshnessMs?: number;
  analysisConfigDigest?: () => Promise<string>;
  analysisExecution?: () => Promise<{digest:string;configVersion:number}>;
  admitWork?: <T>(job: AnalysisJob, operation: () => Promise<T>) => Promise<T>;
  resolveGithubHead?: GithubHeadResolver;
  taskQueue?: TaskQueue;
}

export interface EvidenceQuery {
  text?: string;
  paths?: string[];
  languages?: string[];
  symbol_ids?: string[];
  component_ids?: string[];
  entity_ids?: string[];
  entity_kinds?: SnapshotEntityKind[];
  scope?: "self" | "subtree" | "ancestors" | "neighbors";
  depth?: number;
  projection?: SnapshotProjectionKind;
  personalized_entity_ids?: string[];
  evidence_budget_tokens?: number;
  relation_kinds?: string[];
  limit?: number;
  cursor?: string | null;
  expand_hops?: number;
}

export interface StartAnalysisResult {
  project: Project;
  job: AnalysisJob;
  created: boolean;
}

export class RepositoryService {
  private readonly headFreshnessMs: number;
  private readonly resolveGithubHead: GithubHeadResolver;
  /** Page-triggered upstream checks in flight, one per repository in this process. */
  private readonly freshnessChecks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ProductStore,
    private readonly options: RepositoryServiceOptions = {},
  ) {
    this.headFreshnessMs = options.headFreshnessMs
      ?? (options.config?.repositoryHeadCheckTtlMinutes ? options.config.repositoryHeadCheckTtlMinutes * 60_000 : DEFAULT_HEAD_FRESHNESS_MS);
    this.resolveGithubHead = options.resolveGithubHead ?? fetchPublicGithubHead;
  }

  private admit<T>(job: AnalysisJob, operation: () => Promise<T>): Promise<T> { return this.options.admitWork ? this.options.admitWork(job, operation) : operation(); }

  async startAnalysis(input: {
    owner: ConversationOwner;
    projectId?: string | null;
    kind?: string | null;
    value?: string | null;
    title?: string;
    displayLanguage?: string | null;
  }): Promise<StartAnalysisResult> {
    const releaseRepository=await acquireRepositoryReadLease(this.store);
    try {
    let project: Project;
    let created: boolean;
    if (input.projectId) {
      if (input.kind || input.value || input.title?.trim()) {
        throw serviceError("invalid_request", "重分析只接受 project_id", 400);
      }
      project = await this.requireProject(input.owner.owner_id, input.projectId);
      delete project.analysis.removed_by_admin;
      const activeJob = await this.store.latestJob(input.projectId);
      if (activeJob && (activeJob.status === "queued" || activeJob.status === "running")) {
        await this.enqueueIfRunnable(activeJob);
        return { project, job: activeJob, created: false };
      }
      created = false;
      const language = input.displayLanguage
        ? normalizeDisplayLanguage(input.displayLanguage)
        : projectDisplayLanguage(project);
      project = { ...structuredClone(project), display_language: language };
    } else {
      if (input.kind !== "github" || !input.value || !isGithubUrl(input.value)) {
        throw serviceError("invalid_request", "首次分析必须提供公开 GitHub 仓库", 400);
      }
      project = createProject(
        input.owner.owner_id,
        input.value,
        input.title?.slice(0, 200) ?? "",
        null,
        normalizeDisplayLanguage(input.displayLanguage ?? DEFAULT_DISPLAY_LANGUAGE),
      );
      created = true;
    }

    const parsed = parseGithubRepository(project.source.value);
    const repository = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const execution = await this.options.analysisExecution?.();
    const analysisConfigDigest = execution?.digest ?? await this.options.analysisConfigDigest?.() ?? ANALYSIS_CONFIG_DIGEST;
    const identity = {
      repository,
      analyzerBundleVersion: ANALYZER_BUNDLE_VERSION,
      analysisConfigDigest,
    };
    const startedAt = nowIso();
    const hasReadableSnapshot = !created && project.analysis.stage === "done"
      && Boolean(project.analysis.canonical_snapshot_key);
    if (!hasReadableSnapshot) {
      project.analysis.stage = "fetching";
      project.analysis.error = null;
      project.analysis.started_at = startedAt;
      project.analysis.completed_at = null;
      project.analysis.progress_events = [];
      project.analysis.strategy = null;
      recordAnalysisProgress(project.analysis, "checking_existing", "running", startedAt);
    }
    const sourceDigest = createHash("sha256").update(project.source.value).digest("hex").slice(0, 24);
    const job = newAnalysisJob(project.project_id, created
      ? `analysis:${project.project_id}:${sourceDigest}`
      : `analysis:${project.project_id}:${Date.now()}`);
    job.config_version = execution?.configVersion;
    const head = typeof this.store.loadCurrentRepositoryHead === 'function'
      ? await this.store.loadCurrentRepositoryHead(repository)
      : await this.store.loadRepositoryHead(identity);
    if (created && head?.current_public_snapshot_key) {
      const snapshot = await this.store.loadPublicSnapshotView(head.current_public_snapshot_key);
      if (snapshot) {
        recordAnalysisProgress(project.analysis, "checking_existing", "completed");
        setAnalysisStrategy(project.analysis, "reuse");
        recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
        return this.bindExistingSnapshot({ project, job, created, publicKey: head.current_public_snapshot_key, snapshot });
      }
    }
    const fresh = head?.last_checked_at
      ? Date.now() - Date.parse(head.last_checked_at) <= this.headFreshnessMs
      : false;
    // An existing version with another analyzer/config still needs the shared update.
    const sameIdentity = head?.analyzer_bundle_version === ANALYZER_BUNDLE_VERSION
      && head.analysis_config_digest === analysisConfigDigest;
    if (fresh && sameIdentity && head?.current_public_snapshot_key && head.relation === 'same') {
      const snapshot = await this.store.loadPublicSnapshotView(head.current_public_snapshot_key);
      if (snapshot) {
        if (!hasReadableSnapshot) {
          recordAnalysisProgress(project.analysis, "checking_existing", "completed");
          setAnalysisStrategy(project.analysis, "reuse");
          recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
        }
        return this.bindExistingSnapshot({ project, job, created, publicKey: head.current_public_snapshot_key, snapshot });
      }
    }

    if (!hasReadableSnapshot) {
      recordAnalysisProgress(project.analysis, "checking_existing", "completed");
      recordAnalysisProgress(project.analysis, "confirming_upstream", "running");
    }
    let upstream: GithubRepositoryHead | null = null;
    if (fresh && head?.upstream_commit_sha && head.upstream_commit_sha !== head.current_commit_sha) {
      upstream = { ...parsed, repository, commitSha: head.upstream_commit_sha };
    } else {
      try {
        upstream = await this.resolveGithubHead(
          project.source.value,
          this.options.githubClientId,
          this.options.githubClientSecret,
          this.options.githubGateway,
        );
      } catch {
        upstream = null;
      }
    }
    if (!hasReadableSnapshot) recordAnalysisProgress(project.analysis, "confirming_upstream", "completed");
    if (upstream) {
      if (!hasReadableSnapshot) recordAnalysisProgress(project.analysis, "comparing_versions", "running");
      if (sameIdentity && head?.current_commit_sha === upstream.commitSha && head.current_public_snapshot_key) {
        const snapshot = await this.store.loadPublicSnapshotView(head.current_public_snapshot_key);
        if (snapshot) {
          const checkedAt = nowIso();
          await this.store.saveRepositoryHead({ ...head, last_checked_at: checkedAt, updated_at: checkedAt });
          await this.store.saveRepositoryFreshness({ repository, baseSnapshotKey: head.current_public_snapshot_key,
            upstreamCommitSha: upstream.commitSha, behindCommits: 0, relation: 'same', checkedAt,
            nextCheckAt: new Date(Date.parse(checkedAt) + this.headFreshnessMs).toISOString(), errorCode: null });
          if (!hasReadableSnapshot) {
            recordAnalysisProgress(project.analysis, "comparing_versions", "completed");
            setAnalysisStrategy(project.analysis, "reuse");
            recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
          }
          return this.bindExistingSnapshot({ project, job, created, publicKey: head.current_public_snapshot_key, snapshot });
        }
      }
      if (head?.current_public_snapshot_key && upstream.commitSha !== head.current_commit_sha) {
        const checkedAt = nowIso();
        try {
          const comparison = await fetchPublicGithubComparison(project.source.value,
            head.current_commit_sha ?? '', upstream.commitSha, this.options.githubClientId,
            this.options.githubClientSecret, this.options.githubGateway);
          await this.store.saveRepositoryFreshness({ repository, baseSnapshotKey: head.current_public_snapshot_key,
            upstreamCommitSha: upstream.commitSha, behindCommits: comparison.behindCommits,
            relation: comparison.relation, checkedAt,
            nextCheckAt: new Date(Date.parse(checkedAt) + this.headFreshnessMs).toISOString(), errorCode: null });
        } catch {
          // A comparison failure does not prevent a user-requested exact-commit update.
        }
      }
    }

    if (!upstream && hasReadableSnapshot) {
      throw serviceError('github_check_failed', '暂时无法检查上游代码，当前仓库内容仍可继续使用。', 503);
    }

    project.updated_at = startedAt;
    const queued = await this.admit(job, () => this.store.createOrJoinRepositoryUpdate({
      project,
      job,
      identity,
      targetCommitSha: upstream?.commitSha ?? null,
      newProject: created,
    }));
    if (!queued.leader && !hasReadableSnapshot) {
      const members = await this.store.listRepositoryUpdateProjects(queued.update.update_id);
      const leader = members.find((member) => member.project_id === queued.update.leader_project_id);
      if (leader) {
        // A waiter shares only the live decision stream. Its snapshot binding,
        // counts and completion metadata remain its own until publication.
        project.analysis.stage = leader.analysis.stage;
        project.analysis.progress_events = structuredClone(leader.analysis.progress_events ?? []);
        project.analysis.strategy = leader.analysis.strategy ?? null;
        project.analysis.error = null;
        project.updated_at = leader.updated_at;
        await this.store.saveProject(project);
      }
    }
    await this.enqueueIfRunnable(queued.job);
    return { project, job: queued.job, created };
    } finally { await releaseRepository?.(); }
  }

  private async bindExistingSnapshot(input: {
    project: Project;
    job: AnalysisJob;
    created: boolean;
    publicKey: string;
    snapshot: Pick<PublicSnapshotBundle, 'metadata' | 'view'>;
  }): Promise<StartAnalysisResult> {
    const metadataIdentity = input.snapshot.metadata.identity as Record<string, unknown> | undefined;
    const completedAt = nowIso();
    const view = input.snapshot.view as Record<string, unknown>;
    const summary = view.summary as Record<string, unknown> | undefined;
    const languages = Array.isArray(view.languages)
      ? view.languages as Array<{ language?: unknown }>
      : [];
    const language = normalizeDisplayLanguage(input.project.display_language);
    const usesLanguageOverlay = Boolean(input.snapshot.metadata.language_overlay_version);
    const existingOverlay = usesLanguageOverlay
      ? await this.store.loadSnapshotLanguageOverlay(input.publicKey, language)
      : null;
    const overlayReady = !usesLanguageOverlay
      || existingOverlay?.status === "ready"
      || existingOverlay?.status === "degraded";
    setAnalysisStrategy(input.project.analysis, "reuse");
    recordAnalysisProgress(
      input.project.analysis,
      overlayReady ? "completed" : "interpreting",
      overlayReady ? "completed" : "running",
      completedAt,
    );
    input.project.analysis.stage = overlayReady ? "done" : "interpreting";
    input.project.analysis.snapshot_id = String(input.snapshot.metadata.analysis_snapshot_id ?? view.snapshot_id ?? "");
    input.project.analysis.file_count = Number(summary?.file_count ?? 0);
    input.project.analysis.symbol_count = Number(summary?.symbol_count ?? 0);
    input.project.analysis.call_count = Number(summary?.call_count ?? 0);
    input.project.analysis.languages = languages
      .map((item) => typeof item.language === "string" ? item.language : "")
      .filter(Boolean);
    input.project.analysis.error = null;
    input.project.analysis.canonical_snapshot_key = input.publicKey;
    input.project.analysis.started_at ??= completedAt;
    input.project.analysis.completed_at = overlayReady ? completedAt : null;
    input.project.source.commit_sha = String(metadataIdentity?.commit_sha ?? "") || null;
    input.project.updated_at = completedAt;
    const completedJob: AnalysisJob = {
      ...input.job,
      status: overlayReady ? "succeeded" : "queued",
      heartbeat_at: overlayReady ? completedAt : null,
      updated_at: completedAt,
      completed_at: overlayReady ? completedAt : null,
      error: null,
      error_code: null,
    };
    if (!overlayReady) {
      const queued = await this.admit(completedJob, () => this.store.createOrJoinSnapshotLanguageOverlay({
        project: input.project,
        job: completedJob,
        publicKey: input.publicKey,
        language,
        newProject: input.created,
      }));
      await this.enqueueIfRunnable(queued.job);
      return { project: input.project, job: queued.job, created: input.created };
    }
    if (input.created) {
      await this.store.createProjectWithJob(input.project, completedJob);
    } else {
      await this.store.enqueueAnalysisJob(input.project.owner_id, input.project.project_id, completedJob);
      await this.store.saveProject(input.project);
    }
    await this.enqueueIfRunnable(completedJob);
    return { project: input.project, job: completedJob, created: input.created };
  }

  async getAnalysisStatus(ownerId: string, projectId: string): Promise<Record<string, unknown>> {
    const project = await this.requireProject(ownerId, projectId);
    const job = await this.store.latestJob(projectId);
    return {
      project_id: projectId,
      ...project.analysis,
      error: project.analysis.stage === "failed" ? (project.analysis.error || "分析未完成，请重试。") : null,
      error_code: job?.error_code ?? null,
      job_id: job?.job_id ?? null,
      scheduling_state: job?.scheduling_state ?? null,
      job_status: job?.scheduling_state === 'running' ? 'running'
        : job?.scheduling_state?.startsWith('waiting') ? 'queued' : job?.status ?? null,
      job_attempt: job?.attempt ?? null,
      job_max_attempts: job?.max_attempts ?? null,
      heartbeat_at: job?.heartbeat_at ?? null,
      retryable: !job || job.status === "failed" || job.status === "cancelled",
    };
  }

  /**
   * Resolves the version a page is reading. The current binding needs no lookup;
   * an older version must belong to the same repository, be retired (not an
   * arbitrary snapshot ID) and still be inside its grace period.
   */
  /** Resolves the version a page is reading; see resolveSnapshotView. */
  async resolveProjectView(ownerId: string, projectId: string, viewSnapshotId?: string | null): Promise<{
    project: Project; historical: boolean;
  }> {
    const project = await this.requireProject(ownerId, projectId);
    const view = await resolveSnapshotView(this.store, project, viewSnapshotId);
    // Reading the current version carries the personal route over once.
    return view.historical ? view : { project: await ensureLearningMigration(this.store, project), historical: false };
  }

  async getProjectView(ownerId: string, projectId: string, viewSnapshotId?: string | null): Promise<Project> {
    return (await this.resolveProjectView(ownerId, projectId, viewSnapshotId)).project;
  }

  async getSnapshotView(ownerId: string, projectId: string, language?: string | null,
    viewSnapshotId?: string | null): Promise<EvidenceSnapshot | null> {
    const { project, historical } = await this.resolveProjectView(ownerId, projectId, viewSnapshotId);
    await this.touchRealUse(project);
    if (!historical) return this.store.loadSnapshot<EvidenceSnapshot>(projectId, language ?? undefined);
    const publicKey = project.analysis.canonical_snapshot_key ?? "";
    const bundle = await this.store.loadPublicSnapshotView(publicKey);
    const snapshot = asEvidenceSnapshot(bundle?.view);
    if (!snapshot || !bundle?.metadata.language_overlay_version) return snapshot;
    // Same rule as the current view: read existing overlays, never queue translation.
    for (const candidate of new Set([normalizeDisplayLanguage(language ?? project.display_language),
      normalizeDisplayLanguage(project.display_language)])) {
      const overlay = await this.store.loadSnapshotLanguageOverlay(publicKey, candidate);
      const payload = asSnapshotLanguageOverlayPayload(overlay?.payload);
      if (!overlay || !payload || (overlay.status !== "ready" && overlay.status !== "degraded")) continue;
      const assembled = applyOwnedSnapshotLanguageOverlay(snapshot, payload);
      assembled.language_overlay_status = overlay.status;
      return assembled;
    }
    return null;
  }

  /**
   * Reads source from the requested version. A version outside its grace period
   * falls back to the recorded path mapping into the current version.
   */
  async readSourceView(ownerId: string, projectId: string, snapshotId: string,
    path: string, start: number, end: number, stableId?: string | null): Promise<{
      snapshot_id: string; path: string; lines: string[]; truncated: boolean; redirect: unknown;
    }> {
    let resolved: { project: Project; historical: boolean } | null = null;
    try {
      resolved = await this.resolveProjectView(ownerId, projectId, snapshotId);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 409 && status !== 410) throw error;
    }
    if (resolved) {
      await this.touchRealUse(resolved.project);
      const result = resolved.historical
        ? await this.store.readPublicSourceLines(resolved.project.analysis.canonical_snapshot_key ?? "", snapshotId, path, start, end)
        : await this.store.readSourceLines(projectId, snapshotId, path, start, end);
      return { snapshot_id: snapshotId, path, ...result, redirect: null };
    }
    const project = await this.requireProject(ownerId, projectId);
    const fromPublicKey = await this.store.findPublicSnapshotKeyBySnapshotId(snapshotId);
    const toPublicKey = project.analysis.canonical_snapshot_key;
    if (!fromPublicKey || !toPublicKey || !project.analysis.snapshot_id) {
      throw serviceError("snapshot_mismatch", "源码证据与当前快照不匹配", 409);
    }
    const redirect = await this.store.resolveRevisionRedirect({ fromPublicKey, toPublicKey, oldPath: path, oldStableId: stableId ?? null });
    if (!redirect) throw serviceError("snapshot_mismatch", "旧引用尚无可确认的新版位置", 409);
    if (redirect.kind === "deleted") {
      throw serviceError("source_deleted", `新版 commit 已删除文件 ${path}，不能编造删除原因`, 410);
    }
    const candidate = redirect.candidates[0];
    if (!candidate) throw serviceError("snapshot_mismatch", "旧引用已变化，但尚无可打开的新位置", 409);
    const result = await this.store.readPublicSourceLines(toPublicKey, project.analysis.snapshot_id, candidate.path, start, end);
    return { snapshot_id: project.analysis.snapshot_id, path: candidate.path, ...result, redirect };
  }

  async getRepositoryStatus(ownerId: string, projectId: string, viewSnapshotId?: string | null): Promise<RepositoryViewStatus> {
    const project = await ensureLearningMigration(this.store, await this.requireProject(ownerId, projectId));
    if (project.source.kind !== "github") throw serviceError("invalid_request", "只有 GitHub 仓库有版本状态", 400);
    const repository = repositoryIdentityOf(project);
    const [head, latest] = await Promise.all([
      this.store.loadCurrentRepositoryHead(repository),
      this.store.loadLatestRepositoryUpdate(repository),
    ]);
    const currentMeta = head?.current_public_snapshot_key
      ? await this.store.loadPublicSnapshotMetadata(head.current_public_snapshot_key) : null;
    const requestedView = viewSnapshotId ?? project.analysis.snapshot_id;
    const viewKey = requestedView === project.analysis.snapshot_id
      ? project.analysis.canonical_snapshot_key
      : requestedView ? await this.store.findPublicSnapshotKeyBySnapshotId(requestedView) : null;
    const viewCandidate = viewKey ? await this.store.loadPublicSnapshotMetadata(viewKey) : null;
    const viewMeta = viewCandidate?.repository_identity === repository ? viewCandidate : null;
    const currentId = currentMeta?.analysis_snapshot_id ?? null;
    const viewId = viewMeta?.analysis_snapshot_id ?? project.analysis.snapshot_id;
    const checkedAt = head?.last_checked_at ?? null;
    const stale = !checkedAt || Date.now() - Date.parse(checkedAt) > this.headFreshnessMs;
    // A stale page starts one free metadata check (never paid work); the next
    // status poll shows its result.
    if (stale && head?.current_public_snapshot_key) this.startFreshnessCheck(head);
    const checking = this.freshnessChecks.has(repository);
    const currentPublishedAt = head?.published_at ?? null;
    const active = latest && (latest.status === "queued" || latest.status === "running") ? latest : null;
    // A failure is only news until a later version is published.
    const failed = latest?.status === "failed"
      && (!currentPublishedAt || latest.updated_at > currentPublishedAt) ? latest : null;
    const shown = active ?? failed;
    const participant = shown ? await this.store.loadRepositoryUpdateForProject(projectId) : null;
    const participating = Boolean(shown && participant?.update_id === shown.update_id);
    const cooldown = active ? null : this.manualCooldown(latest);
    return {
      snapshot_available: Boolean(project.analysis.snapshot_id && !project.analysis.removed_by_admin),
      current: currentMeta ? {
        snapshot_id: currentMeta.analysis_snapshot_id,
        commit_sha: currentMeta.commit_sha,
        published_at: currentPublishedAt,
        generation: head?.generation ?? 0,
      } : null,
      view: viewMeta ? {
        snapshot_id: viewMeta.analysis_snapshot_id,
        commit_sha: viewMeta.commit_sha,
        // An old page must not borrow the newer version's publication time.
        published_at: viewMeta.public_snapshot_key === head?.current_public_snapshot_key
          ? currentPublishedAt : null,
        expires_at: viewMeta.retired_at ? viewMeta.purge_after : null,
      } : null,
      refresh_required: Boolean(currentId && viewId && currentId !== viewId),
      view_expired: Boolean(viewMeta && snapshotExpired(viewMeta)),
      freshness: {
        base_snapshot_id: currentId,
        upstream_commit_sha: head?.upstream_commit_sha ?? null,
        behind_commits: head?.behind_commits ?? null,
        relation: head?.relation ?? "unknown",
        check_status: checking ? "checking" : head?.check_error_code ? "failed" : checkedAt ? "ok" : "idle",
        checked_at: checkedAt,
        stale,
        error_code: head?.check_error_code ?? null,
        next_check_at: head?.next_check_at ?? null,
      },
      update: shown ? {
        update_id: shown.update_id,
        status: shown.status === "failed" ? "failed" : shown.status === "running" ? "running" : "queued",
        target_commit_sha: shown.target_commit_sha,
        trigger: shown.trigger ?? "manual",
        stage: null,
        participation: participating ? (shown.status === "running" ? "running"
          : shown.status === "failed" ? "completed" : "queued") : "none",
        // Participants and costs stay private; the public reason is enough.
        error_code: shown.status === "failed" ? "repository_update_failed" : null,
        retryable: shown.status === "failed" && !cooldown,
      } : null,
      update_eligibility: active
        ? { allowed: true, reason: "join_running", retry_after: null }
        : cooldown ? { allowed: false, reason: "cooldown", retry_after: cooldown }
        : { allowed: Boolean(currentMeta), reason: currentMeta ? null : "snapshot_unavailable", retry_after: null },
      migration: learningMigrationStatus(project),
    };
  }

  private startFreshnessCheck(head: RepositoryHead): void {
    const repository = head.repository_identity.toLowerCase();
    // A failed check is retried only after its recorded next-check time.
    if (this.freshnessChecks.has(repository)
      || (head.check_error_code && head.next_check_at && Date.parse(head.next_check_at) > Date.now())) return;
    const task = this.checkRepositoryFreshness({ repository, analyzerBundleVersion: head.analyzer_bundle_version,
      analysisConfigDigest: head.analysis_config_digest })
      .then(() => undefined, () => undefined)
      .finally(() => { this.freshnessChecks.delete(repository); });
    this.freshnessChecks.set(repository, task);
  }

  /** ISO time when another paid update may start, or null. Failures count too. */
  private manualCooldown(latest: RepositoryUpdate | null): string | null {
    if (!latest || latest.status === "cancelled") return null;
    const minutes = this.options.config?.repositoryManualMinUpdateIntervalMinutes ?? 60;
    const until = Date.parse(latest.created_at) + minutes * 60_000;
    return until > Date.now() ? new Date(until).toISOString() : null;
  }

  /**
   * Explicit "update" for a project. It never replaces the page: the caller
   * receives status and, after publication, a refresh prompt.
   */
  async requestRepositoryUpdate(owner: ConversationOwner, projectId: string): Promise<{
    outcome: "up_to_date" | "joined" | "queued" | "deferred";
    update_id: string | null; job_id: string | null; retry_after: string | null; status: RepositoryViewStatus;
  }> {
    const project = await this.requireProject(owner.owner_id, projectId);
    if (project.source.kind !== "github") throw serviceError("invalid_request", "只有 GitHub 仓库可以更新", 400);
    const readable = project.analysis.stage === "done" && Boolean(project.analysis.canonical_snapshot_key)
      && !project.analysis.removed_by_admin;
    const repository = repositoryIdentityOf(project);
    const status = () => this.getRepositoryStatus(owner.owner_id, projectId, project.analysis.snapshot_id);
    const active = await this.store.loadActiveRepositoryUpdate(repository);
    const previousJob = await this.store.latestJob(projectId);
    const alreadyWaiting = previousJob?.status === "queued" || previousJob?.status === "running";
    if (!readable || active || alreadyWaiting) {
      // No usable snapshot (first analysis or retry) or a task is already
      // running: the normal admission path creates or joins it.
      const result = await this.startAnalysis({ owner, projectId });
      const running = result.job.status === "queued" || result.job.status === "running";
      return {
        outcome: active || alreadyWaiting ? "joined" : running ? "queued" : "up_to_date",
        update_id: result.job.repository_update_id ?? active?.update_id ?? null,
        job_id: running ? result.job.job_id : null,
        retry_after: null,
        status: await status(),
      };
    }
    const head = await this.store.loadCurrentRepositoryHead(repository);
    const key = head?.current_public_snapshot_key;
    if (!head || !key || !head.current_commit_sha) throw serviceError("snapshot_unavailable", "当前仓库快照不可用", 409);
    const execution = await this.options.analysisExecution?.();
    const digest = execution?.digest ?? await this.options.analysisConfigDigest?.() ?? ANALYSIS_CONFIG_DIGEST;
    const fresh = Boolean(head.upstream_commit_sha && head.last_checked_at && !head.check_error_code
      && Date.now() - Date.parse(head.last_checked_at) <= this.headFreshnessMs);
    let upstreamSha = fresh ? head.upstream_commit_sha ?? null : null;
    if (!upstreamSha) {
      const upstream = await this.resolveGithubHead(project.source.value, this.options.githubClientId,
        this.options.githubClientSecret, this.options.githubGateway).catch(() => null);
      if (!upstream) throw serviceError("github_check_failed", "暂时无法检查上游代码，当前仓库内容仍可继续使用。", 503);
      upstreamSha = upstream.commitSha;
      const checkedAt = nowIso();
      const comparison = upstreamSha === head.current_commit_sha
        ? { relation: "same" as const, behindCommits: 0 }
        : await fetchPublicGithubComparison(project.source.value, head.current_commit_sha, upstreamSha,
          this.options.githubClientId, this.options.githubClientSecret, this.options.githubGateway)
          .catch(() => ({ relation: "unknown" as const, behindCommits: null }));
      await this.store.saveRepositoryFreshness({ repository, baseSnapshotKey: key, upstreamCommitSha: upstreamSha,
        behindCommits: comparison.behindCommits, relation: comparison.relation, checkedAt,
        nextCheckAt: new Date(Date.parse(checkedAt) + this.headFreshnessMs).toISOString(), errorCode: null });
    }
    const sameIdentity = head.analyzer_bundle_version === ANALYZER_BUNDLE_VERSION && head.analysis_config_digest === digest;
    if (upstreamSha === head.current_commit_sha && sameIdentity) {
      return { outcome: "up_to_date", update_id: null, job_id: null, retry_after: null, status: await status() };
    }
    const cooldown = this.manualCooldown(await this.store.loadLatestRepositoryUpdate(repository));
    if (cooldown) return { outcome: "deferred", update_id: null, job_id: null, retry_after: cooldown, status: await status() };
    const result = await this.startAnalysis({ owner, projectId });
    return {
      outcome: result.job.status === "succeeded" ? "up_to_date" : "queued",
      update_id: result.job.repository_update_id ?? null,
      job_id: result.job.status === "succeeded" ? null : result.job.job_id,
      retry_after: null,
      status: await status(),
    };
  }

  private async touchRealUse(project: Project): Promise<void> {
    if (project.source.kind !== "github") return;
    const parsed = parseGithubRepository(project.source.value);
    await this.store.touchRepositoryRealUse(`${parsed.owner}/${parsed.repo}`.toLowerCase(),
      nowIso(), this.options.config?.repositoryActivityWriteIntervalMinutes ?? 15);
  }

  async checkRepositoryFreshness(identity: RepositoryIdentityInput, signal?: AbortSignal): Promise<{
    baseSnapshotId: string | null; upstreamCommitSha: string | null; behindCommits: number | null;
    relation: 'same' | 'ahead' | 'diverged' | 'rewound' | 'unknown'; checkedAt: string;
  }> {
    const current = await this.store.loadCurrentRepositoryHead(identity.repository);
    const key = current?.current_public_snapshot_key;
    const base = key ? await this.store.loadPublicSnapshotMetadata(key) : null;
    if (!key || !base) throw serviceError('snapshot_unavailable', '当前仓库快照不可用', 404);
    const checkedAt = nowIso();
    const value = `https://github.com/${identity.repository}`;
    try {
      const upstream = await this.resolveGithubHead(value, this.options.githubClientId,
        this.options.githubClientSecret, this.options.githubGateway, signal);
      if (!upstream) throw new Error('github_head_unavailable');
      const comparison = await fetchPublicGithubComparison(value, base.commit_sha,
        upstream.commitSha, this.options.githubClientId, this.options.githubClientSecret,
        this.options.githubGateway, signal);
      await this.store.saveRepositoryFreshness({ repository: identity.repository,
        baseSnapshotKey: key, upstreamCommitSha: upstream.commitSha,
        behindCommits: comparison.behindCommits, relation: comparison.relation,
        checkedAt,
        nextCheckAt: new Date(Date.parse(checkedAt) + (this.options.config?.repositoryBackgroundCheckIntervalHours ?? 24) * 3_600_000).toISOString(),
        errorCode: null });
      return { baseSnapshotId: base.analysis_snapshot_id, upstreamCommitSha: upstream.commitSha,
        behindCommits: comparison.behindCommits, relation: comparison.relation, checkedAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.store.saveRepositoryFreshness({ repository: identity.repository,
        baseSnapshotKey: key, upstreamCommitSha: null, behindCommits: null,
        relation: 'unknown', checkedAt,
        nextCheckAt: new Date(Date.parse(checkedAt) + 60 * 60_000).toISOString(),
        errorCode: 'github_check_failed' });
      return { baseSnapshotId: base.analysis_snapshot_id, upstreamCommitSha: null,
        behindCommits: null, relation: 'unknown', checkedAt };
    }
  }

  async requestBackgroundRepositoryUpdate(input: {
    identity: RepositoryIdentityInput; projectId: string; targetCommitSha: string;
  }): Promise<BackgroundAdmission> {
    const project = await this.store.loadProject(input.projectId);
    if (!project || project.source.kind !== 'github') return 'deferred:unavailable';
    const parsed = parseGithubRepository(project.source.value);
    if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== input.identity.repository.toLowerCase()) return 'deferred:unavailable';
    const config = this.options.config;
    // Money limits are admin budgets, checked atomically by the store.
    if (!config?.repositoryBackgroundRefreshEnabled) return 'deferred:disabled';
    const job = newAnalysisJob(project.project_id,
      `background:${input.identity.repository}:${input.targetCommitSha}:${Date.now()}`);
    job.execution_role = 'background';
    job.config_version = (await this.options.analysisExecution?.())?.configVersion;
    const result = await this.store.createBackgroundRepositoryUpdate({
      project, job, identity: input.identity, targetCommitSha: input.targetCommitSha,
      maxStartsPerDay: config.repositoryBackgroundMaxStartsPerDay ?? 2,
      maxActive: config.repositoryBackgroundMaxActive ?? 1,
      maxQueued: config.repositoryBackgroundMaxQueued ?? 4,
      minUpdateIntervalHours: config.repositoryBackgroundMinUpdateIntervalHours ?? 24,
      activeWindowDays: config.repositoryActiveWindowDays ?? 7,
      now: nowIso(),
    });
    if (result === 'queued') await this.enqueueIfRunnable(job);
    return result;
  }

  async refreshMigrationNotice(ownerId: string, projectId: string): Promise<Project> {
    const project = await this.requireProject(ownerId, projectId);
    if (project.source.kind !== "github") return project;
    const parsed = parseGithubRepository(project.source.value);
    const publicKey = project.analysis.canonical_snapshot_key;
    if (!publicKey) return project;
    const from = await this.store.loadPublicSnapshotMetadata(publicKey);
    const repository = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    if (!from || from.repository_identity !== repository) return project;
    // Follow this project's analysis lineage. A differently versioned API must
    // not replace a published result merely because the page is opened/polled.
    const identity = {
      repository,
      analyzerBundleVersion: from.analyzer_bundle_version,
      analysisConfigDigest: from.analysis_config_digest,
    };
    const head = await this.store.loadRepositoryHead(identity);
    if (!head?.current_public_snapshot_key || head.current_public_snapshot_key === publicKey) return project;
    const to = await this.store.loadPublicSnapshotMetadata(head.current_public_snapshot_key);
    if (!to) return project;
    const timestamp = nowIso();
    const previousCommit = from?.commit_sha ?? project.source.commit_sha ?? "";
    const existingMigration = project.repository_migration;
    const migration: RepositoryMigrationAction = existingMigration
      && existingMigration.to_public_snapshot_key === head.current_public_snapshot_key
      && (existingMigration.status === "pending" || existingMigration.status === "confirmed")
      ? existingMigration
      : {
          migration_id: randomUUID().replaceAll("-", ""),
          from_public_snapshot_key: publicKey,
          to_public_snapshot_key: head.current_public_snapshot_key,
          from_snapshot_id: from?.analysis_snapshot_id ?? project.analysis.snapshot_id ?? "",
          to_snapshot_id: to.analysis_snapshot_id,
          from_commit_sha: previousCommit,
          to_commit_sha: to.commit_sha,
          status: "pending",
          route_replanned: false,
          resume_step: project.study.current_step,
          summary: null,
          created_at: timestamp,
          resolved_at: null,
          executed_at: null,
          error: null,
        };
    const migrated = await this.store.executeRepositoryMigration({
      projectId,
      ownerId,
      migrationId: migration.migration_id,
      migration,
      summary: `仓库已自动迁移到 commit ${to.commit_sha.slice(0, 12)}；历史回答仍标注原 commit ${previousCommit.slice(0, 12)}。`,
    });
    if (!migrated) return project;
    const language = normalizeDisplayLanguage(migrated.display_language);
    const targetOverlay = to.language_overlay_version
      ? await this.store.loadSnapshotLanguageOverlay(head.current_public_snapshot_key, language)
      : null;
    if (to.language_overlay_version && !["ready", "degraded"].includes(targetOverlay?.status ?? "")) {
      const overlayKey = snapshotLanguageOverlayKey(head.current_public_snapshot_key, language);
      const activeJob = await this.store.latestJob(projectId);
      if (activeJob
        && (activeJob.status === "queued" || activeJob.status === "running")
        && activeJob.language_overlay_key === overlayKey) {
        await this.enqueueIfRunnable(activeJob);
        return migrated;
      }
      const overlayJob = newAnalysisJob(
        projectId,
        `migration-overlay:${projectId}:${head.current_public_snapshot_key}:${randomUUID()}`,
      );
      overlayJob.config_version = (await this.options.analysisExecution?.())?.configVersion;
      const queued = await this.admit(overlayJob, () => this.store.createOrJoinSnapshotLanguageOverlay({
        project: migrated,
        job: overlayJob,
        publicKey: head.current_public_snapshot_key!,
        language,
        newProject: false,
        systemManaged: true,
      }));
      await this.enqueueIfRunnable(queued.job);
      return (await this.store.loadProject(projectId, ownerId)) ?? migrated;
    }
    return migrated;
  }

  async listValuePoints(
    ownerId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<Record<string, unknown>> {
    const { snapshot } = await this.boundSnapshot(ownerId, projectId, snapshotId);
    return {
      project_id: projectId,
      snapshot_id: snapshotId,
      value_points: snapshot.value_points,
    };
  }

  async queryCodeEvidence(
    ownerId: string,
    projectId: string,
    snapshotId: string,
    query: EvidenceQuery,
  ): Promise<Record<string, unknown>> {
    const project = await this.requireProject(ownerId, projectId);
    if (!snapshotId || project.analysis.snapshot_id !== snapshotId) {
      throw serviceError("snapshot_mismatch", "请求的证据快照不是项目当前快照", 409);
    }
    if (project.analysis.canonical_snapshot_key) {
      const result = await this.store.queryPublicSnapshot({
        publicKey: project.analysis.canonical_snapshot_key,
        snapshotId,
        query: {
          include_metadata: false,
          text: query.text?.slice(0, 500),
          paths: boundedStrings(query.paths, 20, 500),
          languages: boundedStrings(query.languages, 12, 100),
          symbol_ids: boundedStrings(query.symbol_ids, 30, 256),
          component_ids: boundedStrings(query.component_ids, 20, 256),
          entity_ids: boundedStrings(query.entity_ids, 30, 256),
          entity_kinds: query.entity_kinds?.slice(0, 8),
          scope: query.scope,
          depth: clampInteger(query.depth, 0, 100, 100),
          projection: query.projection,
          personalized_entity_ids: boundedStrings(query.personalized_entity_ids, 20, 256),
          evidence_budget_tokens: clampInteger(query.evidence_budget_tokens, 256, 16_000, 4_000),
          relation_kinds: boundedStrings(query.relation_kinds, 20, 100),
          cursor: query.cursor ?? null,
          limit: clampInteger(query.limit, 1, 50, 20),
          expand_hops: clampInteger(query.expand_hops, 0, 2, 0),
        },
      });
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
      const linked = (ownerKind: "node" | "edge", ownerKey: string) => result.evidence_links
        .filter((link) => link.owner_kind === ownerKind && link.owner_key === ownerKey)
        .map((link) => evidenceById.get(link.evidence_id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      return {
        project_id: projectId,
        snapshot_id: snapshotId,
        nodes: result.nodes.map((row) => ({
          id: row.node_id,
          name: row.name,
          responsibility: row.responsibility,
          certainty: row.certainty,
          entity_kind: row.entity_kind,
          parent_entity_id: row.parent_entity_id,
          depth: row.depth,
          architecture_layer_name: row.layer_name,
          attributes: row.payload.attributes ?? row.payload,
          evidence: linked("node", row.node_key).slice(0, 12),
        })),
        edges: result.edges.map((row) => ({
          id: row.edge_id,
          source: row.source_node_key.split(":").slice(1).join(":"),
          target: row.target_node_key.split(":").slice(1).join(":"),
          relation_kind: row.relation_kind,
          label: row.label,
          description: row.description,
          certainty: row.certainty,
          evidence: linked("edge", row.edge_key).slice(0, 12),
        })),
        evidence: result.evidence.map((row) => ({
          stable_id: row.evidence_id,
          label: row.label,
          path: row.path,
          start_line: row.start_line,
          end_line: row.end_line,
          kind: row.kind,
          source_id: row.source_id,
          target_id: row.target_id,
        })),
          next_cursor: result.next_cursor,
          truncated: result.truncated,
          estimated_tokens: result.estimated_tokens,
          budget_tokens: result.budget_tokens,
          returned_evidence_count: result.returned_evidence_count,
          truncation_reason: result.truncation_reason,
        };
    }
    const { snapshot } = await this.boundSnapshot(ownerId, projectId, snapshotId);
    const result = querySnapshotQueryDirectory(
      buildSnapshotQueryDirectory(
        `local:${projectId}`,
        snapshotId,
        snapshot,
        { fact_graph: snapshot.fact_graph },
      ),
      {
        text: query.text?.slice(0, 500),
        paths: boundedStrings(query.paths, 20, 500),
        languages: boundedStrings(query.languages, 12, 100),
        symbol_ids: boundedStrings(query.symbol_ids, 30, 256),
        component_ids: boundedStrings(query.component_ids, 20, 256),
        entity_ids: boundedStrings(query.entity_ids, 30, 256),
        entity_kinds: query.entity_kinds?.slice(0, 8),
        scope: query.scope,
        depth: clampInteger(query.depth, 0, 100, 100),
        projection: query.projection,
        personalized_entity_ids: boundedStrings(query.personalized_entity_ids, 20, 256),
        evidence_budget_tokens: clampInteger(query.evidence_budget_tokens, 256, 16_000, 4_000),
        relation_kinds: boundedStrings(query.relation_kinds, 20, 100),
        cursor: query.cursor ?? null,
        limit: clampInteger(query.limit, 1, 50, 20),
        expand_hops: clampInteger(query.expand_hops, 0, 2, 0),
      },
    );
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
    const linked = (ownerKind: "node" | "edge", ownerKey: string) => result.evidence_links
      .filter((link) => link.owner_kind === ownerKind && link.owner_key === ownerKey)
      .map((link) => evidenceById.get(link.evidence_id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    return {
      project_id: projectId,
      snapshot_id: snapshotId,
      nodes: result.nodes.map((row) => ({
        id: row.node_id,
        name: row.name,
        responsibility: row.responsibility,
        certainty: row.certainty,
        entity_kind: row.entity_kind,
        parent_entity_id: row.parent_entity_id,
        depth: row.depth,
        architecture_layer_name: row.layer_name,
        attributes: row.payload.attributes ?? row.payload,
        evidence: linked("node", row.node_key).slice(0, 12),
      })),
      edges: result.edges.map((row) => ({
        id: row.edge_id,
        source: row.source_node_key.split(":").slice(1).join(":"),
        target: row.target_node_key.split(":").slice(1).join(":"),
        relation_kind: row.relation_kind,
        label: row.label,
        description: row.description,
        certainty: row.certainty,
        evidence: linked("edge", row.edge_key).slice(0, 12),
      })),
      evidence: result.evidence.map((row) => ({
        stable_id: row.evidence_id,
        label: row.label,
        path: row.path,
        start_line: row.start_line,
        end_line: row.end_line,
        kind: row.kind,
        source_id: row.source_id,
        target_id: row.target_id,
      })),
      next_cursor: result.next_cursor,
      truncated: result.truncated,
      estimated_tokens: result.estimated_tokens,
      budget_tokens: result.budget_tokens,
      returned_evidence_count: result.returned_evidence_count,
      truncation_reason: result.truncation_reason,
    };
  }

  async getLearningPlan(
    ownerId: string,
    projectId: string,
    snapshotId: string,
    selectedValuePoint?: string | null,
  ): Promise<Record<string, unknown>> {
    const { project, snapshot } = await this.boundSnapshot(ownerId, projectId, snapshotId);
    const plan = structuredClone(snapshot.learning_plan);
    plan.steps = project.study.dynamic_learning_plan?.length
      ? structuredClone(project.study.dynamic_learning_plan)
      : [];
    if (!selectedValuePoint) {
      return {
        project_id: projectId,
        snapshot_id: snapshotId,
        selected_value_point: project.study.selected_value_point,
        learning_plan: plan,
        study: project.study,
      };
    }
    const point = snapshot.value_points.find((item) => item.stable_id === selectedValuePoint);
    if (!point) throw serviceError("invalid_request", "价值点不存在", 400);
    plan.selected_value_point = point.stable_id;
    const updated = await this.store.updateProject(projectId, ownerId, (row) => {
      row.study.selected_value_point = point.stable_id;
      row.study.phase = "proposing";
      row.study.dynamic_learning_plan = [];
      row.study.total_steps = 0;
      row.study.current_step = 0;
      row.study.mastered = [];
      row.study.misconceptions = [];
      row.study.open_questions = [];
      row.study.used_evidence = [];
    });
    return {
      project_id: projectId,
      snapshot_id: snapshotId,
      selected_value_point: point.stable_id,
      learning_plan: plan,
      study: updated?.study ?? project.study,
    };
  }

  async ensureCurrentSnapshot(
    ownerId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<void> {
    await this.boundSnapshot(ownerId, projectId, snapshotId);
  }

  async boundSnapshot(
    ownerId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<{ project: Project; snapshot: EvidenceSnapshot }> {
    const project = await this.requireProject(ownerId, projectId);
    if (!snapshotId || project.analysis.snapshot_id !== snapshotId) {
      throw serviceError("snapshot_mismatch", "请求的证据快照不是项目当前快照", 409);
    }
    const snapshot = asEvidenceSnapshot(await this.store.loadSnapshot(projectId));
    if (!snapshot || snapshot.snapshot_id !== snapshotId) {
      throw serviceError("snapshot_unavailable", "项目图谱尚未完成", 404);
    }
    const analysis = await this.store.loadAnalysisResult<{
      fact_graph?: { nodes?: unknown[]; edges?: unknown[] };
    }>(projectId);
    if (
      analysis?.fact_graph
      && Array.isArray(analysis.fact_graph.nodes)
      && Array.isArray(analysis.fact_graph.edges)
    ) {
      snapshot.fact_graph = analysis.fact_graph as NonNullable<EvidenceSnapshot["fact_graph"]>;
    }
    return { project, snapshot };
  }

  private async requireProject(ownerId: string, projectId: string): Promise<Project> {
    const project = await this.store.loadProject(projectId, ownerId);
    if (!project) throw serviceError("not_found", "项目不存在", 404);
    return project;
  }

  private async enqueueIfRunnable(job: AnalysisJob): Promise<void> {
    if (job.status !== "queued" || job.execution_role === "waiter") return;
    try {
      await this.options.taskQueue?.enqueueAnalysis(job);
    } catch {
      // PostgreSQL/FileStore remains the source of truth. A scheduler or the
      // coordinator's recovery claim can repair a lost delivery notification.
    }
  }

}

function isGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "github.com"
      && url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function boundedStrings(value: string[] | undefined, maxItems: number, maxLength: number): string[] {
  return (value ?? [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  const candidate = Number(value ?? fallback);
  return Number.isInteger(candidate)
    ? Math.max(minimum, Math.min(maximum, candidate))
    : fallback;
}

