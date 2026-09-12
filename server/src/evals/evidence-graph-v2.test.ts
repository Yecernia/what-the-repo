import assert from "node:assert/strict";
import test from "node:test";
import {
  LARGE_REPOSITORY_FILE_COUNT,
  runEvidenceGraphV2Eval,
} from "./evidence-graph-v2.js";

test("evidence graph v2 eval covers the bounded large-repository contracts", () => {
  const report = runEvidenceGraphV2Eval();
  assert.equal(report.passed, true);
  assert.equal(report.checks.large_repository_10k_files, true);
  assert.equal(report.metrics.files, LARGE_REPOSITORY_FILE_COUNT);
  assert.equal(report.checks.partial_language_failure_visible, true);
  assert.equal(report.checks.semantic_batch_resume_contract, true);
  assert.equal(report.checks.semantic_batch_cancellation_contract, true);
  assert.equal(report.checks.incremental_deletion_contract, true);
  assert.equal(report.checks.evidence_quality_gate, true);
});
