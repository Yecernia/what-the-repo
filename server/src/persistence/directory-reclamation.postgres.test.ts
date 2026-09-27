import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { reclaimSnapshotDirectoryBatch, snapshotDirectoryReclamationBacklog } from './directory-reclamation.js';
import { bindSnapshotQueryDirectory } from './snapshot-directory-publication.js';
import { streamSnapshotQueryDirectory } from '../domain/snapshot-query.js';
import { parseDirectoryManifest } from './directory-objects.js';

const databaseUrl = process.env.WTR_RECLAMATION_TEST_DATABASE_URL;
const childKinds = ['nodes','edges','evidence','evidence_links'] as const;
async function fixture(task: (store: PostgresStore, key: string, directoryId: string, base: Parameters<PostgresStore['savePublicSnapshot']>[0]) => Promise<void>,
  storage: 'legacy' | 'child' = 'legacy') {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /^\/wtr_admin_test_reclamation_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-directory-reclamation-'));
  const store = new PostgresStore({ root, databaseUrl: url.toString(), migrationsRoot: join(process.cwd(),'migrations'),
    encryptionSecret: 'isolated-directory-reclamation-only', poolMax: 3, objectAdmissionStore: new LocalPermitStore() });
  const key = createHash('sha256').update(randomUUID()).digest('hex');
  let initialized = false;
  try {
    await store.init(); initialized = true;
    const sourceRoot = join(root,'source'); await mkdir(sourceRoot);
    await writeFile(join(sourceRoot,'one.ts'), 'export const x=1;');
    const snapshotId = 'reclaim-' + key.slice(0,12);
    const view = { snapshot_id: snapshotId, graph: { nodes: [], edges: [], layers: [] }, value_points: [], learning_plan: { steps: [] } };
    const nodes = Array.from({length: 2_005}, (_v,i) => ({id:'old-'+i,name:'old-'+i,label:'old',responsibility:'',members:[],evidence:[],certainty:'verified',fan_in:0,fan_out:0}));
    const base = {publicKey:key,snapshotId,repository:'test/reclaim-'+key.slice(0,12),commitSha:'a'.repeat(40),sourceRoot,view,analysis:{fact_graph:{nodes,edges:[]}}};
    await store.savePublicSnapshot(base);
    const directoryId = (await store.pool.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id;
    if (storage === 'legacy') {
      // Keep the pre-existing bounded cleanup contract under test. Production
      // generations written before 0031 already have this physical layout.
      // Current publications also give evidence and evidence links their own
      // children. Move all four back, in FK order, to model a genuinely legacy
      // generation; leaving even an empty child changes reader-pinning behavior.
      for (const kind of childKinds) {
        const parent = 'snapshot_directory_' + kind;
        const columns = (await store.pool.query(`SELECT attname FROM pg_attribute
          WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''
          ORDER BY attnum`, [parent])).rows.map(row => '"' + String(row.attname).replaceAll('"','""') + '"').join(',');
        await store.pool.query(`INSERT INTO ${parent}(${columns})
          SELECT ${columns} FROM ONLY ${parent}_g${directoryId}`);
      }
      await store.pool.query(`DROP TABLE ${childKinds.map(kind => `snapshot_directory_${kind}_g${directoryId}`).join(',')}`);
    }
    await task(store,key,directoryId,base);
  } finally {
    try {
      if (initialized) {
        const generations = await store.pool.query('SELECT directory_id FROM snapshot_directory_generations WHERE public_snapshot_key=$1',[key]);
        for (const row of generations.rows) {
          const id = String(row.directory_id);
          if (!/^[1-9][0-9]*$/.test(id)) throw new Error('test_directory_id_invalid');
          await store.pool.query(`DROP TABLE IF EXISTS ${childKinds.map(kind => `snapshot_directory_${kind}_g${id}`).join(',')}`);
        }
        await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key]);
        // 0032 deliberately removed the snapshot-to-generation FK to allow
        // parallel staging before a snapshot exists. Deleting a snapshot alone
        // therefore leaves both generations and their reclamation work alive.
        await store.pool.query('DELETE FROM snapshot_directory_generations WHERE public_snapshot_key=$1',[key]);
        await store.pool.query('DELETE FROM directory_object_deletions WHERE object_key LIKE $1',
          [`public-repository-snapshots/${key}/directory/%`]);
        assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE public_snapshot_key=$1',[key])).rowCount,0,
          'fixture cleanup must remove every generation and its queued work');
        assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=ANY($1::bigint[])',
          [generations.rows.map(row => row.directory_id)])).rowCount,0);
      }
    } finally { await store.close(); await rm(root,{recursive:true,force:true}); }
  }
}

