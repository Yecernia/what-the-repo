import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';
import { EncryptedPostgresKeyVault } from './encrypted-key-vault.js';
const databaseUrl = process.env.WTR_BYOK_TEST_DATABASE_URL;
test('isolated PostgreSQL BYOK survives restarts as ciphertext without plaintext caches', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-managed-byok-'));
  const options = { root, databaseUrl: url.toString(), migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'isolated-byok-master-not-in-database' };
  const store = new PostgresStore(options), second = new PostgresStore(options);
  const owner = 'github:byok-' + randomUUID(), other = owner + '-other';
  const key = 'fake-managed-BYOK-sentinel-812';
  try {
    await store.init(); await second.init();
    for (const id of [owner, other]) await store.saveUser(id, { kind: 'github' });
    await store.keys.set(owner, key, 'one');
    const original = (await store.pool.query('SELECT * FROM provider_keys WHERE owner_id=$1', [owner])).rows[0];
    assert.equal(JSON.stringify(original).includes(key), false);
    assert.equal(original.iv.length, 12); assert.equal(original.auth_tag.length, 16);
    assert.equal(await second.keys.has(owner, 'one'), true);
    assert.equal(await second.keys.masked(owner, 'one'), '********');
    assert.equal(await second.keys.get(owner, 'one'), key);
    assert.equal(await second.keys.get(other, 'one'), null);
    await store.keys.set(owner, key, 'one');
    const replaced = (await store.pool.query('SELECT * FROM provider_keys WHERE owner_id=$1', [owner])).rows[0];
    assert.notDeepEqual(replaced.iv, original.iv);
    assert.notDeepEqual(replaced.ciphertext, original.ciphertext);
    const wrong = new EncryptedPostgresKeyVault(store.pool, 'a-different-server-master-secret');
    await wrong.init(); assert.equal(await wrong.has(owner, 'one'), true);
    await assert.rejects(wrong.get(owner, 'one'), /provider_credential_unavailable/);
    await store.pool.query(`INSERT INTO provider_keys(owner_id,connection_id,ciphertext,iv,auth_tag,key_version)
      SELECT $2,'one',ciphertext,iv,auth_tag,key_version FROM provider_keys WHERE owner_id=$1 AND connection_id='one'`, [owner, other]);
    await assert.rejects(second.keys.get(other, 'one'), /provider_credential_unavailable/);
    await store.pool.query("UPDATE provider_keys SET auth_tag=set_byte(auth_tag,0,get_byte(auth_tag,0)#1) WHERE owner_id=$1", [owner]);
    await assert.rejects(store.keys.get(owner, 'one'), /provider_credential_unavailable/);
    await store.keys.set(owner, key + '-replacement', 'one');
    assert.equal(await second.keys.get(owner, 'one'), key + '-replacement');
    await store.keys.clear(owner, 'one'); assert.equal(await second.keys.get(owner, 'one'), null);
    assert.equal(JSON.stringify(store.keys).includes(key), false);
  } finally {
    await store.pool.query('DELETE FROM app_users WHERE owner_id=ANY($1::text[])', [[owner, other]]).catch(() => undefined);
    await Promise.all([store.close(), second.close()]); await rm(root, { recursive: true, force: true });
  }
});
