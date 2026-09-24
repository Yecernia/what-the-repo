import { ANALYZER_BUNDLE_VERSION, ANALYSIS_CONFIG_DIGEST } from "./identity.js";
import { resolveAnalysisExecution } from "./execution-identity.js";
import assert from "node:assert/strict";
import { buildFullPlan, buildIncrementalPlan, createAnalysisCache } from './incremental.js';
import { decodeSource } from './source-input.js';
import type { LspRunResult, ParsedFile } from './facts.js';
import test from "node:test";
import {
  AnalysisCoordinator,
  createSemanticBatchRecorder,
  analysisRetryDelayMs,
  isRetryableAnalysisError,
  resolveAnalysisProvider,
  semanticTerminalFailureCode,
} from "./coordinator.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { ServerConfig } from "../config.js";
import type { ProductStore } from "../persistence/store.js";
import { FileStore } from "../persistence/file-store.js";
import { createSemanticBatch, type SemanticBatch } from "../domain/semantic-batch.js";
import { createWorkerDiagnostics } from "../agent/worker-diagnostics.js";
import { mkdtemp, rm } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createProject } from "../domain/conversation.js";
import { buildSnapshot, type BuiltSnapshot } from "./graph.js";
import { canonicalPublicSnapshotKey } from "./identity.js";

test("assembly resume publishes the recorded execution identity and rejects missing or mismatched identity", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "analysis-identity-resume-"));
  assert.ok(resolve(sourceRoot).startsWith(resolve(tmpdir()) + sep));
  try {
    const project = createProject("guest:resume", "https://github.com/example/repo", "Resume", null);
    const snapshot = buildSnapshot({ snapshotId: "resume-snapshot", repository: "example/repo", commitSha: "a".repeat(40), files: [], sourceRoot });
    const publicKey = canonicalPublicSnapshotKey(snapshot.repository, snapshot.commit_sha, "previous-analyzer", "previous-config");
    const checkpoint = { stage: "assembly", source_root: sourceRoot, repository: snapshot.repository,
      commit_sha: snapshot.commit_sha, snapshot_id: snapshot.snapshot_id, public_key: publicKey,
      analysis_config_digest: "previous-config", analyzer_bundle_version: "previous-analyzer", provenance_applied: true };
    const saved: Array<{ analysisConfigDigest: string; analyzerBundleVersion: string; publicKey: string }> = [];
    project.analysis.stage = "fetching";
    const store = { savePublicSnapshot: async (input: typeof saved[number]) => {
      assert.equal(project.analysis.stage, "interpreting", "resumed publication must not remain in fetching");
      saved.push(input);
    },
      saveSnapshotLanguageOverlay: async () => {}, loadProject: async () => project,
      updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
      finishAnalysisJob: async () => {}, clearAnalysisCheckpoint: async () => {}, saveTrace: async () => {},
    } as unknown as ProductStore;
    const coordinator = new AnalysisCoordinator(store, config(1)) as unknown as {
      resumeAssemblyFromCheckpoint: (input: { checkpoint: Record<string, unknown>; snapshot: BuiltSnapshot; job: AnalysisJob; project: typeof project; signal: AbortSignal; fence: Record<string, unknown> }) => Promise<void>;
    };
    const input = { checkpoint, snapshot, job: job("resume"), project, signal: new AbortController().signal, fence: {} };
    await assert.rejects(coordinator.resumeAssemblyFromCheckpoint({ ...input, checkpoint: { ...checkpoint, analysis_config_digest: undefined } }), /identity_missing/);
    await assert.rejects(coordinator.resumeAssemblyFromCheckpoint({ ...input, checkpoint: { ...checkpoint, analysis_config_digest: "different-config" } }), /identity_mismatch/);
    assert.equal(saved.length, 0);
    await coordinator.resumeAssemblyFromCheckpoint(input);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.analysisConfigDigest, "previous-config");
    assert.equal(saved[0]?.analyzerBundleVersion, "previous-analyzer");
    assert.equal(saved[0]?.publicKey, publicKey);
    assert.deepEqual(project.analysis.progress_events?.map(event => [event.kind, event.status]), [
      ["validating_analysis", "completed"], ["publishing_analysis", "completed"], ["completed", "completed"],
    ]);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

function job(id: string): AnalysisJob {
  const timestamp = new Date().toISOString();
  return {
    job_id: id,
    project_id: `project:${id}`,
    idempotency_key: `idempotency:${id}`,
    status: "running",
    attempt: 1,
    max_attempts: 3,
    lease_owner: "test-worker",
    lease_expires_at: timestamp,
    heartbeat_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    available_at: timestamp,
    completed_at: null,
    error: null,
    error_code: null,
  };
}