test('retired directory cleanup resumes bounded primary-key batches across maintenance restarts', {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,oldId,base) => {
    const reader=await store.pool.connect();
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await reader.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id,oldId);
    try {
    const timings = await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[],edges:[]}}});
    assert.equal(timings.directory_cleanup_ms, undefined);
    assert.equal((await snapshotDirectoryReclamationBacklog(store.pool)).pending,1);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,2_005);
    const visibleId = (await store.pool.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id;
    assert.notEqual(visibleId,oldId);
    let deleted = 0, batches = 0, releasedReader = false;
    while (await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId]).then(r=>r.rowCount)) {
      const worker = new Pool({connectionString:databaseUrl!,max:1});
      try {
        const result = await reclaimSnapshotDirectoryBatch(worker,{batchRows:137});
        if (result.status === 'busy' && !releasedReader) {
          assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,2_005,
            'old SQL rows remain visible while object retirement waits for the reader');
          assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM directory_object_deletions')).rows[0].n,0);
          await reader.query('ROLLBACK'); releasedReader = true;
          continue;
        }
        assert.ok(['progress','finished'].includes(result.status)); assert.ok(result.deletedRows<=137);
        deleted+=result.deletedRows; batches++;
        const progress = (await store.pool.query('SELECT * FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0];
        if (progress?.table_index===5 && result.deletedRows===137) assert.equal(progress.cursor_values.length,1);
      } finally {await worker.end();}
      assert.ok(batches<40);
    }
    assert.equal(deleted,2_005);
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[oldId])).rowCount,0);
    assert.equal((await store.pool.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id,visibleId);
    assert.equal(releasedReader,true,'COS deletion ownership is queued only after the pinned reader exits');
    assert.ok((await store.pool.query('SELECT count(*)::int AS n FROM directory_object_deletions')).rows[0].n>0);
    console.log(JSON.stringify({reclamationRows:deleted,boundedBatches:batches,batchLimit:137,oldReaderRemainsConsistent:true}));
    } finally {await reader.query('ROLLBACK');reader.release();}
  });
});

test('inherited directory children wait for pinned readers, then drop without leaving index copies',
  {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,oldId,base) => {
    const reader = await store.pool.connect();
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      assert.equal((await reader.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id,oldId);
      assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,2_005);
      await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[{id:'current-node',name:'Current node',
        label:'current',responsibility:'',members:[],evidence:[],certainty:'verified',fan_in:0,fan_out:0}],edges:[]}}});
      assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'progress',
        'the evidence-links child is first and records the post-publication observation boundary');
      const observed = (await store.pool.query('SELECT table_index,cleanup_observed_at FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0];
      assert.equal(observed.table_index,0); assert.ok(observed.cleanup_observed_at);
      const held = await reclaimSnapshotDirectoryBatch(store.pool);
      assert.equal(held.status,'busy');
      assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,2_005);
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,2_005);
    } finally { await reader.query('ROLLBACK'); reader.release(); }
    let removed = 0, calls = 0;
    while ((await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rowCount) {
      const result = await reclaimSnapshotDirectoryBatch(store.pool);
      assert.ok(['progress','finished'].includes(result.status));
      removed += result.deletedRows;
      assert.ok(++calls < 20);
    }
    assert.equal(removed,2_005);
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[oldId])).rowCount,0);
    assert.equal((await store.pool.query(`SELECT 1 FROM pg_class WHERE relname=ANY($1::text[])`,
      [childKinds.map(kind => `snapshot_directory_${kind}_g${oldId}`)])).rowCount,0);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[oldId])).rows[0].n,0);
    const retiredKeys = (await store.pool.query('SELECT object_key FROM directory_object_deletions')).rows.map(row => String(row.object_key));
    const currentGeneration = (await store.pool.query(`SELECT g.object_manifest FROM snapshot_query_directories d
      JOIN snapshot_directory_generations g USING(directory_id) WHERE d.public_snapshot_key=$1`, [key])).rows[0];
    const currentKeys = Object.values(parseDirectoryManifest(currentGeneration.object_manifest).sections).flat().map(chunk => chunk.key);
    assert.ok(retiredKeys.length > 0); assert.ok(currentKeys.length > 0);
    assert.ok(await store.snapshotObjects.get(retiredKeys[0]), 'prime the retired object cache before deletion');
    const drained = await store.deleteRetiredSnapshotObjectsBatch();
    assert.equal(drained.failed, 0); assert.equal(drained.deleted, retiredKeys.length);
    for (const objectKey of retiredKeys) assert.equal(await store.snapshotObjects.get(objectKey), null);
    for (const objectKey of currentKeys) assert.ok(await store.snapshotObjects.get(objectKey));
  }, 'child');
});

