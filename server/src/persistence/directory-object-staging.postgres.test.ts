import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Pool } from 'pg';
import { applyMigrations } from './migrations.js';
import { registerControlPool } from './control-pool.js';
import { stageSnapshotQueryDirectory } from './snapshot-directory-publication.js';
import { parseDirectoryManifest } from './directory-objects.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';
import { deleteDirectoryObjectsBatch } from './directory-object-reclamation.js';
import { snapshotObjectDigest, type SnapshotObjectStore } from './snapshot-object-store.js';
import { streamSnapshotQueryDirectory } from '../domain/snapshot-query.js';

test('isolated PostgreSQL: serial staging owns uploads across rollback and interrupted PUT with a one-slot business pool',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
    const url = new URL(process.env.WTR_ADMIN_TEST_DATABASE_URL!);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 });
    const control = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 });
    registerControlPool(pool, control);
    const values = new Map<string, Uint8Array>();
    const untouched = 'public-repository-snapshots/' + 'f'.repeat(64) + '/unrelated.bin';
    values.set(untouched, Buffer.from('keep'));
    let failAfterUpload = false;
    const objects: SnapshotObjectStore = {
      kind: 'local',
      async put(key, body) {
        // Independent committed ownership must already exist before any PUT.
        const result = await control.query('SELECT object_key FROM snapshot_directory_object_intents WHERE object_key=$1', [key]);
        assert.equal(result.rowCount, 1);
        values.set(key, Buffer.from(body));
        if (failAfterUpload) throw new Error('simulated_connection_lost_after_put');
        return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
      },
      async get(key) { return values.get(key) ?? null; },
      async delete(key) { values.delete(key); },
    };
    try {
      await applyMigrations(pool, join(process.cwd(), 'migrations'));
      for (const interrupted of [false, true]) {
        const publicKey = (interrupted ? 'b' : 'a').repeat(64);
        const directory = streamSnapshotQueryDirectory(publicKey, 'rollback', {
          graph: { nodes: [{ id: 'component', name: 'component', members: [], evidence: [], certainty: 'verified' }], edges: [], layers: [] },
          value_points: [],
        }, { fact_graph: { nodes: [], edges: [] } });
        failAfterUpload = interrupted;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const staging = stageSnapshotQueryDirectory(pool, client, directory, { parallelism: 0, objectStore: objects });
          if (interrupted) await assert.rejects(staging, /simulated_connection_lost_after_put/);
          else await staging;
          // Simulate loss of the caller before binding, without invoking the
          // savePublicSnapshot error handler: ownership and TTL must suffice.
          await client.query('ROLLBACK');
        } finally { client.release(); }
        const generation = (await control.query('SELECT directory_id,object_manifest FROM snapshot_directory_generations WHERE public_snapshot_key=$1', [publicKey])).rows[0];
        assert.ok(generation);
        let keys = (await control.query('SELECT object_key FROM snapshot_directory_object_intents WHERE directory_id=$1',[generation.directory_id])).rows.map(row=>row.object_key as string);
        if(interrupted)assert.equal(generation.object_manifest,null,'an incomplete upload must not persist a complete manifest');
        else {
          const manifest = parseDirectoryManifest(generation.object_manifest, { publicKey, directoryId: generation.directory_id });
          assert.deepEqual(keys,[],'full committed manifest replaces staging intents before publication');
          keys=Object.values(manifest.sections).flat().map(chunk=>chunk.key);
        }
        assert.ok(keys.length > 0);
        assert.ok(keys.some(key => values.has(key)));
        await control.query("UPDATE snapshot_directory_generations SET staging_expires_at=clock_timestamp()-interval '1 second' WHERE directory_id=$1", [generation.directory_id]);
        for (let turn = 0; turn < 40; turn++) {
          const result = await reclaimSnapshotDirectoryBatch(pool);
          assert.notEqual(result.status, 'retry', result.errorCode);
          if (!(await control.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1', [generation.directory_id])).rowCount) break;
        }
        assert.equal((await control.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1', [generation.directory_id])).rowCount, 0);
        const deleted = await deleteDirectoryObjectsBatch(pool, objects);
        assert.equal(deleted.failed, 0);
        assert.equal(deleted.deleted, keys.length);
        assert.ok(keys.every(key => !values.has(key)));
        assert.ok(values.has(untouched));
      }
    } finally { await Promise.all([pool.end(), control.end()]); }
  });
