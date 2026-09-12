import test from "node:test";
import assert from "node:assert/strict";
import { readSourcePage } from "./source-read.js";

test("source read returns a continuation offset without cutting lines", async () => {
  const rows = ["one", "two", "three", "four", "five"];
  const page = await readSourcePage({
    path: "src/example.ts",
    offset: 2,
    limit: 2,
    readLines: async (_path, start, end) => rows.slice(start - 1, end),
  });

  assert.equal(page.content, "two\nthree");
  assert.equal(page.start_line, 2);
  assert.equal(page.end_line, 3);
  assert.equal(page.truncated, true);
  assert.equal(page.next_offset, 4);
  assert.equal(page.truncation_reason, "lines");
});
