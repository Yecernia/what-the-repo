import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import type { ServerConfig } from "../config.js";
import { createProject } from "../domain/conversation.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { ProductStore } from "../persistence/store.js";
import { AnalysisCoordinator } from "./coordinator.js";
import { resolveAnalysisExecution } from "./execution-identity.js";
import { ANALYSIS_CONFIG_DIGEST, ANALYZER_BUNDLE_VERSION, canonicalPublicSnapshotKey } from "./identity.js";

test("a new analysis configuration discards an assembly checkpoint before retrying the same commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-new-config-"));
  const originalFetch = globalThis.fetch;
  const commitSha = "a".repeat(40);
  const config = { analysisPendingLimit: 1, dataDir: root,
    githubGatewayUrl: "https://gateway.example", githubGatewaySharedSecret: "test",
  } as ServerConfig;
  const newDigest = (await resolveAnalysisExecution(config)).digest;
  const oldDigest = "previous-config";
  assert.notEqual(newDigest, oldDigest);
  const project = createProject("guest:new-config", "https://github.com/example/repo", "New config", null);
  const now = new Date().toISOString();
  const job = {
    job_id: "new-config", project_id: project.project_id, idempotency_key: "new-config", status: "running",
    attempt: 1, max_attempts: 3, lease_owner: "test-worker", lease_expires_at: now,
    heartbeat_at: now, created_at: now, updated_at: now, available_at: now,
    completed_at: null, error: null, error_code: null,
    repository_update_id: "new-update", execution_role: "leader",
  } as AnalysisJob;
  let cleared = 0;
  let saved = 0;
  let failure = "";
  const requests: string[] = [];
  const store = {
    root,
    loadProject: async () => project,
    listRepositoryUpdateProjects: async () => [project],
    updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
    loadAnalysisCheckpoint: async () => ({ checkpoint: {
      analyzer_bundle_version: ANALYZER_BUNDLE_VERSION,
      static_identity: ANALYSIS_CONFIG_DIGEST,
      analysis_config_digest: oldDigest,
      stage: "assembly", source_root: root, repository: "example/repo", commit_sha: commitSha,
      public_key: canonicalPublicSnapshotKey("example/repo", commitSha, ANALYZER_BUNDLE_VERSION, oldDigest),
      snapshot_id: "previous-snapshot",
    }, snapshot: {} }),
    loadRepositoryUpdateForProject: async () => ({
      update_id: "new-update", target_commit_sha: commitSha, analysis_config_digest: newDigest,
    }),
    clearAnalysisCheckpoint: async () => { cleared++; },
    saveAnalysisCheckpoint: async () => { saved++; throw new Error("new_source_selected"); },
    failRepositoryUpdate: async (_id: string, error: string) => { failure = error; },
  } as unknown as ProductStore;
  try {
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { kind: string };
      requests.push(request.kind);
      if (request.kind === "metadata") return Response.json({ default_branch: "main" });
      if (request.kind === "commit") return Response.json({ sha: commitSha });
      if (request.kind === "tree") return Response.json({ tree: [{ path: "README.md", type: "blob", size: 6 }] });
      if (request.kind === "archive") return new Response(new Uint8Array(zipSync({ "repo/README.md": strToU8("source") })).buffer);
      throw new Error("unexpected_request");
    }) as typeof fetch;
    const coordinator = new AnalysisCoordinator(store, config) as unknown as {
      processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void>;
    };
    await coordinator.processClaimedJob(job, new AbortController().signal);
    assert.equal(cleared, 1, "the obsolete checkpoint must be removed");
    assert.equal(saved, 1, "the new configuration must start a fresh source checkpoint");
    assert.equal(failure, "new_source_selected");
    assert.deepEqual(requests, ["metadata", "commit", "tree", "archive"]);
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
