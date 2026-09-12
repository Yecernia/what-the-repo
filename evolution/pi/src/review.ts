import type { ReviewDecision } from "./contracts.js";
import { EvolutionStateStore } from "./state-store.js";

export async function createReviewDecision(input: {
  state: EvolutionStateStore;
  taskId: string;
  reviewerId: string;
  decision: ReviewDecision["decision"];
  reason?: string;
}): Promise<ReviewDecision> {
  const [candidate, ledger] = await Promise.all([
    input.state.loadCandidate(input.taskId),
    input.state.loadLedger(input.taskId),
  ]);
  if (candidate.status !== "candidate" || ledger.status !== "awaiting_review" || !ledger.candidateDigest) {
    throw new Error("evolution candidate is not awaiting review");
  }
  if (input.decision === "approve" && input.reason !== undefined) {
    throw new Error("approval must not carry a rejection reason");
  }
  if (input.decision === "reject" && !input.reason?.trim()) {
    throw new Error("rejection requires a reason");
  }
  return {
    taskId: input.taskId,
    reviewerId: input.reviewerId,
    decision: input.decision,
    candidateDigest: ledger.candidateDigest,
    taskDigest: ledger.taskDigest,
    baseRevision: candidate.baseRevision,
    baseSnapshotDigest: candidate.baseSnapshotDigest,
    claimedAt: new Date().toISOString(),
    ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
  };
}
