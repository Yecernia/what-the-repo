import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { BoundedFileScan, accountingFresh, accountingSignature, emptyAccounting, estimateSnapshotStorage,
  type PhysicalSample } from './storage-accounting.js';

test('a bounded scan resumes a large directory and counts every file once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-accounting-'));
  const scan = new BoundedFileScan([root, join(root, 'missing')]);
  try {
    await mkdir(join(root, 'nested'));
    for (let i = 0; i < 17; i++) await writeFile(join(root, String(i)), '123');
    await writeFile(join(root, 'nested', 'a'), '12345');
    let passes = 0;
    while (true) {
      const result = await scan.step({maxEntries: 3, maxMs: 1000}); passes++;
      assert.ok(result.visited <= 3);
      if (result.done) { assert.equal(result.bytes, 56); break; }
      assert.equal(result.bytes, null, 'partial totals are not published as complete');
      assert.ok(passes < 20, 'the scan must progress past each chunk boundary');
    }
    assert.ok(passes > 5);
  } finally { await scan.close(); await rm(root, {recursive: true, force: true}); }
});

test('directory estimates use metadata, keep retired/staging occupancy, and never count facts', async () => {
  const queries: string[] = [];
  const pool = {async query(sql: string) {
    queries.push(sql);
    return {rows: [
      {directory_id: '1', state: 'published', logical_counts: {nodes: 20},
        node_count: '20', edge_count: 3, evidence_count: 4, layer_count: 2, value_point_count: 1},
      {directory_id: '2', state: 'retired', logical_counts: {nodes: 30}},
      {directory_id: '3', state: 'staging', logical_counts: null},
    ]};
  }} as unknown as Pool;
  const sample: PhysicalSample = {observedAt: new Date().toISOString(), database_bytes: 1000, database_index_bytes: 100,
    tables: [
      {relname: 'snapshot_directory_nodes', estimated_rows: 100, data_bytes: 1000, index_bytes: 100},
      {relname: 'snapshot_directory_nodes_g2', estimated_rows: 30, data_bytes: 400, index_bytes: 40},
      {relname: 'snapshot_directory_nodes_g3', estimated_rows: 0, data_bytes: 100, index_bytes: 10},
    ]};
  const result = await estimateSnapshotStorage(pool, ['key'], sample);
  assert.deepEqual(result.logical_counts, {nodes: 20, edges: 3, evidence: 4, layers: 2, value_points: 1});
  assert.deepEqual(result.generation_counts, {published: 1, retired: 1, staging: 1, unknown: 1});
  assert.equal(result.database_bytes, 700); assert.equal(result.database_index_bytes, 70);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /count\s*\(|pg_table_size|snapshot_directory_nodes\b/i);
});

test('unknown physical samples remain unknown and signatures invalidate unchanged snapshot keys', async () => {
  const pool = {async query() {return {rows: []};}} as unknown as Pool;
  const result = await estimateSnapshotStorage(pool, ['key'],
    {observedAt: '', tables: [], database_bytes: 0, database_index_bytes: 0});
  assert.equal(result.database_bytes, null);
  const row = {keys: ['key'], legacy_projects: [], created_at: 'today', revisions: ['key:1']};
  assert.notEqual(accountingSignature(row), accountingSignature({...row, revisions: ['key:2']}));
  const ready = {...emptyAccounting, observedAt: new Date().toISOString(), physical_observed_at: new Date().toISOString(),
    accounting_status: 'ready' as const};
  assert.equal(accountingFresh(ready), true);
  assert.equal(accountingFresh({...ready, accounting_status: 'scanning'}), false);
  assert.equal(accountingFresh({...ready, physical_observed_at: '2000-01-01'}), false);
});
