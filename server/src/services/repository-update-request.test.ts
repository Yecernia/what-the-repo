import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../domain/conversation.js";
import type { PublicSnapshotMetadata, RepositoryUpdate } from "../domain/lifecycle.js";
import { ANALYSIS_CONFIG_DIGEST, ANALYZER_BUNDLE_VERSION } from "../analysis/identity.js";
import type { ProductStore } from "../persistence/store.js";
import type { ServerConfig } from "../config.js";
import { RepositoryService } from "./repository-service.js";
import { resolveSnapshotView } from "./snapshot-view.js";

const current = "a".repeat(40);
const newer = "b".repeat(40);

function readableProject() {
  const project = createProject("guest:update", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.stage = "done";
  project.analysis.canonical_snapshot_key = "current-key";
  project.analysis.snapshot_id = "current-snapshot";
  return project;
}

test("background updates resolve current execution identity and config version together, not from the old snapshot", async () => {
  const project = readableProject();
  const admissions: Array<Parameters<ProductStore["createBackgroundRepositoryUpdate"]>[0]> = [];
  let executionReads = 0;
  const store = {
    loadProject: async () => project,
    createBackgroundRepositoryUpdate: async (input: Parameters<ProductStore["createBackgroundRepositoryUpdate"]>[0]) => {
      admissions.push(input);
      return 'queued';
    },
  } as unknown as ProductStore;
  const service = new RepositoryService(store, {
    config: { repositoryBackgroundRefreshEnabled: true } as ServerConfig,
    analysisExecution: async () => {
      const version = ++executionReads;
      return { digest: `current-config-${version}`, configVersion: version };
    },
    analysisConfigDigest: async () => { throw new Error('must use the same execution resolution'); },
  });
  const oldIdentity = { repository: 'EXAMPLE/REPO', analyzerBundleVersion: 'old-analyzer', analysisConfigDigest: 'old-config' };
  for (let version = 1; version <= 2; version++) {
    assert.equal(await service.requestBackgroundRepositoryUpdate({
      identity: oldIdentity, projectId: project.project_id, targetCommitSha: newer,
    }), 'queued');
    assert.equal(executionReads, version, 'resolve exactly once for each admission');
    const admitted = admissions[version - 1]!;
    assert.deepEqual(admitted.identity, { repository: 'example/repo', analyzerBundleVersion: ANALYZER_BUNDLE_VERSION,
      analysisConfigDigest: `current-config-${version}` });
    assert.equal(admitted.job.config_version, version);
    assert.equal(admitted.job.execution_role, 'background');
    assert.equal(admitted.targetCommitSha, newer);
    assert.equal(admitted.project, project);
  }
  assert.equal(oldIdentity.analysisConfigDigest, 'old-config', 'the published base identity stays unchanged');
});

test("background updates use the current digest fallback and reject an unrelated project before resolving it", async () => {
  const project = readableProject();
  let resolutions = 0;
  let admission: Parameters<ProductStore["createBackgroundRepositoryUpdate"]>[0] | undefined;
  const store = {
    loadProject: async () => project,
    createBackgroundRepositoryUpdate: async (input: Parameters<ProductStore["createBackgroundRepositoryUpdate"]>[0]) => {
      admission = input;
      return 'deferred:capacity';
    },
  } as unknown as ProductStore;
  const service = new RepositoryService(store, {
    config: { repositoryBackgroundRefreshEnabled: true } as ServerConfig,
    analysisConfigDigest: async () => { resolutions++; return 'current-fallback'; },
  });
  const input = { identity: { repository: 'example/other', analyzerBundleVersion: 'old', analysisConfigDigest: 'old' },
    projectId: project.project_id, targetCommitSha: newer };
  assert.equal(await service.requestBackgroundRepositoryUpdate(input), 'deferred:unavailable');
  assert.equal(resolutions, 0);
  assert.equal(admission, undefined);
  input.identity.repository = 'example/repo';
  assert.equal(await service.requestBackgroundRepositoryUpdate(input), 'deferred:capacity');
  assert.equal(resolutions, 1);
  assert.deepEqual(admission!.identity, { repository: 'example/repo', analyzerBundleVersion: ANALYZER_BUNDLE_VERSION,
    analysisConfigDigest: 'current-fallback' });
  assert.equal(admission!.job.config_version, undefined);
});

function metadata(overrides: Partial<PublicSnapshotMetadata> = {}): PublicSnapshotMetadata {
  return { public_snapshot_key: "current-key", repository_identity: "example/repo", commit_sha: current,
    analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, analysis_config_digest: ANALYSIS_CONFIG_DIGEST,
    analysis_snapshot_id: "current-snapshot", language_overlay_version: null,
    retired_at: null, purge_after: null, payload_purged_at: null, ...overrides };
}

function updateStore(project: ReturnType<typeof readableProject>, latest: RepositoryUpdate | null, limitedUntil: string | null = null) {
  const calls = { freshness: 0, created: 0, committedAt: undefined as string | null | undefined };
  const store = {
    loadProject: async () => project,
    // Reading the current version records the learning route's version once.
    updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); return project; },
    latestJob: async () => null,
    loadActiveRepositoryUpdate: async () => null,
    loadLatestRepositoryUpdate: async () => latest,
    ownerCreationRetryAfter: async () => limitedUntil,
    loadRepositoryUpdateForProject: async () => null,
    loadCurrentRepositoryHead: async () => ({ repository_identity: "example/repo", current_public_snapshot_key: "current-key",
      current_commit_sha: current, analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
      analysis_config_digest: ANALYSIS_CONFIG_DIGEST, last_checked_at: null, updated_at: "" }),
    loadPublicSnapshotMetadata: async () => metadata(),
    saveRepositoryFreshness: async (input: { upstreamCommittedAt?: string | null }) => {
      calls.freshness++; calls.committedAt = input.upstreamCommittedAt; return true;
    },
    createOrJoinRepositoryUpdate: async () => { calls.created++; throw new Error("must not start paid work"); },
  } as unknown as ProductStore;
  return { store, calls };
}

