import assert from "node:assert/strict";
import test from "node:test";
import { deriveSnapshotProjections } from "./snapshot-projection.js";
import { validateEvidenceSnapshot } from "./snapshot-validation.js";
import type { SnapshotEdge, SnapshotNode } from "./snapshot.js";

function node(
  id: string,
  kind: "repository" | "subsystem" | "component",
  parent_entity_id: string | null,
  depth: number,
  evidenceId: string,
): SnapshotNode {
  const evidence = {
    stable_id: evidenceId,
    label: `${id}:1`,
    path: `${id.replaceAll(":", "/")}.ts`,
    start_line: 1,
    end_line: 2,
    kind: "symbol",
  };
  return {
    id,
    entity_kind: kind,
    parent_entity_id,
    depth,
    label: id,
    name: id,
    responsibility: "",
    grouping_rationale: "",
    architecture_layer_id: null,
    architecture_layer_name: null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "degraded",
    members: [evidence],
    member_count: 1,
    evidence: [evidence],
    certainty: "degraded",
    review_status: "unreviewed",
    source_report_ids: [],
    fan_in: 0,
    fan_out: 0,
  };
}

function edge(id: string, source: string, target: string, evidenceId: string): SnapshotEdge {
  return {
    id,
    source,
    target,
    relation_kind: "calls",
    label: "调用",
    description: "",
    certainty: "verified",
    evidence: [{
      stable_id: evidenceId,
      label: `${id}:1`,
      path: "src/edge.ts",
      start_line: 1,
      end_line: 1,
      kind: "relation",
      source_id: source,
      target_id: target,
    }],
    weight: 1,
  };
}

function snapshotValue() {
  const nodes = [
    node("entity:repository:r", "repository", null, 0, "evidence:r"),
    node("entity:subsystem:s", "subsystem", "entity:repository:r", 1, "evidence:s"),
    node("component:a", "component", "entity:subsystem:s", 2, "evidence:a"),
    node("component:b", "component", "entity:subsystem:s", 2, "evidence:b"),
  ];
  const edges = [
    edge("relation:a-b", "component:a", "component:b", "evidence:ab"),
    edge("relation:b-a", "component:b", "component:a", "evidence:ba"),
  ];
  return {
    snapshot_id: "snap:projection",
    nodes,
    edges,
    overlays: [{
      id: "overlay:runtime",
      kind: "runtime" as const,
      name: "运行时",
      responsibility: "",
      member_entity_ids: ["component:a", "component:b"],
      relation_ids: ["relation:a-b"],
      evidence_ids: ["evidence:ab"],
      certainty: "verified",
    }],
  };
}

test("derives an agent projection with direct entities and a human projection with bounded aggregation", () => {
  const value = snapshotValue();
  const projections = deriveSnapshotProjections({
    ...value,
    max_human_depth: 1,
    human_collapse_threshold: 1,
  });
  assert.deepEqual(projections.agent.nodes.map((row) => row.entity_id), [
    "entity:repository:r",
    "entity:subsystem:s",
    "component:a",
    "component:b",
  ]);
  assert.equal(projections.agent.edges.length, 2);
  assert.deepEqual(projections.human.nodes.map((row) => row.entity_id), [
    "entity:repository:r",
    "entity:subsystem:s",
  ]);
  assert.equal(projections.human.nodes[1]?.aggregate_member_entity_ids.sort().join(","), "component:a,component:b");
  assert.equal(projections.human.edges.length, 0);
  assert.ok((projections.human.nodes[1]?.evidence_ids ?? []).includes("evidence:a"));
  assert.ok((projections.agent.nodes[2]?.overlay_ids ?? []).includes("overlay:runtime"));
  assert.ok((projections.agent.edges[0]?.overlay_ids ?? []).includes("overlay:runtime"));
});

test("projection identifiers remain inside the canonical snapshot contract", () => {
  const value = snapshotValue();
  const projections = deriveSnapshotProjections(value);
  const evidence = value.nodes.flatMap((row) => [...row.evidence, ...row.members])
    .concat(value.edges.flatMap((row) => row.evidence));
  const snapshot = {
    snapshot_id: value.snapshot_id,
    summary: {},
    graph: {
      schema_version: "evidence-graph-v2" as const,
      semantic_mode: "structural_candidate",
      nodes: value.nodes,
      edges: value.edges,
      layers: [],
      unassigned_component_ids: [],
      hierarchy: {
        root_entity_ids: ["entity:repository:r"],
        max_depth: 2,
      },
      overlays: value.overlays,
      projections,
    },
    fact_graph: { nodes: [], edges: [] },
    value_points: [],
    languages: [],
    learning_plan: { snapshot_id: value.snapshot_id, selected_value_point: null, steps: [] },
  };
  assert.ok(evidence.length > 0);
  const validation = validateEvidenceSnapshot(snapshot);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});
