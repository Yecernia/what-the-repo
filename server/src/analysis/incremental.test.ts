import assert from "node:assert/strict";
import test from "node:test";
import type { LspRunResult, ParsedFile, SourceFileManifest } from "./facts.js";
import { buildSnapshot } from "./graph.js";
import { assembleIncrementalBasePayload } from "../persistence/analysis-payload.js";
import {
  activeFactFingerprint,
  applyIncrementalProvenance,
  buildFullPlan,
  buildIncrementalPlan,
  classifyFileChanges,
  createAnalysisCache,
  takeCheckpointAnalysisCache,
} from "./incremental.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const COMMIT = "1".repeat(40);

test('publication transfers compiler cache ownership without discarding its data or mutating a saved checkpoint', () => {
  const files = [parsed('main.ts', SHA_A)];
  const checkpoint = { fetched: { manifest: files.map(toManifest) }, parsed: files,
    syntax_files: files, lsp_results: [] as LspRunResult[], previous_fact_graph: null, plan: buildFullPlan(files.map(toManifest)) };
  const persisted = structuredClone(checkpoint);
  const cache = takeCheckpointAnalysisCache(checkpoint)!;
  assert.deepEqual(cache, createAnalysisCache({manifest:persisted.fetched.manifest,parsedFiles:persisted.parsed,syntaxFiles:persisted.syntax_files,lspResults:persisted.lsp_results}));
  assert.equal(Object.hasOwn(checkpoint,'parsed'),false);
  assert.equal(Object.hasOwn(checkpoint,'syntax_files'),false);
  assert.equal(Object.hasOwn(checkpoint,'previous_fact_graph'),false);
  assert.equal(checkpoint.fetched.manifest.length,1);
  assert.equal(persisted.parsed[0]!.path,'main.ts');
});

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

test("syntax reuse is separate from conservative semantic project invalidation", async () => {
  const previousFiles = [
    parsed("main.ts", SHA_A, { imports: [{ source: "./helper", line: 1, resolvedPath: "helper.ts", status: "static" }] }),
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
  const previousCache = createAnalysisCache({ manifest: previousFiles.map(toManifest), parsedFiles: previousFiles, lspResults: [] });
  const plan = buildIncrementalPlan({
    parentSnapshotId: previousSnapshot.snapshot_id,
    previousCache,
    previousFactGraph: previousSnapshot.fact_graph,
    currentManifest,
    currentCompleteness: { inventoryComplete: true, knownSourceFiles: currentManifest.length, omitted: [], reasons: [] },
  });
  assert.equal(plan.mode, "incremental");
  assert.deepEqual(plan.recomputePaths, ["helper.ts"]);
  assert.deepEqual(plan.reusedPaths, ["main.ts", "unrelated.ts"]);
  assert.deepEqual(plan.affectedPaths, ["helper.ts", "main.ts", "unrelated.ts"]);
  const projected = await assembleIncrementalBasePayload({ fact_graph: previousSnapshot.fact_graph,
    analysis_cache: previousCache }, async () => null);
  assert.deepEqual(buildIncrementalPlan({ parentSnapshotId: previousSnapshot.snapshot_id,
    previousCache, previousNodePaths: projected.node_paths, currentManifest,
    currentCompleteness: { inventoryComplete: true, knownSourceFiles: currentManifest.length, omitted: [], reasons: [] } }), plan);
});

test("incremental facts match a same-commit full build and retain explicit tombstones", () => {
  const previousFiles = [
    parsed("main.ts", SHA_A, { imports: [
      { source: "./helper", line: 1, resolvedPath: "helper.ts", status: "static" },
      { source: "./deleted", line: 2, resolvedPath: "deleted.ts", status: "static" },
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
    parsed("main.ts", SHA_A, { imports: [{ source: "./helper", line: 1, resolvedPath: "helper.ts", status: "static" }] }),
    parsed("helper.ts", SHA_C),
    parsed("new-name.ts", SHA_B),
  ];
  const plan = buildIncrementalPlan({
    parentSnapshotId: previous.snapshot_id,
    previousCache: createAnalysisCache({ manifest: previousFiles.map(toManifest), parsedFiles: previousFiles, lspResults: [] }),
    previousFactGraph: previous.fact_graph,
    currentManifest: currentFiles.map(toManifest),
    currentCompleteness: { inventoryComplete: true, knownSourceFiles: currentFiles.length, omitted: [], reasons: [] },
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

test('incomplete inventories never turn missing files or guessed renames into deletions',()=>{
 const old=parsed('old.ts',SHA_A),manifestNow=manifest([['new.ts',SHA_A]]);
 const previous=buildSnapshot({snapshotId:'old',repository:'example/repo',commitSha:COMMIT,files:[old],sourceRoot:'/none'});
 const plan=buildIncrementalPlan({parentSnapshotId:'old',previousCache:createAnalysisCache({manifest:[toManifest(old)],parsedFiles:[old],lspResults:[]}),previousFactGraph:previous.fact_graph,currentManifest:manifestNow,
  currentCompleteness:{inventoryComplete:false,knownSourceFiles:1,omitted:[],reasons:['truncated']}});
 assert.deepEqual(plan.tombstonePaths,[]);assert.equal(plan.changes[0]?.kind,'added');assert.equal(plan.changes[0]?.renamed_from,null);
});
