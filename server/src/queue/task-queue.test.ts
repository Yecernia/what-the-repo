import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskQueue,
  taskQueueJobOptions,
  taskQueueJobId,
  taskQueueWorkerOptions,
  TASK_QUEUE_BACKOFF_MS,
  TASK_QUEUE_DELIVERY_ATTEMPTS,
  TASK_QUEUE_MAX_STALLED_COUNT,
  TASK_QUEUE_STALLED_INTERVAL_MS,
  queueDepthSnapshot,
} from "./task-queue.js";

test("task queue stays a no-op in local mode without Redis", async () => {
  const queue = createTaskQueue({ redisUrl: null });
  assert.equal(queue.kind, "disabled");
  await queue.enqueueEvolution("request-1");
  await queue.startAnalysisConsumer(async () => undefined);
  await queue.refreshMetrics?.();
  await queue.close();
});

test("queue depth normalization reports bounded counts and oldest wait", () => {
  assert.deepEqual(queueDepthSnapshot({
    waiting: 3.8,
    active: -2,
    delayed: Number.NaN,
    failed: 4,
    oldestTimestampMs: 8_500,
  }, 10_000), {
    waiting: 3,
    active: 0,
    delayed: 0,
    failed: 4,
    oldestAgeMs: 1_500,
  });
  assert.equal(queueDepthSnapshot({ oldestTimestampMs: 20_000 }, 10_000).oldestAgeMs, 0);
});

test("BullMQ delivery policy is bounded separately from PostgreSQL job attempts", () => {
  const options = taskQueueJobOptions("analysis", "job-1");
  assert.equal(options.jobId, taskQueueJobId("analysis", "job-1"));
  assert.match(String(options.jobId), /^wtr-[A-Za-z0-9_-]+$/);
  assert.notEqual(taskQueueJobId("analysis", "job-1"), taskQueueJobId("analysis-overlay", "job-1"));
  assert.equal(options.attempts, TASK_QUEUE_DELIVERY_ATTEMPTS);
  assert.deepEqual(options.backoff, { type: "exponential", delay: TASK_QUEUE_BACKOFF_MS });
  const worker = taskQueueWorkerOptions(99);
  assert.equal(worker.concurrency, 16);
  assert.equal(worker.stalledInterval, TASK_QUEUE_STALLED_INTERVAL_MS);
  assert.equal(worker.maxStalledCount, TASK_QUEUE_MAX_STALLED_COUNT);
  assert.equal(worker.lockDuration, TASK_QUEUE_STALLED_INTERVAL_MS * 2);
});
