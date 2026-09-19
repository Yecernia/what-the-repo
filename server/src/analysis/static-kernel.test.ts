import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { decodeSource, bytesDigest } from "./source-input.js";
import { analyzeStaticSource } from "./static-kernel.js";
import { analyzeTypeScriptTexts } from "./typescript.js";
import { buildSnapshot } from "./graph.js";
import { activeFactFingerprint, createAnalysisCache } from "./incremental.js";

const snapshot = (
  files: Awaited<ReturnType<typeof analyzeStaticSource>>["files"],
) =>
  buildSnapshot({
    snapshotId: "test",
    repository: "test/kernel",
    commitSha: "a".repeat(40),
    files,
    sourceRoot: "/unused",
  });
async function tsFiles(sources: Record<string, string>) {
  const files = Object.entries(sources).map(
    ([path, text]) => decodeSource(path, Buffer.from(text)).file,
  );
  return analyzeTypeScriptTexts(
    files,
    new Map(Object.entries(sources).map(([p, t]) => ["/repository/" + p, t])),
  );
}
const fixtures: Record<
  string,
  { source: string; symbols: string[]; caller: string; callee: string }
> = {
  "main.py": {
    source:
      'class Service:\n    def run(self):\n        target()\ndef target():\n    pass\n# ghost()\nx = "ghost()"\n',
    symbols: ["Service", "run", "target"],
    caller: "run",
    callee: "target",
  },
  "main.go": {
    source:
      "package main\ntype Service struct {}\nfunc (s *Service) Run() { target() }\nfunc target() {}\n// ghost()\n",
    symbols: ["Service", "Run", "target"],
    caller: "Run",
    callee: "target",
  },
  "Main.java": {
    source:
      "class Main { void run() { target(); } void target() {} void target(int x) {} } // ghost()",
    symbols: ["Main", "run", "target", "target"],
    caller: "run",
    callee: "target",
  },
  "main.rs": {
    source:
      "struct Service {}\nimpl Service { fn run(&self) { target(); } }\nfn target() {}\n// ghost()",
    symbols: ["Service", "run", "target"],
    caller: "run",
    callee: "target",
  },
  "main.php": {
    source:
      "<?php class Service { function run() { target(); } } function target() {} // ghost()",
    symbols: ["Service", "run", "target"],
    caller: "run",
    callee: "target",
  },
  "Main.cs": {
    source:
      "class Service { void Run() { Target(); } void Target() {} } // ghost()",
    symbols: ["Service", "Run", "Target"],
    caller: "Run",
    callee: "Target",
  },
  "main.cpp": {
    source:
      "namespace api { void target() {} void run() { target(); } void run(int x) {} } // ghost()",
    symbols: ["api", "target", "run", "run"],
    caller: "run",
    callee: "target",
  },
  "main.c": {
    source: "void target(void) {} void run(void) { target(); } /* ghost() */",
    symbols: ["target", "run"],
    caller: "run",
    callee: "target",
  },
};

test("calls to malformed declarations never claim a static target", async () => {
  const [file] = await tsFiles({ "main.ts": "bad(); function bad() { const x = ; }" });
  assert.ok(file?.parseError);
  const call = file.calls.find(call => call.callee === "bad")!;
  assert.equal(call.target, null);
  assert.equal(call.status, "unresolved");
  assert.equal(call.meaning, "syntax");
});
for (const [path, fixture] of Object.entries(fixtures))
  test(`native grammar ${path} retains exact scopes and unresolved syntax sites`, async () => {
    const file = await new TreeSitterAnalyzer().analyzeBytes(
      path,
      Buffer.from(fixture.source),
    );
    assert.equal(file.parseError, null, JSON.stringify(file.diagnostics));
    assert.deepEqual(
      file.symbols.map((s) => s.name).sort(),
      [...fixture.symbols].sort(),
    );
    assert.equal(
      new Set(file.symbols.map((s) => s.stableId)).size,
      file.symbols.length,
    );
    assert.equal(file.calls.length, 1);
    const call = file.calls[0]!;
    assert.equal(call.callee, fixture.callee);
    assert.equal(
      file.symbols.find((s) => s.stableId === call.callerStableId)?.name,
      fixture.caller,
    );
    if (path.endsWith(".py")) {
      assert.equal(call.status, "candidate");
      assert.equal(
        call.target?.symbolId,
        file.symbols.find((s) => s.name === "target")?.stableId,
      );
    } else {
      assert.equal(call.status, "unresolved");
      assert.equal(call.target, null);
    }
    const graph = snapshot([file]);
    assert.equal(
      graph.fact_graph.edges.filter((e) => e.relation_kind === "calls").length,
      path.endsWith(".py") ? 1 : 0,
    );
    assert.ok(
      graph.fact_graph.edges
        .filter((e) => e.relation_kind === "calls")
        .every((e) => e.certainty === "degraded"),
    );
    assert.deepEqual(graph.static_analysis?.files[0]?.calls, [call]);
  });
