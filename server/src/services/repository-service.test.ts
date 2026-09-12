import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../domain/conversation.js";
import type { PublicSnapshotMetadata } from "../domain/lifecycle.js";
import type { ProductStore } from "../persistence/store.js";
import { RepositoryService } from "./repository-service.js";

test("each new analysis resolves current execution identity before cache lookup and joining a job", async () => {
  let current = "config-a";
  const seen: string[] = [];
  const store = {
    loadRepositoryHead: async (identity: { analysisConfigDigest: string }) => { seen.push(identity.analysisConfigDigest); return null; },
    createOrJoinRepositoryUpdate: async (input: { identity: { analysisConfigDigest: string }; job: unknown }) => {
      assert.equal(input.identity.analysisConfigDigest, current);
      return { leader: true, job: input.job };
    },
  } as unknown as ProductStore;
  const service = new RepositoryService(store, { analysisConfigDigest: async () => current, resolveGithubHead: async () => null });
  const owner = { owner_id: "guest:cache-identity", kind: "guest" as const };
  await service.startAnalysis({ owner, kind: "github", value: "https://github.com/example/repo" });
  current = "config-b";
  await service.startAnalysis({ owner, kind: "github", value: "https://github.com/example/repo" });
  assert.deepEqual(seen, ["config-a", "config-b"]);
});

function fixture() {
  const project = createProject("guest:lineage", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.canonical_snapshot_key = "published-key";
  project.analysis.snapshot_id = "published-snapshot";
  project.analysis.stage = "done";
  const from: PublicSnapshotMetadata = {
    public_snapshot_key: "published-key", repository_identity: "example/repo",
    commit_sha: "a".repeat(40), analyzer_bundle_version: "isolated-analyzer-version",
    analysis_config_digest: "isolated-analysis-config", analysis_snapshot_id: "published-snapshot",
    language_overlay_version: null, retired_at: null, purge_after: null, payload_purged_at: null,
  };
  return { project, from };
}

test("reanalyzing retains the saved project language unless explicitly changed", async () => {
  const { project } = fixture();
  project.display_language = "en";
  project.messages = [{ role: "user", content: "请解释这个项目的架构" }] as typeof project.messages;
  const queuedLanguages: string[] = [];
  const store = {
    loadProject: async () => project,
    latestJob: async () => null,
    loadRepositoryHead: async () => null,
    createOrJoinRepositoryUpdate: async (input: { project: typeof project; job: unknown }) => {
      queuedLanguages.push(input.project.display_language!);
      return { leader: true, job: input.job };
    },
  } as unknown as ProductStore;
  const service = new RepositoryService(store, { resolveGithubHead: async () => null });
  const owner = { owner_id: project.owner_id, kind: "guest" as const };
  const result = await service.startAnalysis({ owner, projectId: project.project_id });
  assert.equal(result.project.display_language, "en");
  await service.startAnalysis({ owner, projectId: project.project_id, displayLanguage: "zh-CN" });
  assert.deepEqual(queuedLanguages, ["en", "zh-CN"]);
});

test("opening a project preserves its published result when the API uses another analysis version", async () => {
  const { project, from } = fixture();
  const before = JSON.stringify(project);
  let heads = 0;
  const store = {
    loadProject: async () => project,
    loadPublicSnapshotMetadata: async (key: string) => { assert.equal(key, from.public_snapshot_key); return from; },
    loadRepositoryHead: async (identity: Record<string, string>) => {
      heads++;
      assert.deepEqual(identity, { repository: from.repository_identity, analyzerBundleVersion: from.analyzer_bundle_version, analysisConfigDigest: from.analysis_config_digest });
      return { current_public_snapshot_key: from.public_snapshot_key };
    },
    executeRepositoryMigration: async () => { assert.fail("viewing must not migrate across analysis versions"); },
  } as unknown as ProductStore;
  assert.equal(await new RepositoryService(store).refreshMigrationNotice(project.owner_id, project.project_id), project);
  assert.equal(heads, 1);
  assert.equal(JSON.stringify(project), before);
});

test("opening a project still follows newer source commits within its analysis version", async () => {
  const { project, from } = fixture();
  const to = { ...from, public_snapshot_key: "next-key", analysis_snapshot_id: "next-snapshot", commit_sha: "b".repeat(40) };
  let migrations = 0;
  const store = {
    loadProject: async () => project,
    loadPublicSnapshotMetadata: async (key: string) => key === from.public_snapshot_key ? from : to,
    loadRepositoryHead: async () => ({ current_public_snapshot_key: to.public_snapshot_key }),
    executeRepositoryMigration: async (input: Parameters<ProductStore["executeRepositoryMigration"]>[0]) => {
      migrations++;
      assert.equal(input.migration?.from_public_snapshot_key, from.public_snapshot_key);
      assert.equal(input.migration?.to_public_snapshot_key, to.public_snapshot_key);
      assert.equal(input.migration?.to_commit_sha, to.commit_sha);
      return project;
    },
  } as unknown as ProductStore;
  assert.equal(await new RepositoryService(store).refreshMigrationNotice(project.owner_id, project.project_id), project);
  assert.equal(migrations, 1);
});