test("an explicit update at the current commit is up to date and creates no analysis job", async () => {
  const project = readableProject();
  const { store, calls } = updateStore(project, null);
  const service = new RepositoryService(store, {
    resolveGithubHead: async () => ({ owner: "example", repo: "repo", repository: "example/repo", commitSha: current,
      committedAt: "2026-09-20T08:00:00.000Z" }),
  });
  const result = await service.requestRepositoryUpdate({ owner_id: project.owner_id, kind: "guest" }, project.project_id);
  assert.equal(result.outcome, "up_to_date");
  assert.equal(result.job_id, null);
  assert.equal(calls.freshness, 1, "the confirmed head is cached for the status card");
  assert.equal(calls.committedAt, "2026-09-20T08:00:00.000Z", "the head commit time is cached with it");
  assert.equal(calls.created, 0);
});

test("a user over their hourly limit waits, while a recent update of the repository does not block them", async () => {
  const project = readableProject();
  const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const latest = { update_id: "u1", repository_identity: "example/repo", analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
    analysis_config_digest: ANALYSIS_CONFIG_DIGEST, target_commit_sha: newer, status: "failed", leader_project_id: project.project_id,
    lease_owner: null, lease_expires_at: null, heartbeat_at: null, result_public_snapshot_key: null, error: "x",
    created_at: createdAt, updated_at: createdAt, completed_at: createdAt, trigger: "background" } satisfies RepositoryUpdate;
  const head = async () => ({ owner: "example", repo: "repo", repository: "example/repo", commitSha: newer });

  // A background update ten minutes ago leaves the user free to update.
  const free = updateStore(project, latest);
  const status = await new RepositoryService(free.store, { resolveGithubHead: head }).getRepositoryStatus(project.owner_id, project.project_id);
  assert.deepEqual(status.update_eligibility, { allowed: true, reason: null, retry_after: null });

  // The user's own hourly limit, shared with new analyses, defers the update.
  const until = new Date(Date.now() + 20 * 60_000).toISOString();
  const limited = updateStore(project, latest, until);
  const result = await new RepositoryService(limited.store, { resolveGithubHead: head })
    .requestRepositoryUpdate({ owner_id: project.owner_id, kind: "guest" }, project.project_id);
  assert.equal(result.outcome, "deferred");
  assert.equal(result.retry_after, until);
  assert.equal(result.status.update_eligibility.reason, "rate_limited");
  assert.equal(limited.calls.created, 0);
});

test("a failed update is shown only to the user who asked for it", async () => {
  const project = readableProject();
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const failed = (trigger: RepositoryUpdate["trigger"], leader: string) => ({ update_id: "u1", repository_identity: "example/repo",
    analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, analysis_config_digest: ANALYSIS_CONFIG_DIGEST, target_commit_sha: newer,
    status: "failed", leader_project_id: leader, lease_owner: null, lease_expires_at: null, heartbeat_at: null,
    result_public_snapshot_key: null, error: "x", created_at: at, updated_at: at, completed_at: at, trigger }) satisfies RepositoryUpdate;
  const statusFor = async (latest: RepositoryUpdate, joined: boolean) => {
    const { store } = updateStore(project, latest);
    (store as unknown as { loadRepositoryUpdateForProject: () => Promise<RepositoryUpdate | null> })
      .loadRepositoryUpdateForProject = async () => joined ? latest : null;
    const service = new RepositoryService(store, {
      resolveGithubHead: async () => ({ owner: "example", repo: "repo", repository: "example/repo", commitSha: newer }),
    });
    return (await service.getRepositoryStatus(project.owner_id, project.project_id)).update;
  };
  assert.equal((await statusFor(failed("manual", project.project_id), true))?.status, "failed", "the requester sees it");
  assert.equal((await statusFor(failed("manual", "someone-else"), true))?.status, "failed", "so does a user who joined");
  assert.equal(await statusFor(failed("manual", "someone-else"), false), null, "someone else's failure stays hidden");
  assert.equal(await statusFor(failed("background", project.project_id), true), null,
    "a background run only borrows this project, so its failure stays hidden");
});