function config(concurrency: number): ServerConfig {
  return { analysisPendingLimit: concurrency } as ServerConfig;
}

test("Worker starts research before source download, skips reusable snapshots, and cancels early work on source failure", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-early-research-"));
  const originalFetch = globalThis.fetch;
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  try {
    for (const cached of [false, true]) {
      const project = createProject("guest:early", "https://github.com/example/repo", "Early research", null);
      const rows = new Map<string, SemanticBatch>();
      let searches = 0, cancelled = false;
      let searchStarted!: () => void;
      const ready = new Promise<void>(resolve => { searchStarted = resolve; });
      const store = {
        root,
        loadProject: async () => project, loadAnalysisCheckpoint: async () => null,
        loadPublicSnapshotMetadata: async () => cached ? { analysis_snapshot_id: "existing" } : null,
        updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
        finishAnalysisJob: async () => true,
        loadSemanticBatch: async (_job: string, id: string) => rows.get(id) ?? null,
        saveSemanticBatch: async (batch: SemanticBatch) => { rows.set(batch.batch_id, structuredClone(batch)); },
      } as unknown as ProductStore;
      globalThis.fetch = (async (url, init) => {
        if (String(url) === "https://api.tavily.com/search") {
          searches++; searchStarted();
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        }
        const request = JSON.parse(String(init?.body));
        if (request.kind === "metadata") return Response.json({ default_branch: "main" });
        if (request.kind === "commit") return Response.json({ sha: "a".repeat(40) });
        if (request.kind === "tree") {
          if (!cached) await ready;
          assert.equal(searches, cached ? 0 : 1, "search overlaps source preparation");
          return Response.json({ tree: [{ path: "README.md", type: "blob", size: 1 }] });
        }
        if (request.kind === "archive") return new Response("", { status: 400 });
        throw new Error("unexpected network request");
      }) as typeof fetch;
      const coordinator = new AnalysisCoordinator(store, { ...config(1), dataDir: root,
        analysisProviderId: "deepseek", analysisProviderModel: "deepseek-v4-flash", analysisProviderApiKey: "test",
        githubGatewayUrl: "https://gateway.example", githubGatewaySharedSecret: "test", webSearchApiKey: "test",
      } as ServerConfig) as unknown as { processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void> };
      await coordinator.processClaimedJob({ ...job("early"), project_id: project.project_id }, new AbortController().signal);
      assert.equal(searches, cached ? 0 : 1);
      assert.equal(cancelled, !cached);
      assert.equal(rows.get("value-initial-search")?.status, cached ? undefined : "cancelled");
      assert.equal(project.analysis.error, "github_archive_400");
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_wait_timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("analysis coordinator honors configured concurrency without claiming extra work", async () => {
  let claims = 0;
  let available = 4;
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const store = {
    claimAnalysisJob: async () => {
      if (available === 0) return null;
      available--;
      claims += 1;
      return job(`job:${claims}`);
    },
  } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, config(2));
  (coordinator as unknown as { process: (item: AnalysisJob) => Promise<void> }).process = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await blocked;
    active -= 1;
  };

  const firstBatch = Promise.all([
    coordinator.runOnce(),
    coordinator.runOnce(),
    coordinator.runOnce(),
  ]);
  await waitFor(() => active === 2);
  assert.equal(claims, 2);
  release();
  await firstBatch;

  assert.equal(claims, 4, "completion drains accepted work without another wakeup");
  available = 2;
  let secondRelease!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { secondRelease = resolve; });
  (coordinator as unknown as { process: (item: AnalysisJob) => Promise<void> }).process = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await secondBlocked;
    active -= 1;
  };
  const secondBatch = Promise.all([coordinator.runOnce(), coordinator.runOnce()]);
  await waitFor(() => active === 2);
  secondRelease();
  await secondBatch;
  assert.equal(claims, 6);
  assert.equal(maximumActive, 2);
  await coordinator.stop();
});

test("analysis coordinator waits for an active run during graceful stop", async () => {
  let started!: () => void;
  let release!: () => void;
  const startedSignal = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const store = {
    claimAnalysisJob: async () => job("job:shutdown"),
  } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, config(1));
  (coordinator as unknown as { process: (item: AnalysisJob) => Promise<void> }).process = async () => {
    started();
    await blocked;
  };

  const run = coordinator.runOnce();
  await startedSignal;
  let stopped = false;
  const stopping = coordinator.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await run;
  await stopping;
  assert.equal(stopped, true);
});

