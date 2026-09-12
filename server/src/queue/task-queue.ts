import { Queue, Worker, type Job, type JobsOptions, type WorkerOptions } from "bullmq";
import type { AnalysisJob } from "../domain/jobs.js";
import { defaultRuntimeMetrics, METRIC_NAMES, type RuntimeMetrics } from "../observability/metrics.js";

export type TaskQueueName = "analysis" | "analysis-overlay" | "evolution";

export interface TaskQueueEnvelope {
  job_id: string;
  project_id?: string;
  execution_role?: string;
  idempotency_key?: string;
  request_id?: string;
}

export interface TaskQueue {
  readonly kind: "bullmq" | "disabled";
  enqueueAnalysis(job: AnalysisJob): Promise<void>;
  enqueueEvolution(requestId: string): Promise<void>;
  startAnalysisConsumer(onWake: (envelope: TaskQueueEnvelope) => Promise<void>): Promise<void>;
  /** Refresh process metrics from the backing queue, when one exists. */
  refreshMetrics?(): Promise<void>;
  close(): Promise<void>;
}

export interface QueueDepthSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  oldestAgeMs: number;
}

function nonNegativeCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

/** Pure normalization keeps queue observability testable without Redis. */
export function queueDepthSnapshot(input: {
  waiting?: number;
  active?: number;
  delayed?: number;
  failed?: number;
  oldestTimestampMs?: number | null;
}, nowMs = Date.now()): QueueDepthSnapshot {
  const oldest = input.oldestTimestampMs;
  return {
    waiting: nonNegativeCount(input.waiting),
    active: nonNegativeCount(input.active),
    delayed: nonNegativeCount(input.delayed),
    failed: nonNegativeCount(input.failed),
    oldestAgeMs: typeof oldest === "number" && Number.isFinite(oldest)
      ? Math.max(0, nowMs - oldest)
      : 0,
  };
}

export const TASK_QUEUE_DELIVERY_ATTEMPTS = 3;
export const TASK_QUEUE_BACKOFF_MS = 5_000;
export const TASK_QUEUE_STALLED_INTERVAL_MS = 30_000;
export const TASK_QUEUE_MAX_STALLED_COUNT = 2;

export function taskQueueJobId(queue: TaskQueueName, jobId: string): string {
  const encoded = Buffer.from(`${queue}\0${jobId}`, "utf8").toString("base64url");
  return `wtr-${encoded}`;
}

export function taskQueueJobOptions(queue: TaskQueueName, jobId: string): JobsOptions {
  return {
    attempts: TASK_QUEUE_DELIVERY_ATTEMPTS,
    backoff: { type: "exponential", delay: TASK_QUEUE_BACKOFF_MS },
    removeOnComplete: { age: 60 * 60, count: 2_000 },
    removeOnFail: { age: 24 * 60 * 60, count: 2_000 },
    jobId: taskQueueJobId(queue, jobId),
  };
}

export function taskQueueWorkerOptions(concurrency: number): WorkerOptions {
  return {
    connection: { url: "", maxRetriesPerRequest: null },
    concurrency: Math.max(1, Math.min(16, concurrency)),
    stalledInterval: TASK_QUEUE_STALLED_INTERVAL_MS,
    maxStalledCount: TASK_QUEUE_MAX_STALLED_COUNT,
    lockDuration: TASK_QUEUE_STALLED_INTERVAL_MS * 2,
    autorun: true,
  };
}