test('SQL cleanup failures retain progress for retry and cannot republish retired generations', {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,oldId,base) => {
    await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[],edges:[]}}});
    while ((await store.pool.query('SELECT table_index FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0].table_index<5) {
      await reclaimSnapshotDirectoryBatch(store.pool,{batchRows:137});
    }
    const first = await reclaimSnapshotDirectoryBatch(store.pool,{batchRows:137}); assert.equal(first.deletedRows,137);
    const before = (await store.pool.query('SELECT cursor_values,rows_deleted FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0];
    const name = 'reclaim_fail_'+key.slice(0,12);
    await store.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'untrusted-error-must-not-be-persisted'; END $$;
      CREATE TRIGGER ${name} BEFORE DELETE ON snapshot_directory_nodes FOR EACH ROW
      WHEN(OLD.directory_id=${oldId}) EXECUTE FUNCTION ${name}()`);
    try {
      const failed = await reclaimSnapshotDirectoryBatch(store.pool,{batchRows:137});
      assert.equal(failed.status,'retry'); assert.equal(failed.deletedRows,0); assert.equal(failed.errorCode,'P0001');
      const after = (await store.pool.query('SELECT * FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0];
      assert.deepEqual(after.cursor_values,before.cursor_values); assert.equal(after.rows_deleted,before.rows_deleted);
      assert.equal(after.attempts,1); assert.doesNotMatch(JSON.stringify(after),/untrusted-error/);
      assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'idle','retry delay is durable');
      const client = await store.pool.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(bindSnapshotQueryDirectory(client,streamSnapshotQueryDirectory(key,base.snapshotId,base.view,base.analysis),oldId),/not_publishable/);
      } finally {await client.query('ROLLBACK');client.release();}
    } finally {
      await store.pool.query(`DROP TRIGGER ${name} ON snapshot_directory_nodes; DROP FUNCTION ${name}()`);
    }
    await store.pool.query('UPDATE snapshot_directory_reclamation SET available_at=clock_timestamp() WHERE directory_id=$1',[oldId]);
    const restarted = new Pool({connectionString:databaseUrl!,max:1});
    try {
      const result = await reclaimSnapshotDirectoryBatch(restarted,{batchRows:137});
      assert.equal(result.status,'progress'); assert.equal(result.deletedRows,137);
    } finally {await restarted.end();}
    assert.equal((await snapshotDirectoryReclamationBacklog(store.pool)).failed,0);
  });
});

test('current and in-flight directories survive reclamation, and maintenance locks are nonblocking', {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,currentId,base) => {
    await store.pool.query('INSERT INTO snapshot_directory_reclamation(directory_id) VALUES($1)',[currentId]);
    assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'idle');
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[currentId])).rows[0].n,2_005);
    const other = await store.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('INSERT INTO snapshot_directory_generations(public_snapshot_key,snapshot_id) VALUES($1,$2)',[key,base.snapshotId]);
      assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'idle');
      await other.query('ROLLBACK');
      await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[],edges:[]}}});
      for (const guard of ['repository-payload-use','snapshot-directory-reclamation','snapshot-publication:'+key]) {
        await other.query('BEGIN');
        await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[guard]);
        const result = await reclaimSnapshotDirectoryBatch(store.pool);
        assert.equal(result.status,'busy'); assert.equal(result.deletedRows,0);
        await other.query('ROLLBACK');
      }
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[currentId])).rows[0].n,2_005);
    } finally {await other.query('ROLLBACK');other.release();}
  });
});

test('finalization rollback retains work and restores pooled planner policy', {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,oldId,base) => {
    await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[],edges:[]}}});
    const worker=new Pool({connectionString:databaseUrl!,max:1});
    const settings=`SELECT current_setting('enable_seqscan') AS seq,current_setting('enable_bitmapscan') AS bitmap,
      current_setting('plan_cache_mode') AS cache,current_setting('jit') AS jit,
      current_setting('enable_indexonlyscan') AS idxonly,current_setting('statement_timeout') AS timeout`;
    const name='finalize_fail_'+key.slice(0,12);
    try {
      while ((await store.pool.query('SELECT table_index FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0].table_index<9) {
        assert.equal((await reclaimSnapshotDirectoryBatch(worker,{batchRows:5000})).status,'progress');
      }
      assert.equal((await reclaimSnapshotDirectoryBatch(worker)).status,'progress','record the COS reader fence before fault injection');
      const before=(await worker.query(settings)).rows[0];
      await store.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'finalization-fault-private-text'; END $$;
        CREATE TRIGGER ${name} AFTER DELETE ON snapshot_directory_generations FOR EACH ROW
        WHEN(OLD.directory_id=${oldId}) EXECUTE FUNCTION ${name}()`);
      try {
        const result=await reclaimSnapshotDirectoryBatch(worker);
        assert.equal(result.status,'retry'); assert.equal(result.errorCode,'P0001');
        const row=(await store.pool.query('SELECT * FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0];
        assert.equal(row.table_index,9); assert.equal(row.rows_deleted,'2005');
        assert.equal(row.attempts,1); assert.doesNotMatch(JSON.stringify(row),/private-text/);
        assert.deepEqual((await worker.query(settings)).rows[0],before);
      } finally {
        await store.pool.query(`DROP TRIGGER ${name} ON snapshot_directory_generations; DROP FUNCTION ${name}()`);
      }
      await store.pool.query('UPDATE snapshot_directory_reclamation SET available_at=clock_timestamp() WHERE directory_id=$1',[oldId]);
      assert.equal((await reclaimSnapshotDirectoryBatch(worker)).status,'finished');
      assert.deepEqual((await worker.query(settings)).rows[0],before);
    } finally {await worker.end();}
  });
});

