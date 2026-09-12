import type { AnalysisProgressEvent, AnalysisProgressKind } from "../domain/conversation.js";
import type { SemanticBatchContext } from "./semantic-contracts.js";

export type AnalysisProgressUpdate = Pick<AnalysisProgressEvent,
  "kind" | "status" | "completed_batches" | "total_batches" | "reused_batches">;
export type AnalysisProgressReporter = (update: AnalysisProgressUpdate) => Promise<void>;

/** One persisted row per actual stage, including parallel branches and replay.
 * Batch stages start only when an uncached batch runs; replay alone is not LLM work. */
export async function trackAnalysisStage<T>(
  kind: AnalysisProgressKind,
  context: SemanticBatchContext | undefined,
  run: (context: SemanticBatchContext | undefined) => T | Promise<T>,
  options: {
    batches?: boolean;
    totalBatches?: number;
    signal?: AbortSignal;
    status?: (result: T) => AnalysisProgressEvent["status"];
  } = {},
): Promise<T> {
  let completed = 0;
  let reused = 0;
  let started = false;
  const emit = (status: AnalysisProgressEvent["status"]) => context?.onProgress?.({
    kind, status,
    ...(options.batches ? { completed_batches: completed, total_batches: options.totalBatches, reused_batches: reused } : {}),
  });
  const scoped = context ? { ...context, batchProgress: {
    start: async () => { if (!started) { started = true; await emit("running"); } },
    complete: async (cached: boolean) => {
      completed++;
      if (cached) reused++;
      if (started) await emit("running");
    },
  } } : undefined;
  try {
    if (!options.batches) await emit("running");
    const result = await run(scoped);
    const status = options.signal?.aborted ? "cancelled" : options.status?.(result) ?? "completed";
    await emit(status === "completed" && options.batches && completed > 0 && completed === reused ? "reused" : status);
    return result;
  } catch (error) {
    await emit(options.signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}
