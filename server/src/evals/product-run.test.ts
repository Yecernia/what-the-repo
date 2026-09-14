import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import { evaluateStaticSnapshot, runProductEval, type FixedCase } from "./product-run.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixedCase = JSON.parse(await readFile(join(root, "eval/cases/python-edge-cases.json"), "utf8")) as FixedCase;

async function fixture(t: TestContext) {
  const outputDir = await mkdtemp(join(tmpdir(), "what-the-repo-static-eval-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const report = await runProductEval({
    root,
    target: join(root, "eval/fixtures/python-edge-cases/source"),
    repository: "fixture/python-edge-cases",
    expectedCommit: "fixture",
    outputDir,
    fixedCase,
  });
  const snapshot = JSON.parse(await readFile(join(outputDir, "snapshot.json"), "utf8")) as EvidenceSnapshot;
  return { report, snapshot };
}

test("static fixture eval checks local calls and reports full-binding gaps without generating a learning route", async (t) => {
  const { report, snapshot } = await fixture(t);
  assert.equal(report.passed, true);
  const truth = report.truth as { call_metrics: { expected: number; recall: number }; tree_sitter_local_call_metrics: { precision: number; recall: number } };
  assert.equal(truth.call_metrics.expected, 58);
  assert.ok(truth.call_metrics.recall < 0.5, "full-binding gaps must remain visible");
  assert.equal(truth.tree_sitter_local_call_metrics.precision, 1);
  assert.equal(truth.tree_sitter_local_call_metrics.recall, 1);
  assert.deepEqual(snapshot.learning_plan.steps, []);
  assert.deepEqual(snapshot.value_points, []);
});

test("static fixture eval fails when a required local call is missing or its truth is absent", async (t) => {
  const { snapshot } = await fixture(t);
  const call = snapshot.fact_graph!.edges.find((edge) => edge.relation_kind === "calls")!;
  snapshot.fact_graph!.edges = snapshot.fact_graph!.edges.filter((edge) =>
    edge.relation_kind !== "calls" || edge.source !== call.source || edge.target !== call.target);
  assert.equal(evaluateStaticSnapshot(snapshot, fixedCase.expected_files, fixedCase).checks.fixed_local_call_recall, false);
  const missingTruth = structuredClone(fixedCase);
  delete missingTruth.relation_anchors!.tree_sitter_local_calls;
  assert.equal(evaluateStaticSnapshot(snapshot, fixedCase.expected_files, missingTruth).checks.fixed_local_call_anchors_present, false);
});

test("static fixture eval rejects an invented call edge even when all required calls remain", async (t) => {
  const { snapshot } = await fixture(t);
  const call = snapshot.fact_graph!.edges.find((edge) => edge.relation_kind === "calls")!;
  snapshot.fact_graph!.edges.push({ ...call, source: call.target, target: call.source });
  const checks = evaluateStaticSnapshot(snapshot, fixedCase.expected_files, fixedCase).checks;
  assert.equal(checks.fixed_local_call_recall, true);
  assert.equal(checks.fixed_local_call_precision, false);
});

test("static fixture eval rejects a preselected learning goal", async (t) => {
  const { snapshot } = await fixture(t);
  snapshot.learning_plan.selected_value_point = "unconfirmed-goal";
  assert.equal(evaluateStaticSnapshot(snapshot, fixedCase.expected_files, fixedCase).checks.learning_route_deferred, false);
});

test("static eval validates hierarchy children and still rejects empty scopes and fabricated evidence", async (t) => {
  const { snapshot } = await fixture(t);
  const component = snapshot.graph.nodes[0]!;
  const scope = {
    ...structuredClone(component), id: "repository:test", entity_kind: "repository" as const,
    parent_entity_id: null, members: [], member_count: snapshot.graph.nodes.length,
  };
  for (const node of snapshot.graph.nodes) node.parent_entity_id = scope.id;
  snapshot.graph.nodes.unshift(scope);
  const valid = () => evaluateStaticSnapshot(snapshot, fixedCase.expected_files, fixedCase).checks.component_evidence_valid;
  assert.equal(valid(), true);
  scope.member_count += 1;
  assert.equal(valid(), false);
  scope.member_count -= 1;
  const originalPath = component.members[0]!.path;
  component.members[0]!.path = "fabricated.ts";
  assert.equal(valid(), false);
  component.members[0]!.path = originalPath;
  snapshot.graph.nodes = [scope];
  scope.member_count = 0;
  assert.equal(valid(), false);
});