test("analysis coordinator releases its job lease for immediate resume on graceful stop", async () => {
  const claimed = job("job:resume-after-stop");
  let released: { jobId: string; workerId: string; attempt: number } | null = null;
  const store = {
    claimAnalysisJob: async () => claimed,
    loadJob: async () => claimed,
    releaseAnalysisJobForResume: async (jobId: string, workerId: string, attempt: number) => {
      released = { jobId, workerId, attempt };
      return true;
    },
  } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, config(1));
  (coordinator as unknown as {
    processClaimedJob: (item: AnalysisJob, signal: AbortSignal) => Promise<void>;
  }).processClaimedJob = async (_item, signal) => {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const run = coordinator.runOnce();
  await waitFor(() => (coordinator as unknown as { activeRuns: number }).activeRuns === 1);
  await coordinator.stop();
  await run;

  assert.deepEqual(released, {
    jobId: claimed.job_id,
    workerId: claimed.lease_owner,
    attempt: claimed.attempt,
  });
});

test("analysis retry policy only schedules transient failures with bounded backoff", () => {
  assert.equal(isRetryableAnalysisError("provider_transient_error"), true);
  assert.equal(isRetryableAnalysisError("provider_request_failed"), false);
  assert.equal(isRetryableAnalysisError("provider_balance_insufficient"), false);
  assert.equal(isRetryableAnalysisError("provider_connection_failed"), true);
  assert.equal(isRetryableAnalysisError("provider_rate_limited"), true);
  assert.equal(isRetryableAnalysisError("component_semantics_incomplete"), false);
  assert.equal(isRetryableAnalysisError("github_api_429"), true);
  assert.equal(isRetryableAnalysisError("github_rate_limited"), false);
  assert.equal(isRetryableAnalysisError("provider_timeout"), true);
  assert.equal(isRetryableAnalysisError("invalid_github_repository"), false);
  assert.equal(isRetryableAnalysisError("analysis_lease_lost"), false);
  assert.equal(analysisRetryDelayMs(1), 5_000);
  assert.equal(analysisRetryDelayMs(2), 10_000);
  assert.equal(analysisRetryDelayMs(9), 60_000);
});

test("transient analysis retry preserves the same job and stops at its attempt limit", async () => {
  const saved: AnalysisJob[] = [];
  let projectRecorded = false;
  const store = { finishAnalysisJob: async (next: AnalysisJob) => {
    assert.equal(projectRecorded, true, "record the project while still owning its lease");
    saved.push(next); return true;
  } } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, config(1)) as unknown as {
    requeueAfterTransientFailure: (job: AnalysisJob, worker: string, message: string, beforeRelease: () => Promise<void>) => Promise<boolean>;
  };
  for (const attempt of [1, 2, 3]) {
    projectRecorded = false;
    const result = await coordinator.requeueAfterTransientFailure({ ...job("resume-same-job"), attempt, max_attempts: 3 }, "worker", "provider_transient_error", async () => { projectRecorded = true; });
    assert.equal(result, attempt < 3);
  }
  assert.equal(saved.length, 2);
  assert.ok(saved.every(row => row.job_id === "resume-same-job" && row.status === "queued" && row.error_code === "analysis_retry_scheduled"));
  assert.equal(projectRecorded, false, "exhaustion must not requeue indefinitely");
});

test("repository analysis resolves deployment credentials instead of project settings", () => {
  const provider = resolveAnalysisProvider({
    ...config(1),
    freeProviderBaseUrl: "https://free.example/v1",
    freeProviderModel: "free-model",
    freeProviderApiKey: "free-key",
    analysisProviderId: "deepseek",
    analysisProviderBaseUrl: "https://analysis.example/v1",
    analysisProviderModel: "deepseek-v4-flash",
    analysisProviderApiKey: "analysis-key",
  });
  assert.ok(provider);
  assert.equal(provider?.connectionId, "platform-analysis");
  assert.equal(provider?.baseUrl, "https://analysis.example/v1");
  assert.equal(provider?.model, "deepseek-v4-flash");
  assert.equal(provider?.apiKey, "analysis-key");
});