test("compiler overload entities, declarations, arrows and anonymous scopes are native and distinct", async () => {
  const files = await tsFiles({
    "main.mts":
      "export function f(x:string):void; export function f(x:number):void; export function f(x:unknown) {}\nconst run = () => f(1);\n[1].map(() => f(2));\n{ function f() {} f(); }",
  });
  const file = files[0]!,
    group = file.symbols.find((s) => s.name === "f")!;
  assert.equal(group.declarations?.length, 3);
  assert.equal(
    group.declarations.filter((d) => d.role === "definition").length,
    1,
  );
  const run = file.symbols.find((s) => s.name === "run")!,
    anon = file.symbols.find((s) => s.name === "<anonymous>")!;
  assert.ok(
    file.calls.some(
      (c) =>
        c.callerStableId === run.stableId &&
        c.target?.symbolId === group.stableId,
    ),
  );
  assert.ok(
    file.calls.some(
      (c) =>
        c.callerStableId === anon.stableId &&
        c.target?.symbolId === group.stableId,
    ),
  );
  const inner = file.symbols.filter((s) => s.name === "f")[1]!;
  assert.notEqual(group.stableId, inner.stableId);
  assert.ok(file.calls.some((c) => c.target?.symbolId === inner.stableId));
});
test("compiler config inheritance uses config-relative paths and separates independent project options", async () => {
  const files = await tsFiles({
    "config/base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "..",
        paths: { "@lib": ["lib.ts"] },
        module: "esnext",
        moduleResolution: "bundler",
      },
    }),
    "app/tsconfig.json": JSON.stringify({
      extends: "../config/base.json",
      include: ["*.ts"],
    }),
    "app/main.ts": "import {f} from '@lib'; export const run=()=>f();",
    "lib.ts": "export function f() {}",
    "other/tsconfig.json": JSON.stringify({
      compilerOptions: { noResolve: true },
      files: ["main.ts"],
    }),
    "other/main.ts": "import {f} from '@lib'; f();",
  });
  const app = files.find((f) => f.path === "app/main.ts")!,
    other = files.find((f) => f.path === "other/main.ts")!;
  assert.equal(app.imports[0]?.resolvedPath, "lib.ts");
  assert.equal(app.calls[0]?.target?.path, "lib.ts");
  assert.equal(other.imports[0]?.resolvedPath, null);
  assert.notEqual(app.project?.id, other.project?.id);
});
test("positions are UTF-16 half-open with non-BMP text, Chinese names, CRLF and same-line declarations", async () => {
  const source =
    'const text="😀"; function 中文() {} function run() { 中文(); }\r\n';
  const file = (await tsFiles({ "main.ts": source }))[0]!,
    call = file.calls[0]!;
  assert.equal(call.column, source.lastIndexOf("中文"));
  assert.equal(call.range?.endColumn, call.column + 4);
  const py = 'text="😀"; 中文()\r\n';
  const parsed = await new TreeSitterAnalyzer().analyzeBytes(
    "main.py",
    Buffer.from(py),
  );
  assert.equal(parsed.calls[0]?.column, py.indexOf("中文"));
  assert.equal(parsed.calls[0]?.range?.endColumn, py.indexOf("中文") + 4);
});
test("syntax recovery and invalid encoding preserve valid facts and original byte identity", async () => {
  const parser = new TreeSitterAnalyzer();
  const broken = await parser.analyzeBytes(
    "main.py",
    Buffer.from("def valid():\n    pass\ndef broken(:\n"),
  );
  assert.equal(broken.parseError, "syntax_error_recovery");
  assert.equal(broken.symbols.find((s) => s.name === "valid")?.valid, true);
  assert.equal(broken.symbols.find((s) => s.name === "broken")?.valid, false);
  const raw = Buffer.from([35, 255, 10]),
    file = await parser.analyzeBytes("bad.py", raw);
  assert.equal(file.digest, bytesDigest(raw));
  assert.equal(file.encoding, "invalid_utf8");
  assert.equal(file.symbols.length, 0);
});
test("incremental/full facts agree across unresolved imports becoming resolvable, config edits, moves and deletions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-kernel-"));
  try {
    let cache: ReturnType<typeof createAnalysisCache> | null = null;
    const revisions: Record<string, string>[] = [
      {
        "app/tsconfig.json": '{"include":["*.ts"]}',
        "app/main.ts": "import {f} from './lib.js'; export const run=()=>f();",
      },
      {
        "app/tsconfig.json": '{"include":["*.ts"]}',
        "app/main.ts": "import {f} from './lib.js'; export const run=()=>f();",
        "app/lib.ts": "export function f() {}",
      },
      {
        "app/tsconfig.json":
          '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
        "app/main.ts":
          "import {f} from './moved.js'; export const run=()=>f();",
        "app/moved.ts": "export function f() {}",
      },
      {
        "app/tsconfig.json": '{"include":["*.ts"]}',
        "app/main.ts":
          "import {f} from './moved.js'; export const run=()=>f();",
      },
    ];
    for (const revision of revisions) {
      for (const [path, text] of Object.entries(revision)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const manifest = Object.entries(revision).map(([path, text]) => ({
        path,
        bytes: Buffer.byteLength(text),
        digest: bytesDigest(text),
      }));
      const before: string | null = cache ? JSON.stringify(cache) : null;
      const incremental = await analyzeStaticSource({
        manifest,
        sourceRoot: root,
        previous: cache,
      });
      if (cache)
        assert.equal(
          JSON.stringify(cache),
          before,
          "parent cache is immutable",
        );
      const full = await analyzeStaticSource({
        manifest: [...manifest].reverse(),
        sourceRoot: root,
        previous: null,
      });
      assert.equal(
        activeFactFingerprint(snapshot(incremental.files)),
        activeFactFingerprint(snapshot(full.files)),
      );
      cache = createAnalysisCache({
        manifest,
        parsedFiles: incremental.files,
        syntaxFiles: incremental.syntaxFiles,
        lspResults: [],
      });
      const warm = await analyzeStaticSource({
        manifest,
        sourceRoot: root,
        previous: cache,
      });
      assert.equal(warm.metrics.syntax_cache_hits, manifest.length);
      assert.equal(
        warm.metrics.semantic_cache_hits,
        manifest.filter((m) => m.path.endsWith(".ts")).length,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("virtual configuration cannot read host paths or execute plugins", async () => {
  const files = await tsFiles({
    "tsconfig.json":
      '{"extends":"../../secret.json","compilerOptions":{"plugins":[{"name":"arbitrary-code"}]}}',
    "main.ts": "function run() {}",
  });
  assert.ok(
    files
      .find((f) => f.path === "main.ts")
      ?.project?.diagnostics.some((d) => d.code.startsWith("config_")),
  );
});

test("snapshot readers reject traversal, absolute paths, tampered bytes and duplicate manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-boundary-"));
  try {
    await writeFile(join(root, "main.ts"), "function f() {}");
    const parser = new TreeSitterAnalyzer();
    for (const path of [
      "../secret.ts",
      "/secret.ts",
      "C:/secret.ts",
      "dir/../main.ts",
      "dir\\main.ts",
    ])
      await assert.rejects(
        parser.analyzeFile(root, path),
        /unsafe_analysis_path/,
      );
    const manifest = [{ path: "main.ts", bytes: 15, digest: "0".repeat(64) }];
    await assert.rejects(
      analyzeStaticSource({ manifest, sourceRoot: root, previous: null }),
      /source_digest_mismatch/,
    );
    await assert.rejects(
      analyzeStaticSource({
        manifest: [...manifest, ...manifest],
        sourceRoot: root,
        previous: null,
      }),
      /duplicate_source_path/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      analyzeStaticSource({
        manifest,
        sourceRoot: root,
        previous: null,
        signal: controller.signal,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON imports and compiler-excluded duplicate roots retain warm semantic identities", async () => {
  const input = {
    "tsconfig.json":
      '{"compilerOptions":{"allowJs":true,"resolveJsonModule":true,"module":"nodenext"}}',
    "main.ts":
      "import data from './data.json'; export const run=()=>data.value;",
    "main.js": "function legacy() {}",
    "data.json": '{"value":1}',
  };
  const first = await tsFiles(input);
  const second = await analyzeTypeScriptTexts(
    first,
    new Map(Object.entries(input).map(([p, t]) => ["/repository/" + p, t])),
  );
  for (const file of first.filter((f) => f.relationBinding === "typescript"))
    assert.strictEqual(
      second.find((f) => f.path === file.path),
      file,
    );
  assert.ok(second.find((f) => f.path === "main.ts")?.semanticComplete);
});
test("Python lexical candidates respect parameters, rebinding, closures and class scope rules", async () => {
  const source =
    "def target():\n    pass\ndef shadow(target):\n    target()\ndef changed():\n    target()\n    target = lambda: None\ndef outer():\n    def inner():\n        target()\n    inner()\nclass C:\n    def target(self):\n        pass\n    def run(self):\n        target()\n";
  const file = await new TreeSitterAnalyzer().analyzeBytes(
    "main.py",
    Buffer.from(source),
  );
  const owner = (call: (typeof file.calls)[number]) =>
    file.symbols.find((s) => s.stableId === call.callerStableId)?.qualifiedName;
  assert.equal(file.calls.find((c) => owner(c) === "shadow")?.target, null);
  assert.equal(file.calls.find((c) => owner(c) === "changed")?.target, null);
  assert.equal(
    file.calls.find((c) => owner(c) === "outer")?.target?.symbolId,
    file.symbols.find((s) => s.qualifiedName === "outer.inner")?.stableId,
  );
  assert.equal(
    file.calls.find((c) => owner(c) === "C.run")?.target?.symbolId,
    file.symbols.find((s) => s.qualifiedName === "target")?.stableId,
  );
});
test("native imports distinguish types, reexports, dynamic modules and mutable dispatch", async () => {
  const files = await tsFiles({
    "lib.cts":
      "export interface T {} export function f() {} export class Base {}",
    "main.cts":
      "import type {T} from './lib.cjs'; export {f} from './lib.cjs'; import('./lib.cjs'); function a() {} function b() {} a=b; a(); class C { run() {} } function invoke(c:C) {c.run();}",
  });
  const main = files.find((f) => f.path === "main.cts")!;
  assert.deepEqual(
    main.imports.map((i) => i.kind),
    ["type_imports", "reexports", "dynamic_imports"],
  );
  assert.equal(main.calls.find((c) => c.callee === "a")?.target, null);
  assert.equal(
    main.calls.find((c) => c.callee === "c.run")?.status,
    "candidate",
  );
  assert.ok(main.exports?.some((e) => e.name === "f" && e.entityId));
});

test("class initializer calls have execution scopes distinct from outer functions", async () => {
  const file = (
    await tsFiles({
      "main.ts":
        "function target() {} function outer() { class C { field=target(); static value=target(); static { target(); } [target()]() { target(); } } }",
    })
  )[0]!;
  const calls = file.calls.filter((c) => c.callee === "target");
  const owners = calls.map(
    (c) => file.symbols.find((s) => s.stableId === c.callerStableId)?.name,
  );
  assert.deepEqual(owners, [
    "<initialize:field>",
    "<initialize:value>",
    "<static>",
    "outer",
    "[target()]",
  ]);
  assert.ok(
    file.calls.every(
      (c) =>
        c.target?.symbolId ===
        file.symbols.find((s) => s.name === "target")?.stableId,
    ),
  );
});
test("language-specific declarations preserve C++ prototypes, Rust impl scopes and Go interfaces", async () => {
  const parser = new TreeSitterAnalyzer();
  const cpp = await parser.analyzeBytes(
    "api.cpp",
    Buffer.from("void f(int); void f(int x) {} void f(double x) {}"),
  );
  assert.equal(cpp.symbols.length, 3);
  assert.deepEqual(
    cpp.symbols.map((s) => s.declarations?.[0]?.role),
    ["declaration", "definition", "definition"],
  );
  assert.equal(new Set(cpp.symbols.map((s) => s.stableId)).size, 3);
  const rust = await parser.analyzeBytes(
    "lib.rs",
    Buffer.from(
      "struct A {} struct B {} impl A { fn run() {} } impl B { fn run() {} }",
    ),
  );
  const methods = rust.symbols.filter((s) => s.name === "run");
  assert.equal(methods.length, 2);
  assert.notEqual(methods[0]?.qualifiedName, methods[1]?.qualifiedName);
  const go = await parser.analyzeBytes(
    "main.go",
    Buffer.from(
      "package main\ntype Runner interface { Run() }\ntype Count int\n",
    ),
  );
  assert.equal(go.symbols.find((s) => s.name === "Runner")?.kind, "interface");
  assert.equal(go.symbols.find((s) => s.name === "Count")?.kind, "type_alias");
});
