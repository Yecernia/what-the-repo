import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryExplorationTools } from "./repository-exploration-tools.js";
import { buildSnapshot } from "../analysis/graph.js";
import { decodeSource } from "../analysis/source-input.js";
import { analyzeTypeScriptTexts } from "../analysis/typescript.js";

test("file facts paginate unresolved calls without granting unseen source access", async () => {
  const text = "function run(value:any) { value.first(); value.second(); }";
  const files = await analyzeTypeScriptTexts(
    [decodeSource("main.ts", Buffer.from(text)).file],
    new Map([["/repository/main.ts", text]]),
  );
  const snapshot = buildSnapshot({
    snapshotId: "tools",
    repository: "example/repo",
    commitSha: "a".repeat(40),
    files,
    sourceRoot: "/unused",
  });
  const { tools } = createRepositoryExplorationTools({
    snapshot,
    readLines: async () => [],
    seedPaths: ["main.ts"],
  });
  const outline = tools.find(
    (tool) => tool.name === "get_repository_file_outline",
  )!;
  const result = await outline.execute("call", {
    path: "main.ts",
    kind: "calls",
    limit: 1,
  });
  const payload = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.total, 2);
  assert.equal(payload.next_offset, 1);
  assert.equal(payload.items[0].callee, "value.first");
  assert.equal(payload.items[0].status, "unresolved");
  assert.ok(payload.limitations.length);
  assert.equal(payload.syntax_completed, true);
  await assert.rejects(
    outline.execute("denied", { path: "unseen.ts", kind: "calls" }),
    /source_path_not_exposed/,
  );
});
