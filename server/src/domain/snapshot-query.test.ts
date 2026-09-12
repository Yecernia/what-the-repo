import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSnapshotQueryDirectory,
  querySnapshotQueryDirectory,
} from "./snapshot-query.js";

function snapshot() {
  const evidence = {
    stable_id: "evidence:file-a:1",
    label: "file-a.ts:1",
    path: "src/file-a.ts",
    start_line: 1,
    end_line: 3,
    kind: "symbol",
  };
  return {
    snapshot_id: "snap:test-query",
    summary: { file_count: 1, symbol_count: 2, call_count: 1 },
    graph: {
      semantic_mode: "static",
      nodes: [
        {
          id: "component:a",
          label: "A",
          name: "A",
          responsibility: "入口",
          architecture_layer_id: null,
          architecture_layer_name: null,
          members: [evidence],
          member_count: 1,
          evidence: [evidence],
          certainty: "supported",
          review_status: "unreviewed",
          fan_in: 0,
          fan_out: 1,
        },
        {
          id: "component:b",
          label: "B",
          name: "B",
          responsibility: "服务",
          architecture_layer_id: null,
          architecture_layer_name: null,
          members: [],
          member_count: 0,
          evidence: [],
          certainty: "supported",
          review_status: "unreviewed",
          fan_in: 1,
          fan_out: 0,
        },
      ],
      edges: [{
        id: "relation:a:b",
        source: "component:a",
        target: "component:b",
        relation_kind: "calls",
        label: "调用",
        description: "A 调用 B",
        certainty: "supported",
        evidence: [evidence],
        weight: 1,
      }],
      layers: [],
      unassigned_component_ids: [],
    },
    fact_graph: undefined,
    value_points: [],
    languages: [],
    learning_plan: { snapshot_id: "snap:test-query", selected_value_point: null, steps: [] },
  };
}

test("query directory deduplicates evidence and paginates by stable cursor", () => {
  const value = snapshot();
  value.graph.nodes[0] = {
    ...value.graph.nodes[0],
    attributes: { path: "src/file-a.ts", searchable_tag: "entry-tag" },
    source_observations: [{ extractor: "tree-sitter" }],
    incremental_provenance: { change_kind: "added" },
  } as typeof value.graph.nodes[number];
  value.graph.edges[0] = {
    ...value.graph.edges[0],
    source_observations: [{ extractor: "tree-sitter" }],
    incremental_provenance: { change_kind: "added" },
  } as typeof value.graph.edges[number];
  const directory = buildSnapshotQueryDirectory(
    "a".repeat(64),
    "snap:test-query",
    value,
    { fact_graph: { nodes: [], edges: [] } },
  );
  assert.equal(directory.nodes.length, 2);
  assert.equal(directory.edges.length, 1);
  assert.equal(directory.evidence.length, 1);
  assert.equal(directory.evidence_links.length, 3);
  assert.deepEqual(directory.nodes[0]?.payload, {
    attributes: { path: "src/file-a.ts", searchable_tag: "entry-tag" },
    member_count: 1,
    evidence_count: 1,
  });
  assert.deepEqual(directory.edges[0]?.payload, { evidence_count: 1 });
  assert.deepEqual(directory.evidence[0]?.payload, {});

  const first = querySnapshotQueryDirectory(directory, { limit: 1 });
  assert.equal(first.nodes.length + first.edges.length, 1);
  assert.ok(first.next_cursor);
  const second = querySnapshotQueryDirectory(directory, { limit: 10, cursor: first.next_cursor });
  assert.equal(second.nodes.length + second.edges.length, 2);
  assert.equal(second.next_cursor, null);
});

test("query directory expands adjacent nodes without changing the stored graph", () => {
  const directory = buildSnapshotQueryDirectory(
    "b".repeat(64),
    "snap:test-query",
    snapshot(),
    { fact_graph: { nodes: [], edges: [] } },
  );
  const result = querySnapshotQueryDirectory(directory, {
    text: "入口",
    expand_hops: 1,
    limit: 10,
  });
  assert.deepEqual(result.nodes.map((row) => row.node_id).sort(), ["component:a", "component:b"]);
  assert.equal(result.edges.length, 1);
  assert.equal(directory.nodes.length, 2);
});

