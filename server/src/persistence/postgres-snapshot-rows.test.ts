import assert from "node:assert/strict";
import test from "node:test";
import { insertSnapshotRows } from "./postgres-snapshot-rows.js";

test("snapshot bulk rows preserve nested JSON, nulls, Unicode and ordering in bounded parameter batches", async () => {
  const calls: Array<{ sql: string; rows: unknown[] }> = [];
  const db = { query: async (sql: string, params: string[]) => {
    assert.equal(params.length, 1);
    assert.doesNotMatch(sql, /private-source|DROP TABLE/);
    assert.match(sql, /jsonb_populate_recordset\(NULL::snapshot_query_nodes, \$1::jsonb\) ON CONFLICT DO NOTHING/);
    calls.push({ sql, rows: JSON.parse(params[0]!) });
    return { rows: [], rowCount: 0 };
  } } as Parameters<typeof insertSnapshotRows>[0];
  const rows = Array.from({ length: 2_001 }, (_, id) => ({ id, parent: null,
    payload: { text: "中文\nprivate-source'); DROP TABLE users;--", nested: ["a", { b: true }] }, ignored: 1 }));
  await insertSnapshotRows(db, "snapshot_query_nodes", ["id", "parent", "payload"], rows);
  assert.deepEqual(calls.map(call => call.rows.length), [2_000, 1]);
  assert.equal(calls[0]?.sql, calls[1]?.sql);
  assert.deepEqual(calls.flatMap(call => call.rows), rows.map(({ ignored, ...row }) => row));
  await insertSnapshotRows(db, "snapshot_query_nodes", ["id"], []);
  assert.equal(calls.length, 2);
  calls.length = 0;
  const large = Array.from({ length: 8 }, (_, id) => ({ id, payload: "中".repeat(350_000) }));
  await insertSnapshotRows(db, "snapshot_query_nodes", ["id", "payload"], large);
  assert.ok(calls.length > 1, "byte limit applies before the row limit");
  assert.deepEqual(calls.flatMap(call => call.rows), large);
});
