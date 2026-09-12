import type { SkillCandidate } from "./contracts.js";
import {
  promoteFeedbackRequests,
  type FeedbackQueuePromotionOptions,
  type FeedbackQueuePromotionResult,
} from "./feedback-queue.js";
import { PiEvolutionRunner } from "./runner.js";
import { createReviewDecision } from "./review.js";
import { EvolutionTaskQueueConsumer } from "./task-queue.js";

export interface FeedbackEvolutionWorkerOptions extends FeedbackQueuePromotionOptions {
  runner: PiEvolutionRunner;
  intervalMs?: number;
  taskLimit?: number;
  redisUrl?: string | null;
  redisPrefix?: string;
}

export interface FeedbackEvolutionBatchResult {
  promoted: FeedbackQueuePromotionResult[];
  candidates: SkillCandidate[];
  failedTaskIds: string[];
}

/** A single global worker; it is never created per end user or exposed to chat. */
export class FeedbackEvolutionWorker {
  private running = false;
  private batchTail: Promise<void> = Promise.resolve();
  private queueConsumer: EvolutionTaskQueueConsumer | null = null;

  constructor(private readonly options: FeedbackEvolutionWorkerOptions) {
    if (options.state !== options.runner.stateStore) {
      // Object identity is not required because production composition may
      // reopen the same durable root for inspection.
      if (options.state.root !== options.runner.stateStore.root) {
        throw new Error("feedback worker and Pi runner must share one evolution state root");
      }
    }
  }

  runOnce(requestIds?: string[]): Promise<FeedbackEvolutionBatchResult> {
    const run = this.batchTail.then(() => this.runBatch(requestIds));
    this.batchTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runBatch(requestIds?: string[]): Promise<FeedbackEvolutionBatchResult> {
    const promoted = await promoteFeedbackRequests(this.options, requestIds);
    const candidates: SkillCandidate[] = [];
    const failedTaskIds: string[] = [];
    const taskIds = (requestIds
      ? [...new Set(promoted.flatMap((item) => item.taskIds))]
      : await this.options.state.listTaskIds("created"))
      .slice(0, this.options.taskLimit ?? 4);
    for (const taskId of taskIds) {
      try {
        if ((await this.options.state.loadLedger(taskId)).status !== "created") continue;
        const task = await this.options.state.loadTask(taskId);
        candidates.push((await this.options.runner.run(task)).candidate);
      } catch {
        failedTaskIds.push(taskId);
      }
    }
    return { promoted, candidates, failedTaskIds };
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("feedback evolution worker is already running");
    this.running = true;
    const intervalMs = Math.max(1_000, this.options.intervalMs ?? 30_000);
    if (this.options.redisUrl) {
      this.queueConsumer = new EvolutionTaskQueueConsumer(
        this.options.redisUrl,
        this.options.redisPrefix ?? "what-the-repo",
        async (envelope) => { await this.runOnce(envelope.request_id ? [envelope.request_id] : undefined); },
      );
    }
    try {
      while (!signal.aborted) {
        await this.runOnce();
        await wait(intervalMs, signal);
      }
    } finally {
      await this.queueConsumer?.close().catch(() => undefined);
      this.queueConsumer = null;
      await this.batchTail;
      this.running = false;
    }
  }

  async review(input: {
    taskId: string;
    reviewerId: string;
    decision: "approve" | "reject";
    reason?: string;
  }): Promise<SkillCandidate> {
    const review = await createReviewDecision({ state: this.options.state, ...input });
    return input.decision === "approve"
      ? this.options.runner.approve(input.taskId, review)
      : this.options.runner.reject(input.taskId, review);
  }
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
