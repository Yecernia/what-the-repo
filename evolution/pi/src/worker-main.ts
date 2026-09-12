import { loadEvolutionRuntime } from "./worker-host.js";
import type { FeedbackEvolutionBatchResult } from "./feedback-worker.js";

type WorkerCommand = "run" | "once" | "review";

function command(value: string | undefined): WorkerCommand {
  if (value === undefined || value === "run" || value === "once" || value === "review") {
    return value ?? "run";
  }
  throw new Error("usage: run | once | review <task-id> <approve|reject> <reviewer-id> [reason]");
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(api[_-]?key|secret|token|password)([\s:=]+)[^\s,;]+/giu, "$1$2[redacted]")
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .trim()
    .slice(0, 800) || "unknown error";
}

function printBatch(value: FeedbackEvolutionBatchResult): void {
  process.stdout.write(`${JSON.stringify({
    promoted: value.promoted.map((item) => ({ request_id: item.requestId, task_ids: item.taskIds })),
    candidates: value.candidates.map((item) => ({
      task_id: item.taskId,
      skill_id: item.skillId,
      candidate_version: item.candidateVersion,
      status: item.status,
    })),
    failed_task_ids: value.failedTaskIds,
  })}\n`);
}

async function main(): Promise<void> {
  const mode = command(process.argv[2]);
  const runtime = await loadEvolutionRuntime();
  try {
    const worker = runtime.feedbackWorker;
    if (!worker) throw new Error("global feedback worker is not configured");

    if (mode === "once") {
      printBatch(await worker.runOnce());
      return;
    }

    if (mode === "review") {
      const taskId = process.argv[3];
      const decision = process.argv[4];
      const reviewerId = process.argv[5];
      const reason = process.argv.slice(6).join(" ").trim() || undefined;
      if (!taskId || (decision !== "approve" && decision !== "reject") || !reviewerId) {
        throw new Error("usage: review <task-id> <approve|reject> <reviewer-id> [reason]");
      }
      const candidate = await worker.review({
        taskId,
        decision,
        reviewerId,
        reason,
      });
      process.stdout.write(`${JSON.stringify({
        task_id: candidate.taskId,
        skill_id: candidate.skillId,
        candidate_version: candidate.candidateVersion,
        status: candidate.status,
      })}\n`);
      return;
    }

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await worker.start(controller.signal);
  } finally {
    await runtime.close?.();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: error instanceof Error && error.name ? error.name : "unknown",
    message: safeErrorMessage(error),
  })}\n`);
  process.exitCode = 1;
}
