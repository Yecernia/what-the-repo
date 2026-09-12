import assert from "node:assert/strict";
import test from "node:test";
import { digestSemanticBatch } from "./semantic-batch.js";

test("semantic batch digest is stable for object key order", () => {
  assert.equal(
    digestSemanticBatch({ b: 2, a: { d: 4, c: 3 } }),
    digestSemanticBatch({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assert.notEqual(digestSemanticBatch({ a: 1 }), digestSemanticBatch({ a: 2 }));
});
