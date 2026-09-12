import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_GRAPH_SCHEMA_VERSION,
  asEvidenceSnapshot,
} from "./snapshot.js";
import {
  assertValidEvidenceSnapshot,
  validateEvidenceSnapshot,
} from "./snapshot-validation.js";

function evidence(id: string, path = "src/a.ts") {
  return {
    stable_id: id,
    label: `${path}:1`,
    path,
    start_line: 1,
    end_line: 2,
    kind: "symbol",
  };
}

function node(id: string, overrides: Record<string, unknown> = {}) {
  const row = evidence(`evidence:${id}`);
  return {
    id,
    label: id,
    name: id,
    responsibility: "test",
    architecture_layer_id: null,
    architecture_layer_name: null,
    members: [row],
    member_count: 1,
    evidence: [row],
    certainty: "verified",
    review_status: "accepted",
    fan_in: 0,
    fan_out: 0,
    ...overrides,
  };
}

function snapshot(nodes: unknown[], graph: Record<string, unknown> = {}) {
  return {
    snapshot_id: "snap:v2-contract",
    summary: {},
    graph: {
      semantic_mode: "structural_candidate",
      nodes,
      edges: [],
      layers: [],
      unassigned_component_ids: [],
      ...graph,
    },
    value_points: [],
    languages: [],
    learning_plan: {
      snapshot_id: "snap:v2-contract",
      selected_value_point: null,
      steps: [],
    },
  };
}

test("legacy snapshots gain root hierarchy, layer overlays, and identity projections", () => {
  const legacy = snapshot([node("component:a")], {
    layers: [{
      id: "layer:entry",
      name: "入口层",
      responsibility: "接收请求",
      component_ids: ["component:a"],
      evidence: [evidence("evidence:component:a")],
      certainty: "supported",
    }],
  });
  const normalized = asEvidenceSnapshot(legacy);
  assert.ok(normalized);
  assert.equal(normalized.graph.schema_version, EVIDENCE_GRAPH_SCHEMA_VERSION);
  assert.equal(normalized.graph.nodes[0]?.entity_kind, "component");
  assert.equal(normalized.graph.nodes[0]?.parent_entity_id, null);
  assert.equal(normalized.graph.nodes[0]?.depth, 0);
  assert.deepEqual(normalized.graph.hierarchy, {
    root_entity_ids: ["component:a"],
    max_depth: 0,
  });
  assert.deepEqual(normalized.graph.overlays.map((overlay) => ({
    id: overlay.id,
    kind: overlay.kind,
    members: overlay.member_entity_ids,
  })), [{ id: "layer:entry", kind: "architecture_layer", members: ["component:a"] }]);
  assert.equal(normalized.graph.projections.human.nodes[0]?.entity_id, "component:a");
  assert.equal(normalized.graph.projections.agent.nodes[0]?.entity_id, "component:a");
  assert.equal(validateEvidenceSnapshot(normalized).valid, true);
});

test("a valid multi-level hierarchy is accepted", () => {
  const value = snapshot([
    node("system:root", {
      entity_kind: "system",
      parent_entity_id: null,
      depth: 0,
      members: [],
      member_count: 0,
      evidence: [],
    }),
    node("component:a", {
      entity_kind: "component",
      parent_entity_id: "system:root",
      depth: 1,
    }),
  ], {
    schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
    hierarchy: { root_entity_ids: ["system:root"], max_depth: 1 },
  });
  const normalized = assertValidEvidenceSnapshot(value);
  assert.equal(normalized.graph.hierarchy.max_depth, 1);
  assert.equal(normalized.graph.nodes[1]?.parent_entity_id, "system:root");
});

test("invalid parent chains and cycles are rejected", () => {
  const missingParent = validateEvidenceSnapshot(snapshot([
    node("component:a", { parent_entity_id: "system:missing", depth: 1 }),
  ]));
  assert.ok(missingParent.issues.some((issue) => issue.code === "parent_entity_missing"));

  const cyclic = validateEvidenceSnapshot(snapshot([
    node("component:a", { parent_entity_id: "component:b", depth: 1 }),
    node("component:b", { parent_entity_id: "component:a", depth: 2 }),
  ]));
  assert.ok(cyclic.issues.some((issue) => issue.code === "hierarchy_cycle"));
  assert.throws(
    () => assertValidEvidenceSnapshot(snapshot([
      node("component:a", { parent_entity_id: "component:b", depth: 1 }),
      node("component:b", { parent_entity_id: "component:a", depth: 2 }),
    ])),
    /evidence_snapshot_invalid/,
  );
});

test("projection references and Evidence identities stay inside the canonical snapshot", () => {
  const invalidProjection = validateEvidenceSnapshot(snapshot([node("component:a")], {
    projections: {
      human: {
        kind: "human",
        snapshot_id: "snap:v2-contract",
        nodes: [{
          projection_node_id: "human:missing",
          entity_id: "component:missing",
          parent_projection_node_id: null,
          depth: 0,
          aggregate_member_entity_ids: [],
          evidence_ids: [],
        }],
        edges: [],
        truncated: false,
        next_cursor: null,
      },
    },
  }));
  assert.ok(invalidProjection.issues.some((issue) => issue.code === "projection_entity_missing"));

  const conflict = validateEvidenceSnapshot(snapshot([
    node("component:a", { evidence: [evidence("evidence:shared", "src/a.ts")] }),
    node("component:b", { evidence: [evidence("evidence:shared", "src/b.ts")] }),
  ]));
  assert.ok(conflict.issues.some((issue) => issue.code === "evidence_identity_conflict"));
});

test("declared v2 snapshots cannot normalize unsupported entity or overlay kinds away", () => {
  const invalid = validateEvidenceSnapshot(snapshot([
    node("component:a", {
      entity_kind: "invented",
      parent_entity_id: null,
      depth: 0,
    }),
  ], {
    schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
    overlays: [{
      id: "overlay:bad",
      kind: "invented",
      name: "bad",
      responsibility: "bad",
      member_entity_ids: ["component:a"],
      relation_ids: [],
      evidence_ids: [],
      certainty: "unknown",
    }],
  }));
  assert.ok(invalid.issues.some((issue) => issue.code === "entity_kind_invalid"));
  assert.ok(invalid.issues.some((issue) => issue.code === "overlay_kind_invalid"));
});
