import { Worker, type Job } from "bullmq";

export interface EvolutionQueueEnvelope {
  job_id: string;
  request_id?: string;
}

const QUEUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,255}$/;

export function validateEvolutionQueueEnvelope(value: unknown): EvolutionQueueEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid evolution queue envelope");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.job_id !== "string" || !QUEUE_ID.test(row.job_id)) {
    throw new Error("invalid evolution queue job ID");
  }
  if (row.request_id !== undefined
    && (typeof row.request_id !== "string" || !QUEUE_ID.test(row.request_id))) {
    throw new Error("invalid evolution queue request ID");
  }
  if (typeof row.request_id === "string" && row.job_id !== `evolution:${row.request_id}`) {
    throw new Error("evolution queue envelope IDs do not match");
  }
  return { job_id: row.job_id, ...(typeof row.request_id === "string" ? { request_id: row.request_id } : {}) };
}

/** Consume the shared Redis/BullMQ evolution lane without owning product data. */
export class EvolutionTaskQueueConsumer {
  private readonly worker: Worker<EvolutionQueueEnvelope>;

  constructor(
    redisUrl: string,
    prefix: string,
    onTask: (envelope: EvolutionQueueEnvelope) => Promise<void>,
  ) {
    this.worker = new Worker<EvolutionQueueEnvelope>(
      "evolution",
      async (job: Job<EvolutionQueueEnvelope>) => {
        await onTask(validateEvolutionQueueEnvelope(job.data));
        return { handled: true };
      },
      {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
        prefix,
        concurrency: 1,
        stalledInterval: 30_000,
        maxStalledCount: 2,
        lockDuration: 60_000,
      },
    );
    this.worker.on("error", () => undefined);
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