test("query directory filters entity hierarchy and preserves overlay projections", () => {
  const value = snapshot() as any;
  value.graph.nodes[0] = {
    ...value.graph.nodes[0],
    entity_kind: "subsystem",
    parent_entity_id: null,
    depth: 0,
  };
  value.graph.nodes[1] = {
    ...value.graph.nodes[1],
    entity_kind: "component",
    parent_entity_id: "component:a",
    depth: 1,
  };
  value.graph.overlays = [{
    id: "overlay:runtime",
    kind: "runtime",
    name: "运行时",
    responsibility: "运行路径",
    member_entity_ids: ["component:b"],
    relation_ids: ["relation:a:b"],
    evidence_ids: [],
    certainty: "supported",
  }];
  value.graph.projections = {
    human: {
      kind: "human",
      snapshot_id: value.snapshot_id,
      nodes: [
        { projection_node_id: "human:component:a", entity_id: "component:a", parent_projection_node_id: null, depth: 0, aggregate_member_entity_ids: [], evidence_ids: [] },
        { projection_node_id: "human:component:b", entity_id: "component:b", parent_projection_node_id: "human:component:a", depth: 1, aggregate_member_entity_ids: [], evidence_ids: [] },
      ],
      edges: [],
      truncated: false,
      next_cursor: null,
    },
    agent: {
      kind: "agent",
      snapshot_id: value.snapshot_id,
      nodes: [],
      edges: [],
      truncated: false,
      next_cursor: null,
    },
  };
  const directory = buildSnapshotQueryDirectory("c".repeat(64), value.snapshot_id, value, { fact_graph: { nodes: [], edges: [] } });
  assert.equal(directory.nodes.find((row) => row.node_id === "component:b")?.parent_entity_id, "component:a");
  assert.equal(directory.memberships.length, 2);
  assert.equal(directory.projections.length, 2);
  assert.equal(directory.aggregates.length, 0);
  assert.deepEqual(
    querySnapshotQueryDirectory(directory, { entity_ids: ["component:a"], scope: "subtree", entity_kinds: ["subsystem", "component"], limit: 10 }).nodes.map((row) => row.node_id),
    ["component:a", "component:b"],
  );
  assert.deepEqual(
    querySnapshotQueryDirectory(directory, { entity_ids: ["component:b"], scope: "ancestors", limit: 10 }).nodes.map((row) => row.node_id),
    ["component:a", "component:b"],
  );
});

test("query directory ranks personalized entities and reports token-bound continuation", () => {
  const value = snapshot() as any;
  value.graph.nodes[0].responsibility = "x".repeat(2_000);
  const directory = buildSnapshotQueryDirectory(
    "d".repeat(64),
    value.snapshot_id,
    value,
    { fact_graph: { nodes: [], edges: [] } },
  );
  const personalized = querySnapshotQueryDirectory(directory, {
    personalized_entity_ids: ["component:b"],
    limit: 1,
  });
  assert.equal(personalized.nodes[0]?.node_id, "component:b");

  const budgeted = querySnapshotQueryDirectory(directory, {
    evidence_budget_tokens: 256,
    limit: 10,
  });
  assert.equal(budgeted.truncated, true);
  assert.equal(budgeted.truncation_reason, "item_exceeds_budget");
  assert.ok(budgeted.next_cursor);
  assert.equal(budgeted.returned_evidence_count, budgeted.evidence.length);
  const continued = querySnapshotQueryDirectory(directory, {
    evidence_budget_tokens: 256,
    limit: 10,
    cursor: budgeted.next_cursor,
  });
  assert.notEqual(continued.nodes[0]?.node_id, budgeted.nodes[0]?.node_id);
});
