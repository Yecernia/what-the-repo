import assert from "node:assert/strict";
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
import { createSemanticBatch, type SemanticBatch } from "../domain/semantic-batch.js";
import { createWorkerDiagnostics } from "../agent/worker-diagnostics.js";
import { mkdtemp, rm } from "node:fs/promises";
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
    const store = { savePublicSnapshot: async (input: typeof saved[number]) => { saved.push(input); },
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
  return { analysisQueueConcurrency: concurrency } as ServerConfig;
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
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const store = {
    claimAnalysisJob: async () => {
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
  assert.equal(claims, 4);
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

test("early source storage failure stops the semantic stage and preserves the storage cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-source-failure-"));
  const project = createProject("guest:source", "https://github.com/example/repo", "Storage", null);
  const snapshot = buildSnapshot({ snapshotId: "saved-static", repository: "example/repo", commitSha: "a".repeat(40), files: [], sourceRoot: root });
  const batches = new Map<string, SemanticBatch>();
  let prepared = 0;
  const store = {
    root,
    kind: "postgres", loadProject: async () => project,
    loadAnalysisCheckpoint: async () => ({ checkpoint: { stage: "semantic", source_root: root, snapshot_id: "saved-static", parsed: [], lsp_results: [],
      fetched: { owner: "example", repo: "repo", commitSha: snapshot.commit_sha, files: [], manifest: [], research: snapshot.research } }, snapshot }),
    loadPublicSnapshotMetadata: async () => null, loadPublicSnapshot: async () => null, loadLatestPublicSnapshot: async () => null,
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