test("semantic terminal failures are recognized before static snapshot publication", () => {
  assert.equal(semanticTerminalFailureCode("architecture:provider_transient_error:provider_connection_failed;values:skipped"), "provider_connection_failed");
  assert.equal(semanticTerminalFailureCode("architecture:provider_transient_error:provider_balance_insufficient;values:skipped"), "platform_provider_balance_insufficient");
  assert.equal(semanticTerminalFailureCode("semantic_site_analysis_budget_exhausted"), "site_analysis_budget_exhausted");
  assert.equal(isRetryableAnalysisError("site_analysis_budget_exhausted"), false);
  assert.equal(isRetryableAnalysisError("site_budget_disabled"), false);
  assert.equal(semanticTerminalFailureCode("architecture:provider_transient_error;values:skipped"), "provider_transient_error");
  assert.equal(semanticTerminalFailureCode("architecture:component_semantics_incomplete;values:skipped"), "structured_worker_failed");
  assert.equal(semanticTerminalFailureCode("value_candidate_validation_failed"), "structured_worker_failed");
  assert.equal(semanticTerminalFailureCode("provider_unavailable"), "provider_unavailable");
  assert.equal(semanticTerminalFailureCode("architecture:semantic_no_structured_result;values:skipped"), "structured_worker_failed");
  assert.equal(semanticTerminalFailureCode("semantic_provider_configuration"), "provider_configuration");
  assert.equal(semanticTerminalFailureCode("partial:12/20"), null);
  assert.equal(semanticTerminalFailureCode("completed"), null);
  assert.equal(semanticTerminalFailureCode("architecture:completed;values:value_output_missing:text_repair_exhausted"), "structured_worker_failed");
  assert.equal(semanticTerminalFailureCode("value_output_missing:another_no_result_reason"), "structured_worker_failed");
  assert.equal(semanticTerminalFailureCode("value_output_missing:provider_request_failed"), "provider_unavailable");
  assert.equal(semanticTerminalFailureCode("value_output_missing:analysis_job_call_limit_exceeded"), "analysis_job_call_limit_exceeded");
});

