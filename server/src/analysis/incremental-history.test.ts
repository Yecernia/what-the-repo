import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedFile, SourceFileManifest } from "./facts.js";
import { buildSnapshot } from "./graph.js";
import { createIncrementalHistorySelector } from "./incremental-history.js";
import { applyIncrementalProvenance, buildFullPlan, buildIncrementalPlan, createAnalysisCache } from "./incremental.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const COMPLETE = { inventoryComplete: true, knownSourceFiles: 0, omitted: [], reasons: [] };

test("streamed history preserves reuse, recomputation, additions, deletions, and renames", () => {
  const previousFiles = [
    parsed("keep.ts", A),
    parsed("closure.ts", A),
    { ...parsed("modify.ts", A), imports: [{ source: "./deleted", line: 1,
      resolvedPath: "deleted.ts", status: "static" as const }] },
    parsed("deleted.ts", B),
    parsed("old-name.ts", C),
  ];
  const currentFiles = [
    parsed("keep.ts", A),
    parsed("closure.ts", A),
    parsed("modify.ts", D),
    parsed("new.ts", A),
    parsed("new-name.ts", C),
  ];
  const { plan, expected, history } = compare(previousFiles, currentFiles, {
    forceReusePath: "keep.ts", forceRecomputePath: "closure.ts", addInactiveEndpoint: true,
  });
  assert.deepEqual(plan.changes.map(row => [row.path, row.kind]), [
    ["deleted.ts", "deleted"], ["modify.ts", "modified"],
    ["new-name.ts", "renamed"], ["new.ts", "added"],
  ]);
  assert.ok(expected.fact_graph.nodes.some(row => row.incremental_provenance?.change_kind === "reused"));
  assert.ok(expected.fact_graph.nodes.some(row => row.incremental_provenance?.change_kind === "recomputed"));
  assert.ok(expected.fact_graph.nodes.some(row => row.incremental_provenance?.change_kind === "added"));
  assert.ok(expected.fact_graph.nodes.some(row => row.incremental_provenance?.change_kind === "renamed"));
  assert.ok(history.tombstoneNodes.length > 0);
  assert.ok(history.tombstoneEdges.length > 0);
  assert.ok(history.tombstoneEdges.some(row => row.id === "old-inactive-endpoint-edge"));
});

test("failed syntax extraction leaves vanished historical facts and edges untouched", () => {
  compare([parsed("unstable.ts", A), parsed("keep.ts", B)], [
    { ...parsed("unstable.ts", C), parseError: "parser failed", semanticComplete: false },
    parsed("keep.ts", B),
  ], { addVanishedLspFacts: true });
});

test("failed semantic extraction does not tombstone vanished LSP facts or edges", () => {
  compare([parsed("unstable.ts", A), parsed("keep.ts", B)], [
    { ...parsed("unstable.ts", C), semanticComplete: false },
    parsed("keep.ts", B),
  ], { addVanishedLspFacts: true });
});

