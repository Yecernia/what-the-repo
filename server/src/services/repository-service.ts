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
  parseGithubRepository,
  type GithubGatewayTransport,
  type GithubRepositoryHead,
} from "../analysis/github.js";
import {
  ANALYSIS_CONFIG_DIGEST,
  ANALYZER_BUNDLE_VERSION,
  canonicalPublicSnapshotKey,
} from "../analysis/identity.js";
import type { TaskQueue } from "../queue/task-queue.js";

const DEFAULT_HEAD_FRESHNESS_MS = 60 * 60 * 1000;

export type GithubHeadResolver = (
  value: string,
  clientId?: string | null,
  clientSecret?: string | null,
  gateway?: GithubGatewayTransport | null,
) => Promise<GithubRepositoryHead | null>;

export interface RepositoryServiceOptions {
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

  constructor(
    private readonly store: ProductStore,
    private readonly options: RepositoryServiceOptions = {},
  ) {
    this.headFreshnessMs = options.headFreshnessMs ?? DEFAULT_HEAD_FRESHNESS_MS;
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
    project.analysis.stage = "fetching";
    project.analysis.error = null;
    project.analysis.started_at = startedAt;
    project.analysis.completed_at = null;
    project.analysis.progress_events = [];
    project.analysis.strategy = null;
    recordAnalysisProgress(project.analysis, "checking_existing", "running", startedAt);
    const sourceDigest = createHash("sha256").update(project.source.value).digest("hex").slice(0, 24);
    const job = newAnalysisJob(project.project_id, created
      ? `analysis:${project.project_id}:${sourceDigest}`
      : `analysis:${project.project_id}:${Date.now()}`);
    job.config_version = execution?.configVersion;
    const head = await this.store.loadRepositoryHead(identity);
    const fresh = head?.last_checked_at
      ? Date.now() - Date.parse(head.last_checked_at) <= this.headFreshnessMs
      : false;
    if (fresh && head?.current_public_snapshot_key) {
      const snapshot = await this.store.loadPublicSnapshot(head.current_public_snapshot_key);
      if (snapshot) {
        recordAnalysisProgress(project.analysis, "checking_existing", "completed");
        setAnalysisStrategy(project.analysis, "reuse");
        recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
        return this.bindExistingSnapshot({ project, job, created, publicKey: head.current_public_snapshot_key, snapshot });
      }
    }

    recordAnalysisProgress(project.analysis, "checking_existing", "completed");
    recordAnalysisProgress(project.analysis, "confirming_upstream", "running");
    let upstream: GithubRepositoryHead | null = null;
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
    recordAnalysisProgress(project.analysis, "confirming_upstream", "completed");
    if (upstream) {
      recordAnalysisProgress(project.analysis, "comparing_versions", "running");
      if (head?.current_commit_sha === upstream.commitSha && head.current_public_snapshot_key) {
        const snapshot = await this.store.loadPublicSnapshot(head.current_public_snapshot_key);
        if (snapshot) {
          const checkedAt = nowIso();
          await this.store.saveRepositoryHead({ ...head, last_checked_at: checkedAt, updated_at: checkedAt });
          recordAnalysisProgress(project.analysis, "comparing_versions", "completed");
          setAnalysisStrategy(project.analysis, "reuse");
          recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
          return this.bindExistingSnapshot({ project, job, created, publicKey: head.current_public_snapshot_key, snapshot });
        }
      }
      const exactKey = canonicalPublicSnapshotKey(repository, upstream.commitSha, ANALYZER_BUNDLE_VERSION, analysisConfigDigest);
      const exact = await this.store.loadPublicSnapshot(exactKey);
      if (exact) {
        const checkedAt = nowIso();
        await this.store.saveRepositoryHead({
          repository_identity: repository,
          analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
          analysis_config_digest: analysisConfigDigest,
          current_public_snapshot_key: exactKey,
          current_commit_sha: upstream.commitSha,
          last_checked_at: checkedAt,
          updated_at: checkedAt,
        });
        recordAnalysisProgress(project.analysis, "comparing_versions", "completed");
        setAnalysisStrategy(project.analysis, "reuse");
        recordAnalysisProgress(project.analysis, "reusing_snapshot", "completed");
        return this.bindExistingSnapshot({ project, job, created, publicKey: exactKey, snapshot: exact });
      }
    }

    project.updated_at = startedAt;
    const queued = await this.admit(job, () => this.store.createOrJoinRepositoryUpdate({
      project,
      job,
      identity,
      targetCommitSha: upstream?.commitSha ?? null,
      newProject: created,
    }));
    if (!queued.leader) {
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
    snapshot: PublicSnapshotBundle;
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
      job_status: job?.status ?? null,
      job_attempt: job?.attempt ?? null,
      job_max_attempts: job?.max_attempts ?? null,
      heartbeat_at: job?.heartbeat_at ?? null,
      retryable: !job || job.status === "failed" || job.status === "cancelled",
    };
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
