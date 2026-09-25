import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../domain/conversation.js";
import type { PublicSnapshotMetadata, RepositoryUpdate } from "../domain/lifecycle.js";
import { ANALYSIS_CONFIG_DIGEST, ANALYZER_BUNDLE_VERSION } from "../analysis/identity.js";
import type { ProductStore } from "../persistence/store.js";
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

function metadata(overrides: Partial<PublicSnapshotMetadata> = {}): PublicSnapshotMetadata {
  return { public_snapshot_key: "current-key", repository_identity: "example/repo", commit_sha: current,
    analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, analysis_config_digest: ANALYSIS_CONFIG_DIGEST,
    analysis_snapshot_id: "current-snapshot", language_overlay_version: null,
    retired_at: null, purge_after: null, payload_purged_at: null, ...overrides };
}

function updateStore(project: ReturnType<typeof readableProject>, latest: RepositoryUpdate | null) {
  const calls = { freshness: 0, created: 0, committedAt: undefined as string | null | undefined };
  const store = {
    loadProject: async () => project,
    // Reading the current version records the learning route's version once.
    updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); return project; },
    latestJob: async () => null,
    loadActiveRepositoryUpdate: async () => null,
    loadLatestRepositoryUpdate: async () => latest,
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

test("a new paid update waits for the per-repository cooldown, including after a failure", async () => {
  const project = readableProject();
  const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const latest = { update_id: "u1", repository_identity: "example/repo", analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
    analysis_config_digest: ANALYSIS_CONFIG_DIGEST, target_commit_sha: newer, status: "failed", leader_project_id: project.project_id,
    lease_owner: null, lease_expires_at: null, heartbeat_at: null, result_public_snapshot_key: null, error: "x",
    created_at: createdAt, updated_at: createdAt, completed_at: createdAt } satisfies RepositoryUpdate;
  const { store, calls } = updateStore(project, latest);
  const service = new RepositoryService(store, {
    resolveGithubHead: async () => ({ owner: "example", repo: "repo", repository: "example/repo", commitSha: newer }),
  });
  const result = await service.requestRepositoryUpdate({ owner_id: project.owner_id, kind: "guest" }, project.project_id);
  assert.equal(result.outcome, "deferred");
  assert.equal(Date.parse(result.retry_after!), Date.parse(createdAt) + 60 * 60_000);
  assert.equal(result.status.update_eligibility.reason, "cooldown");
  assert.equal(calls.created, 0);
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
