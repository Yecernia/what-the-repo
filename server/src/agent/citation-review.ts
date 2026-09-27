import { Type } from "typebox";
import type { EvidenceRef } from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";
import { loadEvidencePackets } from "./evidence-packets.js";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime, PiUsageSummary } from "./types.js";

const REVIEW_RESULT = Type.Object({
  supported: Type.Boolean(),
  accepted_evidence_ids: Type.Array(
    Type.String({ maxLength: 256 }),
    { maxItems: 20 },
  ),
  unsupported_claims: Type.Array(
    Type.String({ maxLength: 500 }),
    { maxItems: 12 },
  ),
  summary: Type.String({ maxLength: 500 }),
  issues: Type.Optional(Type.Array(Type.Object({
    claim: Type.String({ maxLength: 500 }), reason: Type.String({ maxLength: 500 }),
    kind: Type.Union([Type.Literal("insufficient_evidence"), Type.Literal("contradicted")]),
  }), { maxItems: 12 })),
});

export interface CitationReviewResult {
  status: "reviewed" | "not_applicable" | "unverified";
  summary: string;
  issues: Array<{ claim: string; reason: string; kind: "insufficient_evidence" | "contradicted" }>;
  evidenceIncomplete: boolean;
  completed: boolean;
  supported: boolean;
  acceptedEvidenceIds: string[];
  unsupportedClaims: string[];
  stopReason: string;
  usage: PiUsageSummary;
}

const EMPTY_USAGE: PiUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

/** Never expose exception/provider text through the saved review or user notice. */
export function unavailableEvidenceReview(reason?: string): CitationReviewResult {
  const safeReason = ["cancelled", "worker_call_limit_exceeded", "worker_time_limit_exceeded", "invalid_review_result"].includes(reason ?? "")
    ? reason! : "review_unavailable";
  return {
    status: "unverified", summary: "未能完成证据核对，请将相关说明视为尚未核实。",
    issues: [], evidenceIncomplete: false, completed: false, supported: false,
    acceptedEvidenceIds: [], unsupportedClaims: [], stopReason: safeReason, usage: { ...EMPTY_USAGE },
  };
}

export async function reviewAnswerEvidence(input: {
  text: string;
  evidence: EvidenceRef[];
  projectId: string;
  snapshotId: string;
  store: ProductStore;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
}): Promise<CitationReviewResult> {
  if (/^(?:你好|您好|谢谢|多谢|再见|hi|hello|thanks|thank you|bye)[!！。.\s]*$/iu.test(input.text.trim())) {
    return { status: "not_applicable", summary: "No repository claim to check.", issues: [], evidenceIncomplete: false,
      completed: true, supported: false, acceptedEvidenceIds: [], unsupportedClaims: [], stopReason: "not_applicable", usage: EMPTY_USAGE };
  }
  if (!input.evidence.length) {
    return {
      status: "unverified", summary: "回答没有可复查的仓库证据。", evidenceIncomplete: true,
      issues: [{ claim: input.text.slice(0, 500), reason: "回答没有可复查的仓库证据。", kind: "insufficient_evidence" }],
      completed: false,
      supported: false,
      acceptedEvidenceIds: [],
      unsupportedClaims: ["回答没有可复查的仓库证据。"],
      stopReason: "no_evidence",
      usage: EMPTY_USAGE,
    };
  }
  const { packets, incomplete } = await loadEvidencePackets(input);
  const result = await runStructuredWorker({
    skillId: "citation-review",
    inputSchemaId: "citation-review-input-v2",
    outputSchemaId: "citation-review-output-v2",
    contextBuilderId: "citation-review-context-v4",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: REVIEW_RESULT,
    systemPrompt: [
      "The program has already checked paths, line numbers, the snapshot and evidence IDs deterministically and supplies bounded, safe excerpts; this Skill judges semantic support.",
      "Only actual excerpt lines establish support. Incomplete ranges, unavailable source and graph labels cannot establish missing behavior. Missing evidence is not proof a claim is false. Return issues with the exact claim, a specific reason, and kind insufficient_evidence or contradicted. Use contradicted only when the excerpt explicitly disproves the claim.",
      "accepted_evidence_ids must come from the input. Do not retrieve anything or change state. Finish by calling submit_result.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      evidence: packets,
      final_answer: input.text,
    }),
  });
  if (!result.value || result.validationErrors.length || result.stopReason !== "completed") {
    return { ...unavailableEvidenceReview(result.value ? "invalid_review_result" : result.stopReason),
      evidenceIncomplete: incomplete, usage: result.usage };
  }
  const allowed = new Set(packets.filter(packet => !packet.incomplete).map(packet => packet.evidence_id));
  const acceptedEvidenceIds = result.value.accepted_evidence_ids.filter(id => allowed.has(id));
  if (result.value.supported && !acceptedEvidenceIds.length) {
    return { ...unavailableEvidenceReview("invalid_review_result"), evidenceIncomplete: incomplete, usage: result.usage };
  }
  const issues = result.value.issues?.length ? result.value.issues : result.value.unsupported_claims.map(claim => ({
    claim, reason: result.value!.summary, kind: "insufficient_evidence" as const,
  }));
  return {
    status: incomplete ? "unverified" : "reviewed",
    summary: result.value.summary,
    issues,
    evidenceIncomplete: incomplete,
    completed: true,
    supported: result.value.supported && !incomplete && !issues.length && !result.value.unsupported_claims.length,
    acceptedEvidenceIds,
    unsupportedClaims: result.value.unsupported_claims,
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
