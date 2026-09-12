import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEvidenceQualityGate,
  measureEvidenceQuality,
} from "./evidence-quality.js";

test("evidence quality metrics count first evidence, round trips, repetition and tokens", () => {
  const metrics = measureEvidenceQuality({
    events: [
      { type: "model_started", elapsed_ms: 4 },
      { type: "tool_call_requested", tool_call_id: "tool:1", elapsed_ms: 8 },
      { type: "tool_result_received", tool_call_id: "tool:1", elapsed_ms: 32, evidence_ids: ["evidence:a"] },
      { type: "model_started", elapsed_ms: 40 },
      { type: "tool_call_requested", tool_call_id: "tool:2", elapsed_ms: 44 },
      { type: "tool_result_received", tool_call_id: "tool:2", elapsed_ms: 58, evidence_ids: ["evidence:a", "evidence:b"] },
    ],
    observed_evidence_ids: ["evidence:a", "evidence:a", "evidence:b"],
    valid_evidence_ids: ["evidence:a", "evidence:b"],
    referenced_evidence_ids: ["evidence:a", "evidence:b", "evidence:missing"],
    usage: { inputTokens: 100, outputTokens: 40, cachedTokens: 10, cacheWriteTokens: 5 },
    expected_conclusions: [
      { id: "conclusion:entry", evidence_ids: ["evidence:a"] },
      { id: "conclusion:domain", evidence_ids: ["evidence:b"] },
    ],
  });

  assert.equal(metrics.first_valid_evidence_ms, 32);
  assert.equal(metrics.tool_call_count, 2);
  assert.equal(metrics.tool_round_trips, 2);
  assert.equal(metrics.model_call_count, 2);
  assert.equal(metrics.model_round_trips, 2);
  assert.equal(metrics.observed_evidence_count, 3);
  assert.equal(metrics.unique_evidence_count, 2);
  assert.equal(metrics.repeated_evidence_ratio, 1 / 3);
  assert.equal(metrics.total_tokens, 140);
  assert.equal(metrics.citation_correctness, 2 / 3);
  assert.equal(metrics.key_conclusion_coverage, 1);
  assert.equal(metrics.evolution_eligible, false);
  assert.ok(metrics.quality_gate_reasons.includes("citation_correctness_below_threshold"));
});

test("quality gate accepts complete evidence metrics and blocks missing first evidence", () => {
  const accepted = measureEvidenceQuality({
    events: [
      { type: "tool_result_received", elapsed_ms: 12, evidence_ids: ["evidence:a"] },
    ],
    observed_evidence_ids: ["evidence:a"],
    valid_evidence_ids: ["evidence:a"],
    referenced_evidence_ids: ["evidence:a"],
    usage: { total_tokens: 12 },
    expected_conclusions: [{ id: "conclusion:a", evidence_ids: ["evidence:a"] }],
  });
  assert.equal(accepted.evolution_eligible, true);
  assert.deepEqual(accepted.quality_gate_reasons, []);

  const missing = measureEvidenceQuality({
    observed_evidence_ids: ["evidence:a"],
    valid_evidence_ids: ["evidence:a"],
  });
  assert.equal(missing.evolution_eligible, false);
  assert.ok(missing.quality_gate_reasons.includes("first_valid_evidence_missing"));
  assert.ok(missing.quality_gate_reasons.includes("citation_correctness_not_scored"));

  const untrusted = measureEvidenceQuality({
    events: [{ type: "tool_result_received", elapsed_ms: 8, evidence_ids: ["evidence:unknown"] }],
    observed_evidence_ids: ["evidence:unknown"],
    valid_evidence_ids: [],
  });
  assert.equal(untrusted.first_valid_evidence_ms, null);
  assert.equal(untrusted.evolution_eligible, false);
});

test("quality gate thresholds remain explicit and deterministic", () => {
  const result = evaluateEvidenceQualityGate({
    first_valid_evidence_ms: 1,
    citation_correctness: 0.9,
    key_conclusion_coverage: 0.7,
    repeated_evidence_ratio: 0.7,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [
    "citation_correctness_below_threshold",
    "repeated_evidence_ratio_above_threshold",
    "key_conclusion_coverage_below_threshold",
  ]);
});