test("a readable project reports a GitHub failure instead of replacing its view", async () => {
  const project = readableProject();
  const { store } = updateStore(project, null);
  const service = new RepositoryService(store, { resolveGithubHead: async () => null });
  await assert.rejects(service.requestRepositoryUpdate({ owner_id: project.owner_id, kind: "guest" }, project.project_id),
    { code: "github_check_failed" });
  assert.equal(project.analysis.stage, "done");
});

test("a page may read a retired version of its repository only inside the grace period", async () => {
  const project = readableProject();
  const versions = new Map<string, PublicSnapshotMetadata>([
    ["old-snapshot", metadata({ public_snapshot_key: "old-key", analysis_snapshot_id: "old-snapshot", commit_sha: "0".repeat(40),
      retired_at: new Date(Date.now() - 3_600_000).toISOString(), purge_after: new Date(Date.now() + 3_600_000).toISOString() })],
    ["expired-snapshot", metadata({ public_snapshot_key: "expired-key", analysis_snapshot_id: "expired-snapshot",
      retired_at: new Date(Date.now() - 7_200_000).toISOString(), purge_after: new Date(Date.now() - 1).toISOString() })],
    ["unretired-snapshot", metadata({ public_snapshot_key: "unretired-key", analysis_snapshot_id: "unretired-snapshot" })],
    ["other-repo", metadata({ public_snapshot_key: "other-key", analysis_snapshot_id: "other-repo", repository_identity: "example/other",
      retired_at: new Date().toISOString(), purge_after: new Date(Date.now() + 3_600_000).toISOString() })],
  ]);
  const store = {
    findPublicSnapshotKeyBySnapshotId: async (id: string) => versions.get(id)?.public_snapshot_key ?? null,
    loadPublicSnapshotMetadata: async (key: string) => [...versions.values()].find(row => row.public_snapshot_key === key) ?? null,
    loadCurrentRepositoryHead: async () => ({ current_public_snapshot_key: "current-key" }),
  } as unknown as ProductStore;
  assert.deepEqual(await resolveSnapshotView(store, project, "current-snapshot"), { project, historical: false });
  const old = await resolveSnapshotView(store, project, "old-snapshot");
  assert.equal(old.historical, true);
  assert.equal(old.project.analysis.canonical_snapshot_key, "old-key");
  assert.equal(old.project.source.commit_sha, "0".repeat(40));
  assert.equal(project.analysis.snapshot_id, "current-snapshot", "the stored project is not changed");
  await assert.rejects(resolveSnapshotView(store, project, "expired-snapshot"), { code: "snapshot_expired", statusCode: 410 });
  await assert.rejects(resolveSnapshotView(store, project, "unretired-snapshot"), { code: "snapshot_mismatch" });
  await assert.rejects(resolveSnapshotView(store, project, "other-repo"), { code: "snapshot_mismatch" });
  await assert.rejects(resolveSnapshotView(store, project, "unknown"), { code: "snapshot_mismatch" });
});

test("a stale status read starts one free upstream check per repository and reports it as checking", async () => {
  const project = readableProject();
  const { store } = updateStore(project, null);
  let heads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: Array<{ upstreamCommitSha: string | null; relation: string }> = [];
  Object.assign(store, {
    saveRepositoryFreshness: async (input: { upstreamCommitSha: string | null; relation: string }) => { saved.push(input); return true; },
  });
  const service = new RepositoryService(store, {
    resolveGithubHead: async () => { heads++; await gate; return { owner: "example", repo: "repo", repository: "example/repo", commitSha: current }; },
  });
  const first = await service.getRepositoryStatus(project.owner_id, project.project_id);
  const second = await service.getRepositoryStatus(project.owner_id, project.project_id);
  assert.equal(first.freshness.check_status, "checking");
  assert.equal(second.freshness.check_status, "checking");
  assert.equal(heads, 1, "concurrent pages share one check");
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved.map(row => [row.upstreamCommitSha, row.relation]), [[current, "same"]]);
});
