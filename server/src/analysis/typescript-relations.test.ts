import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ParsedFile } from "./facts.js";
import { analyzeTypeScriptTexts as bindTypeScriptTexts, analyzeTypeScript as bindTypeScriptRelations, createCompilerWorkspace } from "./typescript.js";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { decodeSource } from "./source-input.js";
import { buildSnapshot } from "./graph.js";
import { createAnalysisCache, readAnalysisCache } from "./incremental.js";

function filesFor(sources: Record<string, string>): ParsedFile[] {
  return Object.entries(sources).map(([path, content]) => ({
    path, language: /\.[cm]?jsx?$/.test(path) ? "javascript" : /\.tsx?$/.test(path) ? "typescript" : "unknown",
    bytes: Buffer.byteLength(content), digest: createHash("sha256").update(content).digest("hex"),
    symbols: [], imports: [], calls: [], parseError: null,
  }));
}
async function bind(sources: Record<string, string>) {
  return bindTypeScriptTexts(filesFor(sources), new Map(Object.entries(sources).map(([path, content]) => ["/repository/" + path, content])));
}

test("deferred import expressions are module dependencies rather than callable symbols", async () => {
  const files = await bind({
    "main.ts": "export const deferred = import.defer('./other.js'); export const eager = import('./other.js');",
    "other.ts": "export const answer = 42;",
  });
  const main = files.find(file => file.path === "main.ts")!;
  assert.equal(main.parseError, null);
  assert.equal(main.imports.length, 2);
  assert.ok(main.imports.every(row => row.kind === "dynamic_imports" && row.resolvedPath === "other.ts"));
  assert.equal(main.calls.length, 0);
});

test("deep binary expressions preserve syntax ownership, imports and heritage without call-stack recursion", async () => {
  const expression = Array.from({length:18_000},()=>"1").join(" + ");
  const text = `import { target, Base } from './other.js';
    export function outer() { const sum = ${expression}; return target(sum); }
    export class Derived extends Base { run() { return target(1); } }`;
  const syntax = await new TreeSitterAnalyzer().analyzeDecoded(decodeSource('main.ts',Buffer.from(text)));
  assert.equal(syntax.parseError,null);
  const outer = syntax.symbols.find(row=>row.name==='outer')!;
  assert.ok(outer);
  assert.equal(syntax.calls.find(row=>row.callee==='target')?.callerStableId,outer.stableId);
  const files = await bind({'main.ts':text,'other.ts':'export function target(x: number) { return x; } export class Base {}'});
  const main=files.find(file=>file.path==='main.ts')!;
  assert.equal(main.parseError,null);
  assert.equal(main.imports[0]?.resolvedPath,'other.ts');
  assert.equal(main.calls.filter(call=>call.target?.path==='other.ts').length,2);
  assert.equal(main.heritage?.length,1);
  assert.equal(main.symbols.find(row=>row.name==='outer')?.stableId,outer.stableId);
});

