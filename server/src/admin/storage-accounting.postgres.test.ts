import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { PostgresStore } from '../persistence/postgres-store.js';
import { loadConfig } from '../config.js';
import { AdminRepositories } from './repositories.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('storage accounting publication, rollback, reconciliation and expired-owner fencing',
  {skip: !url, timeout: 60_000}, async () => {
    assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const root = await mkdtemp(join(tmpdir(), 'wtr-accounting-pg-'));
    const store = new PostgresStore({root, databaseUrl: url!, migrationsRoot: join(process.cwd(), 'migrations'),
      encryptionSecret: 'accounting-isolated-test-secret'.repeat(2), poolMax: 2});
    const key = 'a'.repeat(64), repository = 'accounting/fixture';
    const admin = new AdminRepositories(store, loadConfig({}));
    try {
      await store.init();
      await store.pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,
        commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,
        source_storage_key) VALUES($1,$2,'commit','fixture','fixture','accounting-snapshot','')`, [key,repository]);
      const createGeneration = async () => String((await store.pool.query(`INSERT INTO snapshot_directory_generations(
        public_snapshot_key,snapshot_id,staging_expires_at) VALUES($1,'accounting-snapshot',clock_timestamp()+interval '1 hour')
        RETURNING directory_id`, [key])).rows[0].directory_id);
      const first = await createGeneration();
      const bind = async (id: string, nodes: number) => store.pool.query(`INSERT INTO snapshot_query_directories(
        public_snapshot_key,snapshot_id,schema_version,directory_digest,node_count,edge_count,evidence_count,
        layer_count,value_point_count,ready_at,directory_id)
        VALUES($1,'accounting-snapshot',3,'digest',$3,3,4,5,6,clock_timestamp(),$2)
        ON CONFLICT(public_snapshot_key) DO UPDATE SET directory_id=EXCLUDED.directory_id,node_count=EXCLUDED.node_count`,
      [key,id,nodes]);
      const revision = async () => (await store.pool.query(
        'SELECT accounting_revision FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1', [key])).rows[0].accounting_revision;
      const resetCursor = async () => store.pool.query(`UPDATE admin_documents
        SET value=jsonb_set(value,'{cursor}','""'::jsonb) WHERE key='storage-accounting-lease'`);
      const observed = async () => (await admin.stored(1)).storedRepositories.find(row => row.repository_identity === repository)!;
      await bind(first, 10);
      const beforeRollback = await revision();
      const client = await store.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE snapshot_query_directories SET node_count=999 WHERE public_snapshot_key=$1', [key]);
        await client.query('ROLLBACK');
      } finally { client.release(); }
      assert.equal(await revision(), beforeRollback, 'failed publication does not invalidate or change the summary');
      await admin.refreshAccounting();
      assert.equal((await observed()).logical_counts?.nodes, 10);
      assert.equal((await observed()).accounting_fresh, true);
      await bind(first, 10);
      assert.equal((await observed()).accounting_fresh, false, 'even unchanged keys invalidate on republishing');
      await resetCursor(); await admin.refreshAccounting();
      assert.equal((await observed()).logical_counts?.nodes, 10, 'a retry replaces counts instead of accumulating');

      const second = await createGeneration();
      await store.pool.query('INSERT INTO snapshot_directory_reclamation(directory_id) VALUES($1)', [first]);
      await bind(second, 20);
      await resetCursor(); await admin.refreshAccounting();
      assert.equal((await observed()).logical_counts?.nodes, 20);
      assert.equal((await observed()).generation_counts?.retired, 1);
      await store.pool.query('DELETE FROM snapshot_directory_generations WHERE directory_id=$1', [first]);
      assert.equal((await observed()).accounting_fresh, false, 'physical generation reclamation invalidates the snapshot');
      await store.pool.query('UPDATE snapshot_directory_generations SET logical_counts=NULL WHERE directory_id=$1', [second]);
      await resetCursor(); await admin.refreshAccounting();
      assert.equal((await observed()).logical_counts?.nodes, 20, 'bounded reconciliation recovers missing metadata');
      assert.equal((await observed()).generation_counts?.retired, 0);

      await bind(second, 30); await resetCursor();
      let stolen = false;
      const fencedPool = {async query(sql: string, args?: unknown[]) {
        if (!stolen && sql.includes('WITH lease AS MATERIALIZED')) {
          stolen = true;
          await store.pool.query(`UPDATE admin_documents SET value=value || jsonb_build_object(
            'owner','replacement','until',extract(epoch FROM clock_timestamp())*1000+60000)
            WHERE key='storage-accounting-lease'`);
        }
        return store.pool.query(sql, args);
      }} as unknown as Pool;
      await new AdminRepositories(store, loadConfig({}), fencedPool).refreshAccounting();
      assert.equal(stolen, true);
      assert.equal((await observed()).accounting_fresh, false, 'a collector that lost its lease cannot publish');
      const lease = (await store.pool.query("SELECT value FROM admin_documents WHERE key='storage-accounting-lease'")).rows[0].value;
      assert.equal(lease.owner, 'replacement', 'an old owner cannot release its replacement lease');
    } finally {
      await admin.closeAccounting().catch(() => undefined);
      await store.close(); await rm(root, {recursive: true, force: true});
    }
  });
