import assert from "node:assert/strict";
import test from "node:test";
import { applySnapshotLanguageOverlay, SNAPSHOT_LANGUAGE_OVERLAY_VERSION, type SnapshotLanguageOverlayPayload } from "./snapshot-language.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "./snapshot.js";
import { conversationSummaryFromSource, conversationSummarySource, MAX_CONVERSATION_SUMMARY_BYTES } from "./conversation-summary.js";

function fixture(): EvidenceSnapshot {
  const evidence = (index: number): SnapshotEvidence => ({ stable_id: `evidence:${index}`, label: `Evidence ${index}`,
    path: "src/example.ts", start_line: index, end_line: index, kind: "source" });
  return {
    snapshot_id: "snapshot:summary",
    summary: { files: 23 },
    languages: [{ language: "TypeScript", quality_tier: "complete", files_seen: 23,
      files_analyzed: 23, files_failed: 0, reason_codes: [] }],
    static_analysis: { schema_version: "project-facts-v1", position_encoding: "utf-16", range_end: "exclusive",
      completeness: { inventoryComplete: true, knownSourceFiles: 23, omitted: [], reasons: [] },
      projects: [], files: [], coverage: { discovered_call_sites: 0, call_statuses: {},
        syntax_files_completed: 23, semantic_files_completed: 23 }, limitations: ["fixture limitation"] },
    graph: {
      semantic_mode: "model_supported", edges: [], layers: [{ id: "layer:main", name: "Base layer",
        responsibility: "Base", component_ids: [], evidence: [], certainty: "provider_supported" }],
      unassigned_component_ids: [],
      nodes: [
        { id: "repository:root", name: "Repository", responsibility: "Root", architecture_layer_id: null,
          architecture_layer_name: null },
        ...Array.from({ length: 23 }, (_, index) => ({ id: `component:${index}`, name: `Base ${index}`,
          responsibility: `Responsibility ${index}`, architecture_layer_id: "layer:main",
          architecture_layer_name: "Base layer" })),
      ] as EvidenceSnapshot["graph"]["nodes"],
    },
    value_points: Array.from({ length: 10 }, (_, index) => ({ stable_id: `value:${index}`, kind: "architecture",
      title: `Base value ${index}`, claim: `Claim ${index}`, problem: "Problem", implementation: "Implementation",
      tradeoffs: "Tradeoffs", transfer_conditions: "Transfer", certainty: "provider_supported",
      component_ids: [`component:${index}`], evidence: Array.from({ length: 8 }, (_, item) => evidence(index * 10 + item)),
      connectivity: index })),
    learning_plan: { snapshot_id: "snapshot:summary", selected_value_point: null, steps: [] },
  };
}

test("conversation summary matches the old overview and values projection, including overlay and bounds", () => {
  const snapshot = fixture();
  const overlay = {
    schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION, language: "zh-CN", generated_at: "2026-09-23T00:00:00Z",
    components: snapshot.graph.nodes.map(node => ({ id: node.id, name: `名称 ${node.id}`,
      responsibility: `职责 ${node.id}`, grouping_rationale: "", architecture_layer_rationale: null })),
    layers: [{ id: "layer:main", name: "主层", responsibility: "职责" }], relations: [],
    value_points: snapshot.value_points.map(point => ({ stable_id: point.stable_id, title: `价值 ${point.stable_id}`,
      claim: `结论 ${point.stable_id}`, problem: "问题", implementation: "实现", tradeoffs: "权衡", transfer_conditions: "适用" })),
  } satisfies SnapshotLanguageOverlayPayload;
  for (const localized of [null, overlay]) {
    const full = localized ? applySnapshotLanguageOverlay(snapshot, localized) : snapshot;
    const expected = {
      snapshot_id: full.snapshot_id, summary: full.summary, languages: full.languages,
      source_completeness: full.static_analysis?.completeness,
      static_limitations: full.static_analysis?.limitations,
      semantic_mode: full.graph.semantic_mode,
      components: full.graph.nodes.filter(node => node.id.startsWith("component:")).slice(0, 20).map(node => ({
        id: node.id, name: node.name, responsibility: node.responsibility, layer: node.architecture_layer_name,
      })),
      value_points: full.value_points.slice(0, 8).map(point => ({ ...point, evidence: point.evidence.slice(0, 6) })),
    };
    assert.deepEqual(conversationSummaryFromSource(snapshot, localized), expected);
    assert.equal(expected.components.length, 20);
    assert.equal(expected.value_points.length, 8);
    assert.ok(expected.value_points.every(point => point.evidence.length === 6));
  }
});