test("compiler directory lookup retains virtual outputs and snapshot-only config resolution", () => {
  const texts = new Map([
    ["/repository/pkg/package.json", JSON.stringify({ name: "@example/pkg" })],
    ["/repository/pkg/tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "lib", declarationDir: "types" } })],
    ["/repository/pkg/src/index.ts", "export const value = 1;"],
  ]);
  const workspace = createCompilerWorkspace(texts);
  for (const path of ["/repository/pkg/src", "/repository/pkg/lib", "/repository/pkg/types", "/repository/node_modules/@example/pkg/src", "/repository/node_modules/@missing"])
    assert.equal(workspace.directoryExists(path), true, path);
  for (const path of ["/repository/pkg/missing", "/repository/pkg/lib/missing", "/outside/private"])
    assert.equal(workspace.directoryExists(path), false, path);
  assert.equal(workspace.getParsedCommandLine("/repository/pkg/src/../tsconfig.json"), workspace.projects.find(p => p.context.configPath === "pkg/tsconfig.json")?.parsed);
  assert.equal(workspace.getParsedCommandLine("/outside/tsconfig.json"), undefined);
  texts.set("/repository/pkg/tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }));
  const next = createCompilerWorkspace(texts);
  assert.equal(next.directoryExists("/repository/pkg/lib"), false);
  assert.equal(next.directoryExists("/repository/pkg/dist"), true);
});

test("output prefix lookup checks every ancestor and preserves ambiguous mappings", () => {
  const texts = new Map([
    ["/repository/a/tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "../build" } })],
    ["/repository/b/tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "../build/nested", declarationDir: "../build" } })],
    ["/repository/a/src/nested/index.ts", "export const a = 1;"],
    ["/repository/a/src/shared.ts", "export const a = 1;"],
    ["/repository/b/src/index.ts", "export const b = 2;"],
    ["/repository/b/src/shared.ts", "export const b = 2;"],
    ["/repository/a/src/unique.ts", "export const unique = 3;"],
    ["/repository/build/actual.js", "export const actual = 4;"],
  ]);
  const { canonical } = createCompilerWorkspace(texts);
  assert.equal(canonical("/repository/build/nested/index.js"), "/repository/build/nested/index.js");
  assert.equal(canonical("/repository/build/shared.d.ts"), "/repository/build/shared.d.ts");
  assert.equal(canonical("/repository/build/unique.d.ts"), "/repository/a/src/unique.ts");
  assert.equal(canonical("/repository/build/actual.js"), "/repository/build/actual.js");
  assert.equal(canonical("/repository/build/missing.js"), "/repository/build/missing.js");
});

test("compiler binding distinguishes imports, aliases, namespace calls, receivers and parameter shadowing", async () => {
  const files = await bind({
    "src/launcher.ts": "export function probe() { return true; } export class Launcher { run() { return 1; } }",
    "src/barrel.ts": "export { probe } from './launcher.js';",
    "src/other.ts": "export function probe() { return false; } export class Other { run() { return 2; } test() { return false; } }",
    "src/main.ts": "import {probe as check, Launcher} from './launcher.js';\nimport * as api from './barrel.js';\nconst launcher = new Launcher();\ncheck(); api.probe(); launcher.run();\nexport function shadow(probe: () => boolean) { return probe(); }\n/abc/.test('abc');\nexport function unknown(value: any) { value.run(); }",
  });
  const main = files.find((file) => file.path === "src/main.ts")!;
  for (const name of ["check", "api.probe", "launcher.run"]) {
    assert.equal(main.calls.find((call) => call.callee === name)?.target?.path, "src/launcher.ts", name);
  }
  for (const name of ["probe", "/abc/.test", "value.run"]) assert.equal(main.calls.find((call) => call.callee === name)?.target, null, name);
  assert.equal(main.imports[0]!.resolvedPath, "src/launcher.ts");
  const snapshot = buildSnapshot({ snapshotId: "binding", repository: "example/binding", commitSha: "a".repeat(40), files, sourceRoot: "/unused" });
  assert.equal(snapshot.summary.unresolved_syntax_call_count, 2);
  assert.equal(main.calls.find(call => call.callee === "/abc/.test")?.status, "standard_library");
  assert.ok(snapshot.fact_graph.edges.some((edge) => edge.relation_kind === "calls" && edge.certainty === "verified"));
  assert.ok(!snapshot.fact_graph.edges.some((edge) => edge.relation_kind === "calls" && edge.evidence[0]?.path === "src/other.ts"));
});

test("workspace exports resolve through explicitly declared build output without running package scripts", async () => {
  const files = await bind({
    "native/entry/package.json": JSON.stringify({ name: "@example/launcher", exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" } }, scripts: { build: "throw new Error('must not execute')" } }),
    "native/entry/tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "lib" }, plugins: [{ name: "must-not-load" }] }),
    "native/entry/src/index.ts": "export function launcherPath() { return '/bin/launcher'; }",
    "packages/sandbox/index.ts": "import { launcherPath as launcher } from '@example/launcher';\nexport function start() { return launcher(); }",
  });
  const sandbox = files.find((file) => file.path === "packages/sandbox/index.ts")!;
  assert.equal(sandbox.imports[0]!.resolvedPath, "native/entry/src/index.ts");
  assert.equal(sandbox.calls.find((call) => call.callee === "launcher")?.target?.path, "native/entry/src/index.ts");
});

test("unavailable packages and outside-manifest imports remain unresolved instead of matching names", async () => {
  const files = await bind({
    "main.ts": "import {probe} from 'missing'; import {read} from '../private.ts';\nprobe(); read();",
    "unrelated.ts": "export function probe() { return true; } export function read() { return 1; }",
  });
  assert.ok(files[0]!.calls.every((call) => call.target === null));
  assert.ok(files[0]!.imports.every((item) => item.resolvedPath === null));
});

test("overloads bind their implementation while union receivers and reassigned aliases remain unresolved", async () => {
  const files = await bind({
    "lib.ts": "export function probe(value: string): boolean; export function probe(value: number): boolean; export function probe(value: unknown) { return true; }\nexport const arrow = () => true; export class A { run() { return 1; } } export class B { run() { return 2; } }",
    "main.ts": "import {probe, arrow, A, B} from './lib.js';\nprobe(1); arrow(); const stable = probe; stable(1);\nlet changing = probe; changing = arrow; changing(1);\nexport function union(value: A | B) { value.run(); }",
  });
  const calls = files[1]!.calls;
  for (const name of ["probe", "arrow", "stable"]) assert.equal(calls.find((call) => call.callee === name)?.target?.path, "lib.ts", name);
  for (const name of ["changing", "value.run"]) assert.equal(calls.find((call) => call.callee === name)?.target, null, name);
});

test("documentation examples stay file evidence and cannot create call or import edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "binding-docs-"));
  try {
    await writeFile(join(root, "README.md"), "Example: import { probe } from './main'; probe();");
    await writeFile(join(root, "main.ts"), "export function probe() { return true; }");
    const parser = new TreeSitterAnalyzer(); await parser.init();
    const doc = await parser.analyzeFile(root, "README.md");
    assert.deepEqual(doc.calls, []); assert.deepEqual(doc.imports, []);
    const code = await parser.analyzeFile(root, "main.ts");
    const snapshot = buildSnapshot({ snapshotId: "docs", repository: "example/docs", commitSha: "a".repeat(40), files: [doc, code], sourceRoot: root });
    assert.equal(snapshot.summary.file_count, 2);
    assert.equal(snapshot.summary.call_count, 0);
    assert.equal(snapshot.static_analysis?.files.find(file => file.path === "README.md")?.syntax_completed, false);
    assert.equal(snapshot.static_analysis?.coverage.syntax_files_completed, 1);
    assert.ok(snapshot.fact_graph.nodes.some((node) => node.attributes?.path === "README.md"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("filesystem binding verifies safe source digests and caches preserve explicit unresolved targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "binding-source-"));
  try {
    const sources = { "src/main.ts": "export function run(value: any) { value.test(); }" };
    await mkdir(join(root, "src")); await writeFile(join(root, "src/main.ts"), sources["src/main.ts"]);
    const parser = new TreeSitterAnalyzer(); await parser.init();
    const parsed = await parser.analyzeFile(root, "src/main.ts");
    const files = await bindTypeScriptRelations([parsed], root);
    const manifest = files.map(({ path, bytes, digest }) => ({ path, bytes, digest }));
    const cache = createAnalysisCache({ manifest, parsedFiles: files, lspResults: [] });
    assert.equal(readAnalysisCache(cache)?.parsed_files[0]?.calls[0]?.target, null);
    assert.equal(readAnalysisCache({ ...cache, schema_version: "analysis-cache-v1" }), null);
    await writeFile(join(root, "src/main.ts"), "changed");
    await assert.rejects(bindTypeScriptRelations(filesFor(sources), root), /digest_mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compiler declaration binding retains the real symbol id despite export modifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "binding-symbol-"));
  try {
    await writeFile(join(root, "lib.ts"), "export function probe() { return true; }\n");
    await writeFile(join(root, "main.ts"), "import { probe } from './lib.js';\nprobe();\n");
    const parser = new TreeSitterAnalyzer(); await parser.init();
    const parsed = await Promise.all(["lib.ts", "main.ts"].map((path) => parser.analyzeFile(root, path)));
    const bound = await bindTypeScriptRelations(parsed, root);
    const symbol = parsed[0]!.symbols.find((row) => row.name === "probe")!;
    assert.equal(bound[1]!.calls[0]!.target?.symbolId, symbol.stableId);
    const snapshot = buildSnapshot({ snapshotId: "symbol", repository: "example/symbol", commitSha: "a".repeat(40), files: bound, sourceRoot: root });
    assert.ok(snapshot.fact_graph.edges.some((edge) => edge.relation_kind === "calls" && edge.target === symbol.stableId));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compiler binding retains shared dependencies and covers every entry file", async () => {
  const sources: Record<string, string> = { "shared.ts": "export function shared() { return true; }" };
  for (let index = 0; index < 130; index++) sources[`entry${index}.ts`] = "import {shared} from './shared.js'; shared();";
  const files = await bind(sources);
  assert.equal(files.length, 131);
  assert.ok(files.slice(1).every((file) => file.calls[0]?.target?.path === "shared.ts"));
});