test("unreadable analysis checkpoint fails recovery before source or model work", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-bad-checkpoint-"));
  const project = createProject("guest:checkpoint", "https://github.com/example/repo", "Recovery", null);
  let status: string | undefined;
  const store = {
    root,
    loadProject: async () => project,
    loadAnalysisCheckpoint: async () => { throw new Error("analysis_checkpoint_payload_digest_mismatch"); },
    updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
    finishAnalysisJob: async (row: AnalysisJob) => { status = row.status; },
  } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, { ...config(1), dataDir: root }) as unknown as {
    processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void>;
  };
  try {
    await coordinator.processClaimedJob({ ...job("unreadable"), project_id: project.project_id }, new AbortController().signal);
    assert.equal(status, "failed");
    assert.equal(project.analysis.error, "analysis_checkpoint_payload_digest_mismatch");
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("a new repository target discards an older checkpoint before any stage can resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-new-commit-"));
  const originalFetch = globalThis.fetch;
  const previous = "a".repeat(40), target = "b".repeat(40);
  const serverConfig = { ...config(1), dataDir: root,
    githubGatewayUrl: "https://gateway.example", githubGatewaySharedSecret: "test",
  } as ServerConfig;
  const analysisConfigDigest = (await resolveAnalysisExecution(serverConfig)).digest;
  try {
    for (const stage of ["source", "semantic", "assembly"] as const) {
      const project = createProject("guest:new-commit", "https://github.com/example/repo", "New commit", null);
      let cleared = 0;
      let saved = 0;
      let failure = "";
      const requests: Array<{ kind: string; ref?: string }> = [];
      const store = {
        root,
        loadProject: async () => project,
        listRepositoryUpdateProjects: async () => [project],
        updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
        loadAnalysisCheckpoint: async () => ({ checkpoint: {
          analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, static_identity: ANALYSIS_CONFIG_DIGEST,
          stage, source_root: root, commit_sha: previous, snapshot_id: "previous-snapshot",
          fetched: { owner: "example", repo: "repo", commitSha: previous, files: ["README.md"], manifest: [] },
        } }),
        loadRepositoryUpdateForProject: async () => ({ update_id: "new-update", target_commit_sha: target, analysis_config_digest: analysisConfigDigest }),
        clearAnalysisCheckpoint: async () => { cleared++; },
        saveAnalysisCheckpoint: async () => { saved++; throw new Error("new_source_selected"); },
        failRepositoryUpdate: async (_id: string, error: string) => { failure = error; },
      } as unknown as ProductStore;
      globalThis.fetch = (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { kind: string; ref?: string };
        requests.push(request);
        if (request.kind === "metadata") return Response.json({ default_branch: "main" });
        if (request.kind === "commit") return Response.json({ sha: target });
        if (request.kind === "tree") return Response.json({ tree: [{ path: "README.md", type: "blob", size: 6 }] });
        if (request.kind === "archive") return new Response(new Uint8Array(zipSync({ "repo/README.md": strToU8("source") })).buffer);
        throw new Error("unexpected_request");
      }) as typeof fetch;
      const coordinator = new AnalysisCoordinator(store, serverConfig) as unknown as { processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void> };
      await coordinator.processClaimedJob({ ...job(`new-commit-${stage}`), project_id: project.project_id,
        repository_update_id: "new-update", execution_role: "leader" }, new AbortController().signal);
      assert.equal(cleared, 1, stage);
      assert.equal(saved, 1, stage);
      assert.equal(failure, "new_source_selected", stage);
      assert.deepEqual(requests.map(request => request.kind), ["metadata", "commit", "tree", "archive"], stage);
      assert.ok(requests.filter(request => request.ref).every(request => request.ref === target), stage);
    }
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository checkpoint for the queued commit still resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-same-commit-"));
  const originalFetch = globalThis.fetch;
  const target = "a".repeat(40);
  const serverConfig = { ...config(1), dataDir: root } as ServerConfig;
  const analysisConfigDigest = (await resolveAnalysisExecution(serverConfig)).digest;
  const project = createProject("guest:same-commit", "https://github.com/example/repo", "Same commit", null);
  let cleared = 0, requested = 0, failure = "";
  try {
    globalThis.fetch = (async () => { requested++; throw new Error("unexpected_github_fetch"); }) as typeof fetch;
    const store = {
      root,
      loadProject: async () => project,
      listRepositoryUpdateProjects: async () => [project],
      updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
      loadAnalysisCheckpoint: async () => ({ checkpoint: {
        analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, static_identity: ANALYSIS_CONFIG_DIGEST,
        analysis_config_digest: analysisConfigDigest,
        stage: "source", source_root: root, commit_sha: target, snapshot_id: "saved-source",
        fetched: { owner: "example", repo: "repo", commitSha: target, files: ["README.md"], manifest: [] },
      } }),
      loadRepositoryUpdateForProject: async () => ({ update_id: "same-update", target_commit_sha: target, analysis_config_digest: analysisConfigDigest }),
      clearAnalysisCheckpoint: async () => { cleared++; },
      saveAnalysisCheckpoint: async () => { throw new Error("checkpoint_source_reused"); },
      failRepositoryUpdate: async (_id: string, error: string) => { failure = error; },
    } as unknown as ProductStore;
    const coordinator = new AnalysisCoordinator(store, serverConfig) as unknown as {
      processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void>;
    };
    await coordinator.processClaimedJob({ ...job("same-commit"), project_id: project.project_id,
      repository_update_id: "same-update", execution_role: "leader" }, new AbortController().signal);
    assert.equal(cleared, 0);
    assert.equal(requested, 0);
    assert.equal(failure, "checkpoint_source_reused");
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("early source storage failure stops the semantic stage and preserves the storage cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-source-failure-"));
  const project = createProject("guest:source", "https://github.com/example/repo", "Storage", null);
  const snapshot = buildSnapshot({ snapshotId: "saved-static", repository: "example/repo", commitSha: "a".repeat(40), files: [], sourceRoot: root });
  const batches = new Map<string, SemanticBatch>();
  let prepared = 0;
  const store = {
    root,
    kind: "postgres", loadProject: async () => project,
    loadAnalysisCheckpoint: async () => ({ checkpoint: { analyzer_bundle_version: ANALYZER_BUNDLE_VERSION, static_identity: ANALYSIS_CONFIG_DIGEST, stage: "semantic", source_root: root, snapshot_id: "saved-static", parsed: [], lsp_results: [],
      fetched: { owner: "example", repo: "repo", commitSha: snapshot.commit_sha, files: [], manifest: [], research: snapshot.research } }, snapshot }),
    loadPublicSnapshotMetadata: async () => null, loadPublicSnapshotView: async () => null, loadPublicSnapshot: async () => null, loadLatestPublicSnapshot: async () => null,
    heartbeatAnalysisJob: async () => true, saveAnalysisCheckpoint: async () => {},
    loadSemanticBatch: async (_job: string, id: string) => batches.get(id) ?? null,
    listSemanticBatches: async () => [...batches.values()],
    saveSemanticBatch: async (batch: SemanticBatch) => { batches.set(batch.batch_id, batch); },
    preparePublicSnapshotSource: async () => { prepared++; throw new Error("source_preparation_disk_full"); },
    updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
    finishAnalysisJob: async () => {},
  } as unknown as ProductStore;
  const coordinator = new AnalysisCoordinator(store, { ...config(1), dataDir: root,
    analysisProviderId: "deepseek", analysisProviderModel: "deepseek-v4-flash", analysisProviderApiKey: "test",
  }) as unknown as { processClaimedJob: (job: AnalysisJob, signal: AbortSignal) => Promise<void> };
  try {
    await coordinator.processClaimedJob({ ...job("storage-failure"), project_id: project.project_id }, new AbortController().signal);
    assert.equal(prepared, 1);
    assert.equal(project.analysis.error, "source_preparation_disk_full");
    assert.deepEqual([...batches.keys()], ["value-initial-search"], "no model batch may start after source preparation fails");
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("failed batch diagnostics survive retries in a bounded history without becoming cached results", async () => {
  let stored: SemanticBatch | null = null;
  const store = {
    loadSemanticBatch: async () => stored,
    saveSemanticBatch: async (row: SemanticBatch) => { stored = structuredClone(row); },
  } as unknown as ProductStore;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const currentJob = { ...job("diagnostic-retry"), attempt };
    const context = createSemanticBatchRecorder(store, currentJob, { jobId: currentJob.job_id, workerId: "test-worker", attempt });
    const batch = createSemanticBatch({ batch_id: "layer", job_id: currentJob.job_id, snapshot_id: "snapshot", phase: "architecture_layers", ordinal: 0, input: { attempt } }, attempt, null, null, new Date().toISOString());
    await context.recorder.start(batch);
    assert.equal((stored as SemanticBatch | null)?.output, null);
    const diagnostics = createWorkerDiagnostics({ jobId: currentJob.job_id, jobAttempt: attempt, batchId: "layer" });
    diagnostics.finish();
    const output = { value: null, diagnostics: diagnostics.data };
    await context.recorder.fail("layer", "provider_request_failed", "failed", output);
    assert.equal((stored as SemanticBatch | null)?.status, "failed");
    assert.deepEqual((stored as SemanticBatch | null)?.output, output);
  }
  const saved = stored as SemanticBatch | null;
  const runs = saved?.checkpoint.diagnostic_runs as Array<{ attempt: number; diagnostics: { identity: { jobAttempt: number } } }>;
  assert.equal(runs.length, 8);
  assert.deepEqual(runs.map((run) => run.attempt), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(runs.map((run) => run.diagnostics.identity.jobAttempt), runs.map((run) => run.attempt));
  assert.equal(saved?.checkpoint.dropped_diagnostic_runs, 1);
});
test('LSP reuse binds the complete workspace, retries incomplete runs and reacts to missing context', async () => {
  const files = ['main.py', 'types.pyi'].map(path => decodeSource(path, Buffer.from('def run(): pass')).file);
  let runs = 0;
  const coordinator = new AnalysisCoordinator({} as ProductStore, { ...config(1), dataDir: tmpdir() }) as unknown as {
    lspRunner: { analyze: (input: { workspaceFiles: ParsedFile[] }) => Promise<LspRunResult> };
    analyzeWithLsp: (files: ParsedFile[], root: string, cache: ReturnType<typeof createAnalysisCache> | null, plan: ReturnType<typeof buildFullPlan>) => Promise<LspRunResult[]>;
  };
  coordinator.lspRunner = { analyze: async input => {
    runs++;
    assert.ok(input.workspaceFiles.length);
    return { language: 'python', completed: true, toolchainVerified: false,
      serverName: 'fixture', serverVersion: '1', capabilities: [], reasonCodes: [], symbols: [], relations: [] };
  } };
  const plan = { ...buildFullPlan([]), mode: 'incremental' as const };
  const first = await coordinator.analyzeWithLsp(files, '/unused', null, plan);
  const cache = createAnalysisCache({ manifest: [], parsedFiles: files, lspResults: first });
  await coordinator.analyzeWithLsp(files, '/unused', cache, plan);
  assert.equal(runs, 1);
  await coordinator.analyzeWithLsp(files.slice(0, 1), '/unused', cache, plan);
  assert.equal(runs, 2, 'missing context requires a refresh even without a proven deletion');
  await coordinator.analyzeWithLsp([...files, decodeSource('build.gradle', Buffer.from('changed')).file], '/unused', cache, plan);
  assert.equal(runs, 3, 'a cross-language config participates in the workspace identity');
  await coordinator.analyzeWithLsp(files, '/unused', { ...cache, lsp_results: [{ ...first[0]!, completed: false }] }, plan);
  assert.equal(runs, 4, 'incomplete server runs are not reusable semantic caches');
});

test('deferred publication waits for cache persistence and never loads the graph after a cache failure', async () => {
  for (const failure of [null, 'cache', 'graph', 'cancel', 'identity', 'cancel-after-graph', 'cancel-before-publish'] as const) {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'analysis-deferred-order-'));
    try {
      const snapshot = buildSnapshot({ snapshotId: 'deferred-snapshot', repository: 'example/deferred',
        commitSha: 'a'.repeat(40), files: [], sourceRoot });
      const publicKey = canonicalPublicSnapshotKey(snapshot.repository, snapshot.commit_sha, 'analyzer', 'config');
      const checkpoint = { stage: 'assembly', source_root: sourceRoot, repository: snapshot.repository,
        commit_sha: snapshot.commit_sha, snapshot_id: snapshot.snapshot_id, public_key: publicKey,
        analysis_config_digest: 'config', analyzer_bundle_version: 'analyzer', fetched: { manifest: [] },
        parsed: [], syntax_files: [], lsp_results: [], plan: buildFullPlan([]), provenance_applied: false };
      const project = createProject('guest:deferred', 'https://github.com/example/deferred', 'Deferred', null);
      const events: string[] = [];
      const controller = new AbortController();
      const store = {
        preparePublicSnapshotAnalysisCache: async () => {
          events.push('cache-start');
          await new Promise<void>(resolve => setImmediate(resolve));
          if (failure === 'cache') throw new Error('test-cache-failure');
          if (failure === 'cancel') controller.abort(new Error('test-cancel'));
          events.push('cache-finished');
          return { publicKey, snapshotId: snapshot.snapshot_id, payload: { value: {}, envelope: null, chunks: [] } };
        },
        savePublicSnapshot: async () => { events.push('publish'); },
        saveSnapshotLanguageOverlay: async () => {}, loadProject: async () => project,
        updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => {
          mutate(project);
          if (failure === 'cancel-before-publish' && project.analysis.progress_events?.some(
            event => event.kind === 'publishing_analysis' && event.status === 'running')) {
            controller.abort(new Error('test-cancel-before-publish'));
          }
        },
        finishAnalysisJob: async () => {}, saveTrace: async () => {},
        clearAnalysisCheckpoint: async () => { events.push('clear'); },
      } as unknown as ProductStore;
      const coordinator = new AnalysisCoordinator(store, config(1)) as unknown as {
        resumeAssemblyFromCheckpoint(input: Record<string, unknown>): Promise<void>;
      };
      const run = coordinator.resumeAssemblyFromCheckpoint({ checkpoint, project, job: job('deferred'),
        signal: controller.signal, fence: {}, loadPublication: async () => {
          assert.deepEqual(events, ['cache-start', 'cache-finished']);
          assert.equal(Object.hasOwn(checkpoint, 'parsed'), false);
          events.push('graph');
          if (failure === 'graph') throw new Error('test-graph-failure');
          if (failure === 'cancel-after-graph') controller.abort(new Error('test-cancel-after-graph'));
          if (failure === 'identity') return { snapshot: { ...snapshot, snapshot_id: 'wrong-snapshot' }, previousFactGraph: null };
          return { snapshot, previousFactGraph: null };
        } });
      if (failure) {
        await assert.rejects(run, failure === 'identity' ? /analysis_checkpoint_identity_mismatch/ : new RegExp('test-' + failure));
        assert.equal(events.includes('publish'), false); assert.equal(events.includes('clear'), false);
        if (!['graph', 'identity', 'cancel-after-graph', 'cancel-before-publish'].includes(failure)) assert.equal(events.includes('graph'), false);
      } else { await run; assert.deepEqual(events, ['cache-start', 'cache-finished', 'graph', 'publish', 'clear']); }
    } finally { await rm(sourceRoot, { recursive: true, force: true }); }
  }
});

