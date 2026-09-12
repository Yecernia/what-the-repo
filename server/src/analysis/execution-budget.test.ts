import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runStructuredWorker } from "../agent/structured-worker.js";
import { ProviderBudgetExceededError } from "../agent/provider-budget.js";
import { WorkerExecutionError } from "../agent/worker-failure.js";
import { createSemanticBatch, type SemanticBatch } from "../domain/semantic-batch.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { ProductStore } from "../persistence/store.js";
import { createAnalysisExecutionBudget } from "./execution-budget.js";
import { runRecordedSemanticBatch } from "./semantic-batch-runner.js";
import { createSemanticBatchRecorder, enrichSnapshotSafely, semanticTerminalFailureCode, isRetryableAnalysisError } from "./coordinator.js";
import { buildSnapshot } from "./graph.js";

function fixture() {
  const saved = new Map<string, SemanticBatch>();
  const fence = { jobId: "budget-job", workerId: "worker", attempt: 1 };
  const job = { job_id: fence.jobId, attempt: fence.attempt, lease_expires_at: new Date().toISOString() } as AnalysisJob;
  const store = {
    listSemanticBatches: async () => [...saved.values()].map(row => structuredClone(row)),
    loadSemanticBatch: async (_job: string, batch: string) => structuredClone(saved.get(batch) ?? null),
    saveSemanticBatch: async (batch: SemanticBatch) => { saved.set(batch.batch_id, structuredClone(batch)); },
  };
  const descriptor = (id: string) => ({ job_id: fence.jobId, batch_id: id, snapshot_id: "snapshot", phase: "architecture_components" as const, ordinal: 0, input: { id } });
  const identity = (id: string) => ({ jobId: fence.jobId, jobAttempt: fence.attempt, batchId: id });
  const start = (id: string) => store.saveSemanticBatch(createSemanticBatch(descriptor(id), 1, fence.workerId, null, new Date().toISOString()));
  const context = createSemanticBatchRecorder(store as unknown as ProductStore, job, fence);
  return { saved, store, fence, job, descriptor, identity, start, context };
}

function worker(provider: string) {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, options: {
    skillId: "understanding-assessment" as const,
    inputSchemaId: "understanding-assessment-input-v1", outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v2", schema: Type.Object({ answer: Type.String() }),
    systemPrompt: "Submit the result", userPrompt: "Explain",
    modelRuntime: { models, model: faux.getModel() as Model<Api> },
  } };
}

test("concurrent batches share a persisted job limit and retry does not reset it", async () => {
  const f = fixture();
  await f.start("a"); await f.start("b");
  const settings = { store: f.store, fence: f.fence, signal: new AbortController().signal, limits: { batchCalls: 3, jobCalls: 3, attemptMs: 10_000 } };
  const budget = await createAnalysisExecutionBudget(settings);
  try {
    const attempts = await Promise.allSettled(["a", "b", "a", "b"].map(id => budget.beforeRequest(f.identity(id))));
    assert.equal(attempts.filter(row => row.status === "fulfilled").length, 3);
    assert.equal(f.saved.get("a")?.checkpoint.execution_requests, 2);
    assert.equal(f.saved.get("b")?.checkpoint.execution_requests, 1);
    assert.equal((budget.signal.reason as Error).message, "analysis_job_call_limit_exceeded");
  } finally { budget.dispose(); }
  const resumed = await createAnalysisExecutionBudget(settings);
  try { await assert.rejects(resumed.beforeRequest(f.identity("b")), /analysis_job_call_limit_exceeded/); }
  finally { resumed.dispose(); }
});

test("SDK rejected submissions exhaust the batch limit, retain diagnostics, and never dispatch the denied call", async () => {
  const f = fixture();
  const w = worker("budget-invalid-submit");
  w.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage(fauxToolCall("submit_result", { wrong: "private-detail" }))));
  const budget = await createAnalysisExecutionBudget({ store: f.store, fence: f.fence, signal: new AbortController().signal, limits: { batchCalls: 2, jobCalls: 10, attemptMs: 10_000 } });
  try {
    await assert.rejects(runRecordedSemanticBatch({ descriptor: f.descriptor("a"), context: f.context,
      run: () => runStructuredWorker({ ...w.options, signal: budget.signal, diagnosticIdentity: f.identity("a"),
        modelRuntime: { ...w.options.modelRuntime, beforeWorkerRequest: budget.beforeRequest } }),
    }), /analysis_batch_call_limit_exceeded/);
    const batch = f.saved.get("a")!;
    const output = batch.output as { stopReason: string; diagnostics: { requestCount: number; toolDispatchErrorCount: number } };
    assert.equal(batch.status, "failed");
    assert.equal(batch.checkpoint.execution_requests, 2);
    assert.equal(output.stopReason, "analysis_batch_call_limit_exceeded");
    assert.equal(output.diagnostics.requestCount, 2);
    assert.equal(output.diagnostics.toolDispatchErrorCount, 2);
    assert.equal(w.faux.getPendingResponseCount(), 1);
    assert.doesNotMatch(JSON.stringify(output), /private-detail/);
    assert.equal(semanticTerminalFailureCode(`semantic_${output.stopReason}`), output.stopReason);
    assert.equal(isRetryableAnalysisError(output.stopReason), false);
  } finally { budget.dispose(); }
});

