import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newAnalysisJob } from "../domain/jobs.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import { FileStore } from "./file-store.js";

function batch(jobId: string, batchId: string, status: SemanticBatch["status"] = "running"): SemanticBatch {
  const timestamp = new Date().toISOString();
  return {
    batch_id: batchId,
    job_id: jobId,
    snapshot_id: "snap:test",
    phase: "architecture_components",
    ordinal: Number(batchId.replace(/\D/g, "")) || 0,
    input_digest: "input",
    output_digest: status === "succeeded" ? "output" : null,
    status,
    attempt: 1,
    lease_owner: "worker",
    lease_expires_at: timestamp,
    checkpoint: { offset: 1 },
    output: status === "succeeded" ? { ok: true } : null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: status === "succeeded" ? timestamp : null,
  };
}

test("FileStore persists, orders, and cancels semantic batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-semantic-batches-"));
  const store = new FileStore(root);
  await store.init();
  try {
    const job = newAnalysisJob("project:test", "batch-test");
    await store.saveJob(job);
    await store.saveSemanticBatch(batch(job.job_id, "batch-2"));
    await store.saveSemanticBatch(batch(job.job_id, "batch-1", "succeeded"));
    assert.deepEqual((await store.listSemanticBatches(job.job_id)).map((row) => row.batch_id), ["batch-1", "batch-2"]);
    assert.deepEqual((await store.loadSemanticBatch(job.job_id, "batch-1"))?.output, { ok: true });
    await store.cancelSemanticBatches(job.job_id, "analysis_cancelled");
    assert.equal((await store.loadSemanticBatch(job.job_id, "batch-1"))?.status, "succeeded");
    assert.equal((await store.loadSemanticBatch(job.job_id, "batch-2"))?.status, "cancelled");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