test('incremental assembly reloads prior facts through the saved public key', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'analysis-incremental-assembly-'));
  let checkpointStore: FileStore | undefined;
  try {
    const oldFile = decodeSource('src/a.py', Buffer.from('def run(): pass\n')).file;
    const currentFile = decodeSource('src/a.py', Buffer.from('def run(): pass\n')).file;
    const manifest = [{ path: currentFile.path, bytes: currentFile.bytes, digest: currentFile.digest }];
    const previous = buildSnapshot({ snapshotId: 'old-snapshot', repository: 'example/incremental',
      commitSha: 'a'.repeat(40), files: [oldFile], sourceRoot });
    const snapshot = buildSnapshot({ snapshotId: 'new-snapshot', repository: 'example/incremental',
      commitSha: 'b'.repeat(40), files: [currentFile], sourceRoot });
    const plan = buildIncrementalPlan({ parentSnapshotId: previous.snapshot_id,
      previousCache: createAnalysisCache({ manifest, parsedFiles: [oldFile], lspResults: [] }),
      previousFactGraph: previous.fact_graph, currentManifest: manifest });
    const previousKey = canonicalPublicSnapshotKey(snapshot.repository, previous.commit_sha, 'analyzer', 'config');
    const publicKey = canonicalPublicSnapshotKey(snapshot.repository, snapshot.commit_sha, 'analyzer', 'config');
    const checkpoint = { stage: 'assembly', source_root: sourceRoot, repository: snapshot.repository,
      commit_sha: snapshot.commit_sha, snapshot_id: snapshot.snapshot_id, public_key: publicKey,
      from_public_key: previousKey, analysis_config_digest: 'config', analyzer_bundle_version: 'analyzer',
      fetched: { manifest }, parsed: [currentFile], syntax_files: [currentFile], lsp_results: [],
      plan, provenance_applied: false,
      fact_identity: { nodes: snapshot.fact_graph.nodes.map(row => row.id),
        edges: snapshot.fact_graph.edges.map(row => row.id) } };
    checkpointStore = new FileStore(join(sourceRoot, 'checkpoint-storage'));
    await checkpointStore.init();
    await checkpointStore.saveAnalysisCheckpoint('incremental-assembly', checkpoint, snapshot);
    const deferred = await checkpointStore.loadAnalysisCheckpoint<typeof checkpoint>(
      'incremental-assembly', { deferPublication: true });
    assert.ok(deferred?.loadPublication);
    assert.equal(deferred.checkpoint.from_public_key, previousKey);
    const project = createProject('guest:incremental', 'https://github.com/example/incremental', 'Incremental', null);
    let visited = 0;
    let published: Record<string, unknown> | null = null;
    const store = {
      preparePublicSnapshotAnalysisCache: async () => ({ publicKey, snapshotId: snapshot.snapshot_id,
        payload: { value: {}, envelope: null, chunks: [] } }),
      visitPublicSnapshotFactLineage: async () => false,
      visitPublicSnapshotFactGraph: async (key: string, visitor: { node: (row: unknown) => void; edge: (row: unknown) => void }) => {
        assert.equal(key, previousKey);
        for (const node of previous.fact_graph.nodes) { visitor.node(node); visited++; }
        for (const edge of previous.fact_graph.edges) { visitor.edge(edge); visited++; }
      },
      savePublicSnapshot: async (input: { analysis: Record<string, unknown> }) => { published = input.analysis; },
      saveSnapshotLanguageOverlay: async () => {}, loadProject: async () => project,
      updateProject: async (_id: string, _owner: string, mutate: (row: typeof project) => void) => { mutate(project); },
      finishAnalysisJob: async () => {}, saveTrace: async () => {}, clearAnalysisCheckpoint: async () => {},
    } as unknown as ProductStore;
    const coordinator = new AnalysisCoordinator(store, config(1)) as unknown as {
      resumeAssemblyFromCheckpoint(input: Record<string, unknown>): Promise<void>;
    };
    const mismatched = { ...deferred.checkpoint,
      fact_identity: { ...checkpoint.fact_identity,
        nodes: ['not-the-current-graph', ...checkpoint.fact_identity.nodes.slice(1)] } };
    await assert.rejects(coordinator.resumeAssemblyFromCheckpoint({ checkpoint: mismatched, project,
      job: job('incremental-assembly'), signal: new AbortController().signal, fence: {},
      loadPublication: deferred.loadPublication }), /analysis_checkpoint_fact_identity_mismatch/);
    visited = 0;
    await coordinator.resumeAssemblyFromCheckpoint({ checkpoint: deferred.checkpoint, project,
      job: job('incremental-assembly'), signal: new AbortController().signal, fence: {},
      loadPublication: async () => {
        assert.ok(visited > 0, 'historical facts must be visited before loading the current graph');
        return deferred.loadPublication!();
      } });
    assert.ok(visited > 0);
    assert.equal((published as Record<string, unknown> | null)?.incremental !== undefined, true);
  } finally {
    await checkpointStore?.close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
