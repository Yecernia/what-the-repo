import { KeyedMutex } from "../agent/mutex.js";
import { DEFAULT_WORKER_MAX_REQUESTS, WorkerExecutionError } from "../agent/worker-failure.js";
import type { PiModelRuntime } from "../agent/types.js";
import type { WorkerDiagnostics } from "../agent/worker-diagnostics.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import { AnalysisLeaseLostError, type AnalysisLeaseFence, type ProductStore } from "../persistence/store.js";

export const DEFAULT_ANALYSIS_LIMITS = { batchCalls: DEFAULT_WORKER_MAX_REQUESTS, jobCalls: 120, attemptMs: 60 * 60_000 } as const;
export interface AnalysisExecutionLimits { batchCalls: number; jobCalls: number; attemptMs: number }

function recordedRequests(batch: SemanticBatch): number {
  const saved = batch.checkpoint.execution_requests;
  if (Number.isSafeInteger(saved) && Number(saved) >= 0) return Number(saved);
  // Older attempts only saved diagnostics at the end. This is a conservative
  // observed count, not a claim that unrecorded pre-upgrade calls are recoverable.
  const current = (batch.output as { diagnostics?: WorkerDiagnostics } | null)?.diagnostics?.requestCount ?? 0;
  const history = Array.isArray(batch.checkpoint.diagnostic_runs) ? batch.checkpoint.diagnostic_runs : [];
  return current + history.reduce((total, row) => total + (row?.diagnostics?.requestCount ?? 0), 0);
}

/** One budget per active job attempt. Reservations survive retries; finished batches replay for free. */
export async function createAnalysisExecutionBudget(input: {
  store: Pick<ProductStore, "listSemanticBatches" | "loadSemanticBatch" | "saveSemanticBatch">;
  fence: AnalysisLeaseFence;
  signal: AbortSignal;
  limits?: AnalysisExecutionLimits;
}): Promise<{ beforeRequest: NonNullable<PiModelRuntime["beforeWorkerRequest"]>; signal: AbortSignal; dispose(): void }> {
  const limits = input.limits ?? DEFAULT_ANALYSIS_LIMITS;
  const batches = await input.store.listSemanticBatches(input.fence.jobId);
  const counts = new Map(batches.map(batch => [batch.batch_id, recordedRequests(batch)]));
  let total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const mutex = new KeyedMutex();
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new WorkerExecutionError("analysis_time_limit_exceeded")), limits.attemptMs);
  timer.unref();
  const stop = (code: ConstructorParameters<typeof WorkerExecutionError>[0]): never => {
    const error = new WorkerExecutionError(code);
    controller.abort(error);
    throw error;
  };
  return {
    signal,
    dispose: () => clearTimeout(timer),
    beforeRequest: async (identity) => mutex.runExclusive("job", async () => {
      signal.throwIfAborted();
      if (!identity || identity.jobId !== input.fence.jobId || identity.jobAttempt !== input.fence.attempt) return stop("worker_internal_error");
      const count = counts.get(identity.batchId) ?? 0;
      if (count >= limits.batchCalls) return stop("analysis_batch_call_limit_exceeded");
      if (total >= limits.jobCalls) return stop("analysis_job_call_limit_exceeded");
      try {
        const batch = await input.store.loadSemanticBatch(identity.jobId, identity.batchId);
        if (!batch || batch.status !== "running") return stop("worker_internal_error");
        // Persist before dispatch. A crash between this write and HTTP may overcount
        // one reservation, but cannot silently give an uncertain call back for free.
        await input.store.saveSemanticBatch({ ...batch,
          checkpoint: { ...batch.checkpoint, execution_requests: count + 1,
            execution_limits: { batch_calls: limits.batchCalls, job_calls: limits.jobCalls, attempt_ms: limits.attemptMs } },
          updated_at: new Date().toISOString(),
        }, input.fence);
        counts.set(identity.batchId, count + 1);
        total++;
        signal.throwIfAborted();
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        const reason = error instanceof WorkerExecutionError || error instanceof AnalysisLeaseLostError
          ? error : new WorkerExecutionError("worker_internal_error");
        controller.abort(reason);
        throw reason;
      }
    }, { signal }),
  };
}