test('finalization refuses unreviewed foreign keys instead of running unbounded cascades', {skip:!databaseUrl,timeout:60_000}, async () => {
  await fixture(async (store,key,oldId,base) => {
    await store.savePublicSnapshot({...base,analysis:{fact_graph:{nodes:[],edges:[]}}});
    while ((await store.pool.query('SELECT table_index FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0].table_index<9) {
      assert.equal((await reclaimSnapshotDirectoryBatch(store.pool,{batchRows:5000})).status,'progress');
    }
    const name='unexpected_reference_'+key.slice(0,12);
    await store.pool.query(`CREATE TABLE ${name}(generation bigint REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE)`);
    try {
      const result=await reclaimSnapshotDirectoryBatch(store.pool);
      assert.equal(result.status,'retry'); assert.equal(result.errorCode,'directory_finalization_schema_mismatch');
      assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[oldId])).rowCount,1);
    } finally {await store.pool.query(`DROP TABLE ${name}`);}
    await store.pool.query('UPDATE snapshot_directory_reclamation SET available_at=clock_timestamp() WHERE directory_id=$1',[oldId]);
    assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'progress','record reader fence after schema validation');
    assert.equal((await reclaimSnapshotDirectoryBatch(store.pool)).status,'finished');
  });
});