test("finished batch replay does not reserve another call even when the job limit is already spent", async () => {
  const f = fixture();
  await f.start("a");
  const budget = await createAnalysisExecutionBudget({ store: f.store, fence: f.fence, signal: new AbortController().signal, limits: { batchCalls: 1, jobCalls: 1, attemptMs: 10_000 } });
  try {
    await budget.beforeRequest(f.identity("a"));
    const output = { value: { answer: "Complete" }, skillVersion: "1", stopReason: "completed" };
    await f.context.recorder.complete("a", output, "output-digest");
    const replay = await runRecordedSemanticBatch({ descriptor: f.descriptor("a"), context: f.context, run: async () => {
      await budget.beforeRequest(f.identity("a")); assert.fail("must replay instead of calling provider");
    } });
    assert.deepEqual(replay, output);
    assert.equal(f.saved.get("a")?.checkpoint.execution_requests, 1);
  } finally { budget.dispose(); }
});

test("checkpoint write failure prevents dispatch and is a local error, not a provider outage", async () => {
  const f = fixture(); const w = worker("budget-store-error");
  w.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", { answer: "unused" }))]);
  await f.start("a");
  const store = { ...f.store, saveSemanticBatch: async () => { throw new Error("database-private-detail"); } };
  const budget = await createAnalysisExecutionBudget({ store, fence: f.fence, signal: new AbortController().signal });
  try {
    const result = await runStructuredWorker({ ...w.options, signal: budget.signal, diagnosticIdentity: f.identity("a"), modelRuntime: { ...w.options.modelRuntime, beforeWorkerRequest: budget.beforeRequest } });
    assert.equal(result.stopReason, "worker_internal_error");
    assert.equal(result.diagnostics?.requestCount, 0);
    assert.equal(w.faux.getPendingResponseCount(), 1);
    assert.doesNotMatch(JSON.stringify(result), /database-private-detail/);
  } finally { budget.dispose(); }
});

test("user cancellation while reserving a call remains cancellation and does not dispatch a model", async () => {
  const f = fixture(); const w = worker("budget-user-cancel");
  await f.start("a");
  const parent = new AbortController();
  const store = { ...f.store, saveSemanticBatch: async (row: SemanticBatch) => {
    parent.abort(new Error("analysis_worker_shutdown"));
    await f.store.saveSemanticBatch(row);
  } };
  const budget = await createAnalysisExecutionBudget({ store, fence: f.fence, signal: parent.signal });
  try {
    const result = await runStructuredWorker({ ...w.options, signal: budget.signal, diagnosticIdentity: f.identity("a"), modelRuntime: { ...w.options.modelRuntime, beforeWorkerRequest: budget.beforeRequest } });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.diagnostics?.requestCount, 0);
    assert.equal(w.faux.state.callCount, 0);
  } finally { budget.dispose(); }
});

test("deadline interrupts an in-flight provider and remains a time limit instead of user cancellation", async () => {
  const f = fixture(); const w = worker("budget-deadline");
  await f.start("a");
  const budget = await createAnalysisExecutionBudget({ store: f.store, fence: f.fence, signal: new AbortController().signal, limits: { batchCalls: 2, jobCalls: 3, attemptMs: 100 } });
  w.faux.setResponses([async () => {
    await delay(2_000, undefined, { signal: budget.signal }).catch(() => {});
    return fauxAssistantMessage("aborted", { stopReason: "aborted" });
  }]);
  try {
    const result = await runStructuredWorker({ ...w.options, signal: budget.signal, diagnosticIdentity: f.identity("a"), modelRuntime: { ...w.options.modelRuntime, beforeWorkerRequest: budget.beforeRequest } });
    assert.equal(result.stopReason, "analysis_time_limit_exceeded");
    assert.equal(result.value, null);
    assert.ok(result.diagnostics!.durationMs < 1_000);
  } finally { budget.dispose(); }
});

test("submit validator bugs and shared spending rejection have distinct stable failure reasons", async () => {
  const w = worker("budget-error-attribution");
  w.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", { answer: "answer" }))]);
  const invalid = await runStructuredWorker({ ...w.options, validateSubmitted: () => { throw new Error("validator-private-detail"); } });
  assert.equal(invalid.stopReason, "worker_internal_error");
  assert.equal(invalid.diagnostics?.requestCount, 1);
  assert.equal(invalid.diagnostics?.submitAttempts, 1);
  assert.deepEqual(invalid.diagnostics?.submissions[0]?.errorCategories, ["worker_internal_error"]);
  assert.doesNotMatch(JSON.stringify(invalid), /validator-private-detail/);
  const limited = await runStructuredWorker({ ...w.options, modelRuntime: { ...w.options.modelRuntime, ownerId: "owner",
    providerBudget: { acquire: async () => { throw new ProviderBudgetExceededError("cost_per_day", 1); } } } });
  assert.equal(limited.stopReason, "provider_budget_exceeded");
  assert.equal(limited.diagnostics?.requests[0]?.requestStartedAt, null);
});

test("unexpected semantic errors preserve static facts but cannot be mistaken for a successful degraded result", async () => {
  const snapshot = buildSnapshot({ snapshotId: "s", repository: "example/repo", commitSha: "a".repeat(40), files: [], sourceRoot: "" });
  const w = worker("semantic-internal-error");
  for (const error of [new Error("a database error with a misleading rate field"), new WorkerExecutionError("analysis_job_call_limit_exceeded")]) {
    const result = await enrichSnapshotSafely(snapshot, w.options.modelRuntime, undefined, async () => { throw error; });
    assert.equal(result.snapshot, snapshot);
    assert.equal(semanticTerminalFailureCode(result.stopReason), error instanceof WorkerExecutionError ? error.code : "worker_internal_error");
    assert.equal(isRetryableAnalysisError(result.stopReason), false);
  }
});
