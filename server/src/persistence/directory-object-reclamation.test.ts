import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { deleteDirectoryObjectsBatch } from './directory-object-reclamation.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

test('retired directory objects are deleted idempotently and failed work survives for retry', async () => {
  const prefix = `public-repository-snapshots/${'a'.repeat(64)}/directory/12/nodes/`;
  const pending = new Set([prefix+'0-first.json.gz', prefix+'1-second.json.gz', 'outside-snapshot/file']);
  const attempts = new Set<string>(), deleted: string[] = [];
  let failure = true;
  const db = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT object_key')) return { rows: [...pending].map(object_key => ({ object_key })) };
    if (sql.startsWith('SELECT count')) return { rows: [{ pending: String(pending.size) }] };
    if (sql.startsWith('DELETE')) pending.delete(String(args[0]));
    else if (sql.startsWith('UPDATE')) attempts.add(String(args[0]));
    else throw Error('unexpected SQL');
    return { rows: [] };
  }} as unknown as Pick<Pool,'query'>;
  const objects = { delete: async (key: string) => {
    if (key.endsWith('second.json.gz') && failure) throw Error('unavailable');
    deleted.push(key);
  }} as SnapshotObjectStore;
  assert.deepEqual(await deleteDirectoryObjectsBatch(db, objects), { deleted: 1, failed: 2, pending: 2 });
  assert.ok(attempts.has(prefix+'1-second.json.gz'));
  assert.deepEqual(deleted, [prefix+'0-first.json.gz']);
  failure = false;
  assert.deepEqual(await deleteDirectoryObjectsBatch(db, objects), { deleted: 1, failed: 1, pending: 1 });
  assert.equal(pending.has('outside-snapshot/file'), true, 'unscoped keys are never deleted');
  assert.equal(deleted.length, 2, 'finished ledger entries are removed, not retained forever');
});