export class DisabledTaskQueue implements TaskQueue {
  readonly kind = "disabled" as const;
  async enqueueAnalysis(_job: AnalysisJob): Promise<void> {}
  async enqueueEvolution(_requestId: string): Promise<void> {}
  async startAnalysisConsumer(_onWake: (envelope: TaskQueueEnvelope) => Promise<void>): Promise<void> {}
  async refreshMetrics(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Redis is only the delivery/wakeup layer. PostgreSQL remains authoritative
 * for the job row, lease, attempt and final result, so a lost Redis message
 * can be repaired by a scheduler or a recovery claim.
 */
export class BullMqTaskQueue implements TaskQueue {
  readonly kind = "bullmq" as const;
  private readonly connection: { url: string; maxRetriesPerRequest: null };
  private readonly queues: Record<TaskQueueName, Queue<TaskQueueEnvelope>>;
  private readonly workers: Worker<TaskQueueEnvelope>[] = [];
  private started = false;

  constructor(
    redisUrl: string,
    private readonly prefix = "what-the-repo",
    private readonly concurrency = 1,
    private readonly metrics: RuntimeMetrics = defaultRuntimeMetrics,
  ) {
    this.connection = { url: redisUrl, maxRetriesPerRequest: null };
    const options = { connection: this.connection, prefix };
    this.queues = {
      analysis: new Queue("analysis", options),
      "analysis-overlay": new Queue("analysis-overlay", options),
      evolution: new Queue("evolution", options),
    };
  }

  async enqueueAnalysis(job: AnalysisJob): Promise<void> {
    const name: TaskQueueName = job.execution_role === "overlay" ? "analysis-overlay" : "analysis";
    const queue = this.queues[name];
    await queue.add(
      job.execution_role === "overlay" ? "overlay" : "analysis",
      {
        job_id: job.job_id,
        project_id: job.project_id,
        execution_role: job.execution_role,
        idempotency_key: job.idempotency_key,
      },
      taskQueueJobOptions(name, job.job_id),
    );
    this.metrics.increment(METRIC_NAMES.queueEnqueues, 1, { queue: name });
    await this.refreshMetrics();
  }

  async enqueueEvolution(requestId: string): Promise<void> {
    await this.queues.evolution.add(
      "feedback",
      { job_id: `evolution:${requestId}`, request_id: requestId },
      taskQueueJobOptions("evolution", requestId),
    );
    this.metrics.increment(METRIC_NAMES.queueEnqueues, 1, { queue: "evolution" });
    await this.refreshMetrics();
  }

  async startAnalysisConsumer(onWake: (envelope: TaskQueueEnvelope) => Promise<void>): Promise<void> {
    if (this.started) return;
    this.started = true;
    const options: WorkerOptions = {
      ...taskQueueWorkerOptions(this.concurrency),
      connection: this.connection,
      prefix: this.prefix,
    };
    for (const name of ["analysis", "analysis-overlay"] as const) {
      const worker = new Worker<TaskQueueEnvelope>(
        name,
        async (job: Job<TaskQueueEnvelope>) => {
          this.metrics.increment(METRIC_NAMES.queueDeliveries, 1, { queue: name, outcome: "started" });
          try {
            await onWake(job.data);
            this.metrics.increment(METRIC_NAMES.queueDeliveries, 1, { queue: name, outcome: "success" });
          } catch (error) {
            this.metrics.increment(METRIC_NAMES.queueDeliveries, 1, { queue: name, outcome: "error" });
            throw error;
          }
          return { woken: true };
        },
        options,
      );
      worker.on("error", () => undefined);
      this.workers.push(worker);
    }
    await this.refreshMetrics();
  }

  async refreshMetrics(): Promise<void> {
    await Promise.all((Object.entries(this.queues) as Array<[TaskQueueName, Queue<TaskQueueEnvelope>]>).map(async ([name, queue]) => {
      try {
        const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
        const jobs = await queue.getJobs(["waiting", "delayed"], 0, 99, true);
        const oldestTimestampMs = jobs.reduce<number | null>((oldest, job) => {
          const timestamp = typeof job.timestamp === "number" && Number.isFinite(job.timestamp)
            ? job.timestamp
            : null;
          if (timestamp === null) return oldest;
          return oldest === null ? timestamp : Math.min(oldest, timestamp);
        }, null);
        const snapshot = queueDepthSnapshot({
          waiting: counts.waiting,
          active: counts.active,
          delayed: counts.delayed,
          failed: counts.failed,
          oldestTimestampMs,
        });
        const labels = { queue: name };
        this.metrics.setGauge(METRIC_NAMES.queueWaiting, snapshot.waiting, labels);
        this.metrics.setGauge(METRIC_NAMES.queueActive, snapshot.active, labels);
        this.metrics.setGauge(METRIC_NAMES.queueDelayed, snapshot.delayed, labels);
        this.metrics.setGauge(METRIC_NAMES.queueFailed, snapshot.failed, labels);
        this.metrics.setGauge(METRIC_NAMES.queueOldestAge, snapshot.oldestAgeMs, labels);
      } catch {
        // Metrics must never take down a worker when Redis is restarting.
        this.metrics.increment(METRIC_NAMES.queueMetricErrors, 1, { queue: name });
      }
    }));
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
    this.workers.length = 0;
    this.started = false;
  }
}

export function createTaskQueue(input: {
  redisUrl?: string | null;
  prefix?: string;
  concurrency?: number;
  metrics?: RuntimeMetrics;
}): TaskQueue {
  return input.redisUrl
    ? new BullMqTaskQueue(input.redisUrl, input.prefix, input.concurrency, input.metrics)
    : new DisabledTaskQueue();
}