test("conversation summary rejects empty placeholders and keeps empty collections", () => {
  assert.equal(conversationSummaryFromSource({}), null);
  const snapshot = fixture();
  snapshot.graph.nodes = [];
  snapshot.value_points = [];
  assert.deepEqual(conversationSummaryFromSource(snapshot)?.components, []);
  assert.deepEqual(conversationSummaryFromSource(snapshot)?.value_points, []);
});

test("publication summary bounds UTF-8 bytes, nested metadata and oversized localized prose", () => {
  const snapshot = fixture();
  const original = structuredClone(snapshot);
  snapshot.graph.nodes.forEach(node => { node.responsibility = "复杂😀".repeat(20_000); });
  snapshot.value_points.forEach(point => {
    point.claim = "详细解释😀".repeat(20_000);
    point.component_ids = Array(10_000).fill("component:long");
  });
  snapshot.static_analysis!.limitations = Array(100).fill("限制😀".repeat(10_000));
  const source = conversationSummarySource(snapshot)!;
  assert.ok(Buffer.byteLength(JSON.stringify(source, null, 1)) <= MAX_CONVERSATION_SUMMARY_BYTES);
  assert.ok(source.graph.nodes.every(node => Buffer.byteLength(node.responsibility) <= 1024));
  assert.ok(snapshot.graph.nodes[1]!.responsibility.length > 1024, "the full canonical view is not mutated");
  const overlay = {
    schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION, language: "zh-CN", generated_at: "2026-09-27T00:00:00Z",
    components: original.graph.nodes.map(node => ({ id: node.id, name: "名称".repeat(10_000),
      responsibility: "职责".repeat(10_000), grouping_rationale: "", architecture_layer_rationale: null })),
    layers: [], relations: [], value_points: [],
  } satisfies SnapshotLanguageOverlayPayload;
  const result = conversationSummaryFromSource(original, overlay)!;
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 1)) <= MAX_CONVERSATION_SUMMARY_BYTES);
  assert.ok(result.components.every(node => Buffer.byteLength(node.name) <= 1024));
  assert.equal(JSON.stringify(result).includes("\ufffd"), false, "UTF-8 truncation preserves characters");
});

test("bounded context never truncates evidence paths, identifiers or component references", () => {
  const snapshot = fixture();
  const tooLong = "identifier:" + "长".repeat(1000);
  snapshot.graph.nodes[1]!.architecture_layer_id = tooLong;
  snapshot.value_points[0]!.evidence[0]!.path = "src/" + "目录".repeat(1000) + "/file.ts";
  snapshot.value_points[0]!.evidence[1]!.stable_id = tooLong;
  snapshot.value_points[1]!.component_ids = [tooLong];
  const source = conversationSummarySource(snapshot)!;
  assert.equal(source.graph.nodes.some(node => node.id === "component:0"), false);
  assert.equal(source.value_points.some(point => point.stable_id === "value:1"), false);
  assert.deepEqual(source.value_points[0]!.evidence.map(row => row.stable_id),
    snapshot.value_points[0]!.evidence.slice(2, 6).map(row => row.stable_id));
  assert.ok(source.value_points[0]!.evidence.every(row => row.path === "src/example.ts"));
});
