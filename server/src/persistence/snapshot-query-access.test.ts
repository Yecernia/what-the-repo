import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { readSnapshotQuery } from './snapshot-query-reader.js';

test('exact candidate SQL separates endpoint probes and pins evidence lookups to one generation', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('SELECT snapshot_id,directory_digest,directory_id')) {
      return { rows: [{ snapshot_id: 'snapshot', directory_digest: 'digest', directory_id: '42' }] };
    }
    return { rows: [] };
  }, release() {} };
  const pool = { connect: async () => client } as unknown as Pool;
  for (const hops of [0, 1, 2]) {
    calls.length = 0;
    await readSnapshotQuery(pool, { publicKey: 'public', snapshotId: 'snapshot',
      query: { entity_ids: ['precise-id'], include_metadata: false, expand_hops: hops } });
    const ranked = calls.find(call => call.sql.startsWith('WITH RECURSIVE'))!;
    assert.match(ranked.sql, /incident_edges AS MATERIALIZED/);
    assert.match(ranked.sql, /source_node_key=c.node_key/);
    assert.match(ranked.sql, /target_node_key=c.node_key/);
    assert.doesNotMatch(ranked.sql, /source_node_key IN \(SELECT node_key FROM chosen\) OR/);
    const evidence = calls.find(call => call.sql.includes('owner_kind=\'node\''))!;
    assert.equal(evidence.values[1], '42'); assert.match(evidence.sql, /UNION ALL/);
    assert.equal(calls[0]!.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(calls.at(-1)!.sql, 'COMMIT');
  }
});
