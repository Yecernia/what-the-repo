import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';

const databaseUrl = process.env.WTR_RECLAMATION_SCALE_TEST_DATABASE_URL ?? process.env.WTR_ADMIN_TEST_DATABASE_URL;
type Plan = Record<string, any>;
function scans(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap((child: Plan) => scans(child))]
    .filter(row => row['Node Type']?.includes('Scan') && row['Relation Name']);
}
const settingsSql = `SELECT current_setting('enable_seqscan') AS seq,
  current_setting('enable_bitmapscan') AS bitmap,current_setting('enable_indexscan') AS idx,
  current_setting('enable_indexonlyscan') AS idxonly,current_setting('plan_cache_mode') AS cache,
  current_setting('jit') AS jit,current_setting('statement_timeout') AS timeout`;

test('million-row stale statistics and cached FK plans cannot stall retired-generation finalization',
  { skip: !databaseUrl, timeout: 240_000 }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-finalization-scale-'));
  const store = new PostgresStore({ root, databaseUrl: url.toString(), migrationsRoot: join(process.cwd(),'migrations'),
    encryptionSecret:'isolated-finalization-test-only', poolMax:2, objectAdmissionStore:new LocalPermitStore() });
  const worker = new Pool({ connectionString:url.toString(), max:1 });
  const keys = [0,1].map(() => createHash('sha256').update(randomUUID()).digest('hex'));
  const nested: Plan[] = [];
  worker.on('connect', client => client.on('notice', notice => {
    const message=notice.message ?? '';
    const marker = message.indexOf('plan:\n');
    if (marker >= 0) nested.push({...JSON.parse(message.slice(marker+6)),
      durationMs:Number(message.match(/duration: ([0-9.]+)/)?.[1] ?? 0)});
  }));
  let oldId = '', liveId = '';
  try {
    await store.init();
    const sourceRoot=join(root,'source'); await mkdir(sourceRoot);
    const snapshotId='finalization-scale';
    const base={snapshotId,repository:'test/finalization',commitSha:'a'.repeat(40),sourceRoot,
      view:{snapshot_id:snapshotId,graph:{nodes:[],edges:[],layers:[]},value_points:[],learning_plan:{steps:[]}},
      analysis:{fact_graph:{nodes:[],edges:[]}}};
    for (const publicKey of keys) await store.savePublicSnapshot({...base,publicKey,repository:base.repository+'-'+publicKey});
    [oldId,liveId] = await Promise.all(keys.map(async key => String((await store.pool.query(
      'SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id)));
    // Exercise the bounded parent-row path rather than dropping a generation
    // child. Both old children are empty because the published fixture is empty.
    assert.match(oldId,/^[1-9][0-9]*$/);
    await store.pool.query(`DROP TABLE snapshot_directory_evidence_links_g${oldId},snapshot_directory_evidence_g${oldId}`);
    await store.pool.query('ALTER TABLE snapshot_directory_evidence SET (autovacuum_enabled=false)');
    // Interleave the once-large retired generation with a million unrelated rows.
    // This creates genuine MCV selectivity and low physical correlation; no pg_statistic editing.
    await store.pool.query(`INSERT INTO snapshot_directory_evidence
      (directory_id,row_no,evidence_id)
      SELECT CASE WHEN i%6=0 THEN $1::bigint ELSE $2::bigint END,
        i-1,'proof:'||lpad(i::text,8,'0')
      FROM generate_series(1,1200000) AS i`,[oldId,liveId]);
    await store.pool.query('ANALYZE snapshot_directory_evidence');
    const statsSql=`SELECT n_distinct,most_common_vals::text,most_common_freqs FROM pg_stats
      WHERE schemaname='public' AND tablename='snapshot_directory_evidence' AND attname='directory_id'`;
    const oldStats=(await store.pool.query(statsSql)).rows;
    await store.savePublicSnapshot({...base,publicKey:keys[0]!,repository:base.repository+'-'+keys[0]});
    let batches=0,deleted=0;
    while ((await store.pool.query('SELECT table_index FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0].table_index<9) {
      const result=await reclaimSnapshotDirectoryBatch(worker,{batchRows:5000});
      assert.equal(result.status,'progress'); assert.ok(result.deletedRows<=5000);
      deleted+=result.deletedRows; assert.ok(++batches<60);
    }
    assert.equal(deleted,200000);
    assert.deepEqual((await store.pool.query(statsSql)).rows,oldStats,'finalization must work without refreshed statistics');
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_evidence WHERE directory_id=$1',[oldId])).rows[0].n,0);
    const initialSettings=(await worker.query(settingsSql)).rows[0];
    await worker.query(`LOAD 'auto_explain'; SET client_min_messages='log';
      SET auto_explain.log_min_duration=0; SET auto_explain.log_analyze=on;
      SET auto_explain.log_buffers=on; SET auto_explain.log_timing=off;
      SET auto_explain.log_nested_statements=on; SET auto_explain.log_format=json`);
    // Seed the *real RI trigger's* generic-plan cache on the very same connection.
    // Roll back the parent deletion: the worker must still finish this exact item.
    await worker.query('BEGIN');
    await worker.query("SET LOCAL plan_cache_mode=force_generic_plan; SET LOCAL statement_timeout='15s'");
    nested.length=0;
    await worker.query('DELETE FROM snapshot_directory_generations WHERE directory_id=$1',[oldId]);
    await worker.query('SET CONSTRAINTS ALL IMMEDIATE');
    await worker.query('ROLLBACK');
    const beforePlans=nested.splice(0);
    const beforeEvidence=beforePlans.find(row => /DELETE FROM ONLY.*snapshot_directory_evidence"?\s/.test(row['Query Text']??''));
    assert.ok(beforeEvidence,'must capture the internal FK DELETE, not just an equivalent external query');
    assert.ok(scans(beforeEvidence.Plan).some(row=>row['Node Type']==='Seq Scan'),'stale FK plan must reproduce the whole-table scan');
    const baselineBlocks=(beforeEvidence.Plan['Shared Hit Blocks']??0)+(beforeEvidence.Plan['Shared Read Blocks']??0);
    nested.length=0;
    const started=performance.now();
    const result=await reclaimSnapshotDirectoryBatch(worker);
    const finishMs=performance.now()-started;
    assert.equal(result.status,'finished','original 2s SQL limit must remain sufficient');
    const afterPlans=nested.splice(0);
    const emptiness=afterPlans.find(row=>(row['Query Text']??'').startsWith('SELECT EXISTS'));
    assert.ok(emptiness);
    assert.equal(scans(emptiness.Plan).some(row=>row['Node Type']==='Seq Scan'),false);
    const emptinessBlocks=(emptiness.Plan['Shared Hit Blocks']??0)+(emptiness.Plan['Shared Read Blocks']??0);
    const afterEvidence=afterPlans.find(row=>/DELETE FROM ONLY.*snapshot_directory_evidence"?\s/.test(row['Query Text']??''));
    assert.ok(afterEvidence,'the real cascade must still run; FK triggers were not disabled');
    const afterScans=scans(afterEvidence.Plan);
    assert.ok(afterScans.some(row=>row['Node Type']==='Index Scan'));
    const afterBlocks=(afterEvidence.Plan['Shared Hit Blocks']??0)+(afterEvidence.Plan['Shared Read Blocks']??0);
    assert.ok(afterBlocks<baselineBlocks/4,'finishing an empty directory must not scan unrelated heap pages');
    const internal=afterPlans.filter(row=>/^(DELETE FROM ONLY|SELECT 1 FROM ONLY)/.test(row['Query Text']??''));
    assert.ok(internal.length>=11,'all generation FKs, including published pointer and queue, must execute');
    assert.equal(internal.flatMap(row=>scans(row.Plan)).some(row=>row['Node Type']==='Seq Scan'),false);
    await worker.query('SET auto_explain.log_min_duration=-1');
    assert.deepEqual((await worker.query(settingsSql)).rows[0],initialSettings,'transaction-local planner policy cannot leak into the pool');
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rowCount,0);
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[oldId])).rowCount,0);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM snapshot_directory_evidence WHERE directory_id=$1',[liveId])).rows[0].n,1000000);
    assert.deepEqual((await store.pool.query(statsSql)).rows,oldStats);
    const report={otherRows:1000000,deletedRows:deleted,batches,finishMs,baselineBlocks,afterBlocks,emptinessBlocks,internalFks:internal.length,
      baseline:beforePlans,final:afterPlans,statsUnchanged:true};
    if (process.env.WTR_RECLAMATION_SCALE_REPORT) await writeFile(process.env.WTR_RECLAMATION_SCALE_REPORT,JSON.stringify(report,null,2));
    console.log(JSON.stringify({otherRows:1000000,deletedRows:deleted,batches,finishMs,baselineBlocks,afterBlocks,internalFks:internal.length,statsUnchanged:true}));
  } finally {
    await worker.query('SET auto_explain.log_min_duration=-1').catch(()=>undefined);
    await store.pool.query('ALTER TABLE snapshot_directory_evidence RESET (autovacuum_enabled)').catch(()=>undefined);
    await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=ANY($1::text[])',[keys]).catch(()=>undefined);
    await Promise.all([worker.end(),store.close()]); await rm(root,{recursive:true,force:true});
  }
});
