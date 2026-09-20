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

test('row insertion applies backpressure and closes the source on database failure', async () => {
  for (const fail of [false, true]) {
    let pulled = 0, closed = false, batches = 0;
    function* rows() {
      try { for (let id = 0; id < 5_000; id++) { pulled++; yield { id }; } }
      finally { closed = true; }
    }
    const failure = new Error('database write failed');
    const db = { query: async (_sql: string, args: string[]) => {
      const batch = JSON.parse(args[0]!);
      assert.ok(batch.length <= 2_000);
      batches++;
      if (batches === 1) assert.equal(pulled, 2_001);
      if (fail) throw failure;
      return { rows: [], rowCount: batch.length };
    } } as Parameters<typeof insertSnapshotRows>[0];
    const result = insertSnapshotRows(db, 'snapshot_query_nodes', ['id'], rows());
    if (fail) await assert.rejects(result, error => error === failure);
    else await result;
    assert.equal(batches, fail ? 1 : 3);
    assert.equal(pulled, fail ? 2_001 : 5_000);
    assert.equal(closed, true);
  }
});
