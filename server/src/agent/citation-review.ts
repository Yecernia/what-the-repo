import { Type } from "typebox";
import type { EvidenceRef } from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";
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
});

export interface CitationReviewResult {
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

export async function reviewAnswerEvidence(input: {
  text: string;
  evidence: EvidenceRef[];
  projectId: string;
  snapshotId: string;
  store: ProductStore;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
}): Promise<CitationReviewResult> {
  if (!input.evidence.length) {
    return {
      completed: true,
      supported: false,
      acceptedEvidenceIds: [],
      unsupportedClaims: ["回答没有可复查的仓库证据。"],
      stopReason: "no_evidence",
      usage: EMPTY_USAGE,
    };
  }
  const packets = [];
  for (const row of input.evidence.slice(0, 12)) {
    const line = row.start_line ?? 1;
    let excerpt: string[] = [];
    try {
      excerpt = (await input.store.readSourceLines(
        input.projectId,
        input.snapshotId,
        row.path,
        Math.max(1, line - 3),
        line + 6,
      )).lines;
    } catch {
      // The reviewer can still use graph metadata when the source is unavailable.
    }
    packets.push({
      evidence_id: row.stable_id,
      label: row.label,
      path: row.path,
      start_line: row.start_line,
      end_line: row.end_line,
      kind: row.kind,
      excerpt,
    });
  }
  const result = await runStructuredWorker({
    skillId: "citation-review",
    inputSchemaId: "citation-review-input-v1",
    outputSchemaId: "citation-review-output-v1",
    contextBuilderId: "citation-review-context-v2",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: REVIEW_RESULT,
    systemPrompt: [
      "程序已经确定性核对路径、行号、快照和 Evidence ID，并提供有界安全片段；当前 Skill 负责语义支持判断。",
      "accepted_evidence_ids 只能来自输入；不得检索或修改状态，必须调用 submit_result。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      final_answer: input.text,
      evidence: packets,
    }),
  });
  if (!result.value) {
    return {
      completed: false,
      supported: false,
      acceptedEvidenceIds: [],
      unsupportedClaims: [],
      stopReason: result.stopReason,
      usage: result.usage,
    };
  }
  const allowed = new Set(input.evidence.map((row) => row.stable_id));
  return {
    completed: true,
    supported: result.value.supported,
    acceptedEvidenceIds: result.value.accepted_evidence_ids
      .filter((id) => allowed.has(id)),
    unsupportedClaims: result.value.unsupported_claims,
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
