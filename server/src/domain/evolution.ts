export type EvolutionFeedbackRequestStatus = "pending" | "task_created" | "dismissed";

/**
 * A privacy-bounded, product-side handoff from feedback analysis to the
 * evolution lane. It is deliberately not an EvolutionTask: the evolution
 * runtime adds its reviewed base version, checks and evaluation contract.
 */
export interface EvolutionFeedbackRequest {
  request_id: string;
  dedupe_key: string;
  trigger: "human_feedback";
  skill_ids: string[];
  reasons: string[];
  strengths: string[];
  source_trace_ids: string[];
  source_message_ids: string[];
  sample_count: number;
  /** Owners represented by this globally deduplicated request. */
  owner_ids?: string[];
  /** Legacy single-owner field kept for older queued payloads. */
  owner_id?: string;
  /** Legacy migration field kept for older queued payloads. */
  source_owner_id?: string;
  status: EvolutionFeedbackRequestStatus;
  task_ids: string[];
  task_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Remove one owner from a globally deduplicated feedback request. */
export function removeOwnerFromEvolutionFeedbackRequest(
  request: EvolutionFeedbackRequest,
  ownerId: string,
): EvolutionFeedbackRequest | null {
  const ownerIds = new Set([
    ...(request.owner_ids ?? []),
    ...(request.owner_id ? [request.owner_id] : []),
    ...(request.source_owner_id ? [request.source_owner_id] : []),
  ].filter((value) => value && value !== ownerId));
  if (!ownerIds.size) return null;
  const remaining = [...ownerIds].slice(0, 100);
  return {
    ...request,
    owner_ids: remaining,
    owner_id: request.owner_id === ownerId ? remaining[0] : request.owner_id,
    source_owner_id: request.source_owner_id === ownerId ? remaining[0] : request.source_owner_id,
  };
}

function mergeUnique(left: string[], right: string[], limit: number): string[] {
  return [...new Set([...left, ...right].map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

export function mergeEvolutionFeedbackRequests(
  current: EvolutionFeedbackRequest,
  incoming: EvolutionFeedbackRequest,
): EvolutionFeedbackRequest {
  if (current.dedupe_key !== incoming.dedupe_key || current.status !== "pending") {
    throw new Error("evolution feedback requests cannot be merged");
  }
  return {
    ...current,
    skill_ids: mergeUnique(current.skill_ids, incoming.skill_ids, 12),
    reasons: mergeUnique(current.reasons, incoming.reasons, 20),
    strengths: mergeUnique(current.strengths, incoming.strengths, 20),
    source_trace_ids: mergeUnique(current.source_trace_ids, incoming.source_trace_ids, 100),
    source_message_ids: mergeUnique(current.source_message_ids, incoming.source_message_ids, 100),
    sample_count: current.sample_count + incoming.sample_count,
    owner_ids: [...new Set([
      ...(current.owner_ids ?? (current.owner_id ? [current.owner_id] : [])),
      ...(incoming.owner_ids ?? (incoming.owner_id ? [incoming.owner_id] : [])),
    ])].slice(0, 100),
    owner_id: current.owner_id ?? incoming.owner_id,
    updated_at: incoming.updated_at,
  };
}