function compare(previousFiles: ParsedFile[], currentFiles: ParsedFile[], options: {
  addVanishedLspFacts?: boolean;
  addInactiveEndpoint?: boolean;
  forceReusePath?: string;
  forceRecomputePath?: string;
} = {}) {
  const previousBase = buildSnapshot({ snapshotId: "snap:previous", repository: "example/repo",
    commitSha: "1".repeat(40), files: previousFiles, sourceRoot: "/previous" });
  const previous = applyIncrementalProvenance({ snapshot: previousBase,
    previousFactGraph: null, plan: buildFullPlan(previousFiles.map(manifest)), currentParsedFiles: previousFiles });
  if (options.addVanishedLspFacts) {
    const file = previous.fact_graph.nodes.find(row => row.attributes?.path === "unstable.ts");
    const keep = previous.fact_graph.nodes.find(row => row.attributes?.path === "keep.ts");
    assert.ok(file && keep);
    previous.fact_graph.nodes.push({ ...structuredClone(file), id: "old-lsp-node",
      source_observations: [{ extractor: "lsp" }] });
    previous.fact_graph.edges.push({
      id: "old-lsp-edge", source: "old-lsp-node", target: keep.id,
      relation_kind: "calls", label: "old edge", description: "old edge",
      certainty: "observed", evidence: [], weight: 1,
      source_observations: [{ extractor: "lsp" }], lifecycle_status: "active",
      first_seen_snapshot_id: previous.snapshot_id, revision_id: "old-edge-revision",
    });
  }
  if (options.addInactiveEndpoint) {
    const deleted = previous.fact_graph.nodes.find(row => row.attributes?.path === "deleted.ts");
    const modified = previous.fact_graph.nodes.find(row => row.attributes?.path === "modify.ts");
    assert.ok(deleted && modified);
    previous.fact_graph.nodes.push({ ...structuredClone(deleted), id: "old-inactive-endpoint",
      lifecycle_status: "tombstoned" });
    previous.fact_graph.edges.push({
      id: "old-inactive-endpoint-edge", source: "old-inactive-endpoint", target: modified.id,
      relation_kind: "calls", label: "historical endpoint", description: "historical endpoint",
      certainty: "observed", evidence: [], weight: 1, lifecycle_status: "active",
      first_seen_snapshot_id: previous.snapshot_id, revision_id: "old-inactive-edge-revision",
    });
  }
  const currentBase = buildSnapshot({ snapshotId: "snap:current", repository: "example/repo",
    commitSha: "2".repeat(40), files: currentFiles, sourceRoot: "/current" });
  if (options.forceRecomputePath) {
    for (const current of currentBase.fact_graph.nodes.filter(row => row.attributes?.path === options.forceRecomputePath)) {
      const previousRow = previous.fact_graph.nodes.find(row => row.id === current.id);
      if (previousRow) previousRow.revision_id = "different-old-revision";
      else previous.fact_graph.nodes.push({ ...structuredClone(current),
        first_seen_snapshot_id: previous.snapshot_id, revision_id: "different-old-revision" });
    }
  }
  const plan = buildIncrementalPlan({ parentSnapshotId: previous.snapshot_id,
    previousCache: createAnalysisCache({ manifest: previousFiles.map(manifest), parsedFiles: previousFiles, lspResults: [] }),
    previousFactGraph: previous.fact_graph, currentManifest: currentFiles.map(manifest),
    currentCompleteness: { ...COMPLETE, knownSourceFiles: currentFiles.length } });
  if (options.forceReusePath) {
    const baseline = applyIncrementalProvenance({ snapshot: structuredClone(currentBase),
      previousFactGraph: previous.fact_graph, plan, currentParsedFiles: currentFiles });
    const revisionById = new Map(baseline.fact_graph.nodes
      .filter(row => row.attributes?.path === options.forceReusePath)
      .map(row => [row.id, row.revision_id]));
    for (const row of previous.fact_graph.nodes) {
      if (revisionById.has(row.id)) row.revision_id = revisionById.get(row.id);
    }
  }
  const expected = applyIncrementalProvenance({ snapshot: structuredClone(currentBase),
    previousFactGraph: previous.fact_graph, plan, currentParsedFiles: currentFiles });
  const selector = createIncrementalHistorySelector({ snapshot: currentBase, plan, currentParsedFiles: currentFiles });
  for (const row of previous.fact_graph.nodes) selector.addNode(row);
  for (const row of previous.fact_graph.edges) selector.addEdge(row);
  const history = selector.finish();
  assert.equal(history.nodePaths.size, previous.fact_graph.nodes.length);
  assert.ok(history.matchedNodes.every(row => Object.keys(row).every(key =>
    ["id", "revision_id", "first_seen_snapshot_id"].includes(key))));
  assert.ok(history.matchedEdges.every(row => Object.keys(row).every(key =>
    ["id", "revision_id", "first_seen_snapshot_id"].includes(key))));
  if (options.addVanishedLspFacts) {
    assert.equal(history.tombstoneNodes.some(row => row.id === "old-lsp-node"), false);
    assert.equal(history.tombstoneEdges.some(row => row.id === "old-lsp-edge"), false);
  }
  const actual = applyIncrementalProvenance({ snapshot: structuredClone(currentBase),
    previousFactGraph: history, plan, currentParsedFiles: currentFiles });
  assert.deepEqual(actual, expected);
  return { plan, expected, history };
}

function manifest(file: ParsedFile): SourceFileManifest {
  return { path: file.path, digest: file.digest, bytes: file.bytes };
}

function parsed(path: string, digest: string): ParsedFile {
  return { path, language: "typescript", bytes: 10, digest, symbols: [], imports: [], calls: [],
    parseError: null, semanticComplete: true };
}
