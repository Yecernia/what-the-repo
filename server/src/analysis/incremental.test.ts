import assert from "node:assert/strict";
import test from "node:test";
import type { LspRunResult, ParsedFile, SourceFileManifest } from "./facts.js";
import { buildSnapshot } from "./graph.js";
import {
  activeFactFingerprint,
  applyIncrementalProvenance,
  buildFullPlan,
  buildIncrementalPlan,
  classifyFileChanges,
  createAnalysisCache,
  lspTargetFiles,
  mergeLspResult,
  mergeParsedFiles,
} from "./incremental.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const COMMIT = "1".repeat(40);

test("classifies added, modified, deleted and unambiguous renamed files", () => {
  const previous = manifest([
    ["keep.ts", SHA_A],
    ["modify.ts", SHA_A],
    ["delete.ts", SHA_B],
    ["old-name.ts", SHA_C],
  ]);
  const current = manifest([
    ["keep.ts", SHA_A],
    ["modify.ts", SHA_B],
    ["new.ts", SHA_A],
    ["new-name.ts", SHA_C],
  ]);
  assert.deepEqual(classifyFileChanges(previous, current).map((item) => ({
    path: item.path,
    kind: item.kind,
    renamed_from: item.renamed_from,
  })), [
    { path: "delete.ts", kind: "deleted", renamed_from: null },
    { path: "modify.ts", kind: "modified", renamed_from: null },
    { path: "new-name.ts", kind: "renamed", renamed_from: "old-name.ts" },
    { path: "new.ts", kind: "added", renamed_from: null },
  ]);
});

test("reverse dependency closure recomputes callers and reuses unrelated files", () => {
  const previousFiles = [
    parsed("main.ts", SHA_A, { imports: [{ source: "./helper", line: 1 }] }),
    parsed("helper.ts", SHA_B),
    parsed("unrelated.ts", SHA_C),
  ];
  const previousSnapshot = withProvenance(buildSnapshot({
    snapshotId: "snap:previous",
    repository: "example/repo",
    commitSha: COMMIT,
    files: previousFiles,
    sourceRoot: "C:/snapshot",
  }), buildFullPlan(previousFiles.map(toManifest)));
  const currentManifest = manifest([
    ["main.ts", SHA_A],
    ["helper.ts", SHA_C],
    ["unrelated.ts", SHA_C],
  ]);
  const plan = buildIncrementalPlan({
    parentSnapshotId: previousSnapshot.snapshot_id,
    previousCache: createAnalysisCache({ manifest: previousFiles.map(toManifest), parsedFiles: previousFiles, lspResults: [] }),
    previousFactGraph: previousSnapshot.fact_graph,
    currentManifest,
  });
  assert.equal(plan.mode, "incremental");
  assert.deepEqual(plan.recomputePaths, ["helper.ts", "main.ts"]);
  assert.deepEqual(plan.reusedPaths, ["unrelated.ts"]);
  assert.deepEqual(lspTargetFiles(previousFiles, "typescript", plan).map((file) => file.path), ["main.ts", "helper.ts"]);
});

test("parsed and LSP caches retain unaffected facts while replacing affected paths", () => {
  const oldMain = parsed("main.ts", SHA_A);
  const oldHelper = parsed("helper.ts", SHA_B);
  const freshHelper = parsed("helper.ts", SHA_C);
  const plan = {
    ...buildFullPlan([toManifest(oldMain), toManifest(freshHelper)]),
    mode: "incremental" as const,
    parentSnapshotId: "snap:previous",
    affectedPaths: ["helper.ts"],
    recomputePaths: ["helper.ts"],
    reusedPaths: ["main.ts"],
  };
  const merged = mergeParsedFiles({
    previous: [oldMain, oldHelper],
    recomputed: [freshHelper],
    currentManifest: [toManifest(oldMain), toManifest(freshHelper)],
    plan,
  });
  assert.deepEqual(merged.map((file) => [file.path, file.digest]), [
    ["main.ts", SHA_A],
    ["helper.ts", SHA_C],
  ]);

  const previousLsp = lspResult([
    ["main.ts", "main"],
    ["helper.ts", "helper"],
  ]);
  const freshLsp = lspResult([["helper.ts", "helperV2"]]);
  const lsp = mergeLspResult({
    language: "typescript",
    previous: previousLsp,
    fresh: freshLsp,
    invalidatedPaths: new Set(["helper.ts"]),
    currentPaths: new Set(["main.ts", "helper.ts"]),
  });
  assert.deepEqual(lsp.symbols.map((symbol) => [symbol.path, symbol.name]), [
    ["main.ts", "main"],
    ["helper.ts", "helperV2"],
  ]);
  assert.ok(lsp.reasonCodes.includes("incremental_reuse"));
  for (const previous of [null, previousLsp]) {
    const full = mergeLspResult({ language: "typescript", previous, fresh: freshLsp,
      invalidatedPaths: new Set(["main.ts", "helper.ts"]), currentPaths: new Set(["helper.ts"]) });
    assert.ok(!full.reasonCodes.includes("incremental_reuse"), "fresh-only facts must not claim reuse");
  }
});

