import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { EncryptedPostgresKeyVault } from './encrypted-key-vault.js';

// Deliberately a SQL test double; this is not a PostgreSQL integration test.
function database() {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values }); const id = JSON.stringify(values.slice(0, 2));
    if (sql.startsWith('INSERT')) rows.set(id, { ciphertext: values[2], iv: values[3], auth_tag: values[4], key_version: values[5] });
    if (sql.startsWith('DELETE')) rows.delete(id);
    const row = rows.get(id);
    return { rows: row ? [sql.startsWith('SELECT 1') ? { exists: 1 } : row] : [], rowCount: row ? 1 : 0 };
  };
  return { pool: { query } as unknown as Pool, rows, calls };
}
test('managed vault decrypts on demand, survives recreation and observes replacement/deletion', async () => {
  const db = database(), master = 'unit-test-independent-master-secret', key = 'unit-BYOK-sentinel-9z';
  const first = new EncryptedPostgresKeyVault(db.pool, master);
  await first.init(); assert.equal(db.calls.length, 0, 'startup must not load user keys');
  await first.set('alice', key, 'one');
  assert.equal(JSON.stringify(db.calls).includes(key), false, 'SQL parameters contain ciphertext only');
  const second = new EncryptedPostgresKeyVault(db.pool, master);
  await second.init(); assert.equal(await second.get('alice', 'one'), key);
  assert.equal(await second.get('bob', 'one'), null);
  await first.set('alice', key + '-new', 'one');
  assert.equal(await second.get('alice', 'one'), key + '-new');
  await first.clear('alice', 'one'); assert.equal(await second.get('alice', 'one'), null);
});
test('metadata never decrypts and authenticated ciphertext rejects tampering or wrong identity', async () => {
  const db = database(), master = 'unit-test-master-for-AAD', key = 'unit-managed-secret-42';
  const vault = new EncryptedPostgresKeyVault(db.pool, master);
  await vault.set('alice', key, 'one');
  const first = db.rows.get(JSON.stringify(['alice', 'one']))!;
  await vault.set('alice', key, 'one');
  const second = db.rows.get(JSON.stringify(['alice', 'one']))!;
  assert.notDeepEqual(first.iv, second.iv);
  db.rows.set(JSON.stringify(['bob', 'one']), second);
  db.rows.set(JSON.stringify(['alice', 'two']), second);
  for (const [owner, connection] of [['bob', 'one'], ['alice', 'two']]) {
    await assert.rejects(vault.get(owner!, connection!), /provider_credential_unavailable/);
  }
  const corrupt = Buffer.from(second.auth_tag as Buffer); corrupt[0]! ^= 1;
  db.rows.set(JSON.stringify(['alice', 'one']), { ...second, auth_tag: corrupt });
  assert.equal(await vault.has('alice', 'one'), true);
  assert.equal(await vault.masked('alice', 'one'), '********');
  await assert.rejects(vault.get('alice', 'one'), /provider_credential_unavailable/);
  db.rows.set(JSON.stringify(['alice', 'one']), second);
  await assert.rejects(new EncryptedPostgresKeyVault(db.pool, master + '-wrong').get('alice', 'one'), /provider_credential_unavailable/);
  assert.equal(JSON.stringify(vault).includes(master), false);
});

test('vault inspection excludes the master key and even a cyclic connection pool', async () => {
  const { inspect } = await import('node:util');
  const db = database();
  Object.assign(db.pool, { options: { connectionString: 'test-only-database-credential' }, self: db.pool });
  const vault = new EncryptedPostgresKeyVault(db.pool, 'test-only-master-secret-inspection');
  await vault.init();
  assert.deepEqual(Object.keys(vault), []);
  assert.equal(JSON.stringify(vault), '{}');
  assert.doesNotMatch(inspect(vault, { depth: 10, showHidden: true }), /test-only-/);
});
