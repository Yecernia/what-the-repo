import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyAnalysis,
  recordAnalysisProgress,
} from "./conversation.js";

test("analysis progress closes prior phases and records the actual failed phase once", () => {
  const analysis = emptyAnalysis();
  analysis.started_at = "2026-09-03T00:00:00.000Z";

  recordAnalysisProgress(analysis, "checking_existing", "running", "2026-09-03T00:00:00.000Z");
  recordAnalysisProgress(analysis, "confirming_upstream", "running", "2026-09-03T00:00:01.000Z");
  recordAnalysisProgress(analysis, "failed", "failed", "2026-09-03T00:00:03.000Z");

  assert.deepEqual(analysis.progress_events?.map((event) => ({
    kind: event.kind,
    status: event.status,
    elapsed_ms: event.elapsed_ms,
  })), [
    { kind: "checking_existing", status: "completed", elapsed_ms: 1_000 },
    { kind: "confirming_upstream", status: "failed", elapsed_ms: 3_000 },
  ]);
});

test("parallel stages update in place; cancellation preserves finished work and attempt identities", () => {
  const analysis = emptyAnalysis();
  const timestamp = "2026-09-08T00:00:00.000Z";
  recordAnalysisProgress(analysis, "planning_architecture", "running", timestamp, { instance_id: "job/1/layers" });
  recordAnalysisProgress(analysis, "discovering_values", "running", timestamp, { instance_id: "job/1/values" });
  assert.deepEqual(analysis.progress_events?.map(event => event.status), ["running", "running"]);
  recordAnalysisProgress(analysis, "planning_architecture", "completed", timestamp, { instance_id: "job/1/layers", completed_batches: 2 });
  recordAnalysisProgress(analysis, "cancelled", "cancelled", timestamp);
  assert.deepEqual(analysis.progress_events?.slice(0, 2).map(event => event.status), ["completed", "cancelled"]);
  recordAnalysisProgress(analysis, "planning_architecture", "reused", timestamp, { instance_id: "job/2/layers", completed_batches: 2, reused_batches: 2 });
  assert.equal(analysis.progress_events?.length, 4);
  assert.equal(analysis.progress_events?.[0]?.completed_batches, 2);
});

test("publication completes only at the final transition and retains partial results", () => {
  const analysis = emptyAnalysis();
  recordAnalysisProgress(analysis, "translating_values", "degraded", undefined, { instance_id: "job/1/values" });
  recordAnalysisProgress(analysis, "publishing_translation", "running", undefined, { instance_id: "job/1/save" });
  recordAnalysisProgress(analysis, "completed", "degraded");
  assert.deepEqual(analysis.progress_events?.map(event => event.status), ["degraded", "degraded", "degraded"]);
});