test("incremental facts match a same-commit full build and retain explicit tombstones", () => {
  const previousFiles = [
    parsed("main.ts", SHA_A, { imports: [
      { source: "./helper", line: 1 },
      { source: "./deleted", line: 2 },
    ] }),
    parsed("helper.ts", SHA_B),
    parsed("deleted.ts", SHA_C),
    parsed("old-name.ts", SHA_B),
  ];
  const previous = withProvenance(buildSnapshot({
    snapshotId: "snap:previous",
    repository: "example/repo",
    commitSha: COMMIT,
    files: previousFiles,
    sourceRoot: "C:/previous",
  }), buildFullPlan(previousFiles.map(toManifest)));
  const currentFiles = [
    parsed("main.ts", SHA_A, { imports: [{ source: "./helper", line: 1 }] }),
    parsed("helper.ts", SHA_C),
    parsed("new-name.ts", SHA_B),
  ];
  const plan = buildIncrementalPlan({
    parentSnapshotId: previous.snapshot_id,
    previousCache: createAnalysisCache({ manifest: previousFiles.map(toManifest), parsedFiles: previousFiles, lspResults: [] }),
    previousFactGraph: previous.fact_graph,
    currentManifest: currentFiles.map(toManifest),
  });
  const incremental = applyIncrementalProvenance({
    snapshot: buildSnapshot({
      snapshotId: "snap:current",
      repository: "example/repo",
      commitSha: "2".repeat(40),
      files: currentFiles,
      sourceRoot: "C:/current",
    }),
    previousFactGraph: previous.fact_graph,
    plan,
    currentParsedFiles: currentFiles,
  });
  const full = withProvenance(buildSnapshot({
    snapshotId: "snap:full-current",
    repository: "example/repo",
    commitSha: "2".repeat(40),
    files: currentFiles,
    sourceRoot: "C:/current",
  }), buildFullPlan(currentFiles.map(toManifest)));
  assert.equal(activeFactFingerprint(incremental), activeFactFingerprint(full));
  assert.ok(incremental.fact_graph.nodes.some((node) =>
    node.lifecycle_status === "tombstoned" && node.attributes?.path === "deleted.ts"));
  assert.ok(incremental.fact_graph.nodes.some((node) =>
    node.lifecycle_status === "tombstoned"
    && node.attributes?.path === "old-name.ts"
    && typeof node.superseded_by === "string"));
  assert.ok(incremental.fact_graph.edges.some((edge) => edge.lifecycle_status === "tombstoned"));
  assert.equal(incremental.parent_snapshot_id, "snap:previous");
  assert.equal(incremental.analysis_mode, "incremental");
});

function manifest(rows: Array<[string, string]>): SourceFileManifest[] {
  return rows.map(([path, digest]) => ({ path, digest, bytes: 10 }));
}

function toManifest(file: ParsedFile): SourceFileManifest {
  return { path: file.path, digest: file.digest, bytes: file.bytes };
}

function parsed(
  path: string,
  digest: string,
  patch: Partial<Pick<ParsedFile, "imports" | "calls">> = {},
): ParsedFile {
  return {
    path,
    language: "typescript",
    bytes: 10,
    digest,
    symbols: [],
    imports: patch.imports ?? [],
    calls: patch.calls ?? [],
    parseError: null,
  };
}

function lspResult(rows: Array<[string, string]>): LspRunResult {
  return {
    language: "typescript",
    completed: true,
    truthVerified: true,
    serverName: "typescript-language-server",
    serverVersion: "1",
    capabilities: ["document_symbols"],
    reasonCodes: [],
    symbols: rows.map(([path, name]) => ({
      path,
      name,
      qualifiedName: name,
      kind: "function",
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: name.length,
    })),
    relations: [],
  };
}

function withProvenance(
  snapshot: ReturnType<typeof buildSnapshot>,
  plan: ReturnType<typeof buildFullPlan>,
): ReturnType<typeof buildSnapshot> {
  return applyIncrementalProvenance({
    snapshot,
    previousFactGraph: null,
    plan,
    currentParsedFiles: snapshot.fact_graph.nodes
      .filter((node) => node.id.startsWith("fact:file:"))
      .map((node) => parsed(
        String(node.attributes?.path ?? ""),
        String(node.attributes?.content_digest ?? ""),
      )),
  });
}
