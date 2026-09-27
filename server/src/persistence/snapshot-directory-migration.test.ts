import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { applyMigrations } from './migrations.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
const ownerUrl=process.env.WTR_STORAGE_TEST_DATABASE_URL??process.env.WTR_ADMIN_TEST_DATABASE_URL;

test('object directory migration rejects old storage and preserves restricted runtime/read-only privileges',
  {skip:!ownerUrl,timeout:60000},async()=>{
  const url=new URL(ownerUrl!);assert.equal(url.hostname,'127.0.0.1');
  assert.match(url.pathname,/^\/wtr_(storage|admin)_test_[a-z0-9_]+$/);
  const root=await mkdtemp(join(tmpdir(),'wtr-directory-migration-'));
  const migrationsRoot=join(process.cwd(),'migrations'),legacyRoot=join(root,'legacy-migrations');await mkdir(legacyRoot);
  for(const name of await readdir(migrationsRoot))if(/^\d+_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=37)
    await copyFile(join(migrationsRoot,name),join(legacyRoot,name));
  const store=new PostgresStore({root,databaseUrl:url.toString(),migrationsRoot:legacyRoot,encryptionSecret:'migration-test-only',poolMax:2});
  const suffix=randomUUID().replaceAll('-',''),runtimeRole=`wtr_storage_test_${suffix}_runtime`,readerRole=`wtr_storage_test_${suffix}_reader`;
  const roleUrl=(role:string)=>{const result=new URL(url);result.searchParams.set('options',`-c role=${role}`);return result.toString();};
  let runtime:PostgresStore|undefined,reader:Pool|undefined;
  const key=createHash('sha256').update(suffix).digest('hex'),snapshotId='snap:migration:'+suffix;
  try{
    await store.init();
    await store.pool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN; CREATE ROLE "${readerRole}" NOLOGIN`);
    await store.pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${readerRole}";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}";
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${readerRole}";
      GRANT EXECUTE ON FUNCTION public.stage_snapshot_directory_child(bigint,text),
        public.finish_snapshot_directory_child(bigint,text,bigint),public.drop_retired_snapshot_directory_child(bigint,text) TO "${runtimeRole}"`);
    const stale=(await store.pool.query(`INSERT INTO snapshot_directory_generations(public_snapshot_key,snapshot_id)
      VALUES($1,$2) RETURNING directory_id`,[key,snapshotId])).rows[0].directory_id;
    await assert.rejects(applyMigrations(store.pool,migrationsRoot),/storage_format_reset_required/);
    assert.equal((await store.pool.query("SELECT 1 FROM schema_migrations WHERE version='0038_object_query_directory'")).rowCount,0);
    assert.equal((await store.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='snapshot_directory_nodes' AND column_name='payload'")).rowCount,1,
      'preflight failure must leave the old schema intact');
    await store.pool.query('DELETE FROM snapshot_directory_generations WHERE directory_id=$1',[stale]);
    await applyMigrations(store.pool,migrationsRoot);
    runtime=new PostgresStore({root,databaseUrl:roleUrl(runtimeRole),migrationsRoot,encryptionSecret:'migration-test-only',poolMax:2});
    reader=new Pool({connectionString:roleUrl(readerRole),max:1});
    assert.equal((await runtime.pool.query('SELECT current_user AS name')).rows[0].name,runtimeRole);
    assert.equal((await runtime.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,false);
    await assert.rejects(runtime.pool.query('CREATE TABLE public.forbidden_runtime_ddl(id integer)'),{code:'42501'});
    const evidence={stable_id:'proof',label:'proof',path:'src/a.ts',start_line:1,end_line:2,kind:'symbol'};
    const view=asEvidenceSnapshot({snapshot_id:snapshotId,graph:{nodes:[{id:'A',name:'A',responsibility:'test',members:[evidence],evidence:[evidence]}],edges:[],layers:[]},value_points:[],learning_plan:{steps:[]}})!;
    const sourceRoot=join(root,'source');await mkdir(sourceRoot);
    const input={publicKey:key,repository:'test/migration',commitSha:'a'.repeat(40),snapshotId,view,analysis:{fact_graph:{nodes:[],edges:[]}},sourceRoot};
    await runtime.savePublicSnapshot(input);
    const expected=await runtime.queryPublicSnapshot({publicKey:key,snapshotId,query:{entity_ids:['A'],include_metadata:false}});
    assert.equal(expected.nodes[0]?.node_id,'A');assert.equal(expected.evidence[0]?.evidence_id,'proof');
    const retiredId=(await reader.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[key])).rows[0].directory_id;
    assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_directory_nodes WHERE directory_id=$1',[retiredId])).rows[0].n,1);
    for(const table of ['snapshot_directory_nodes','snapshot_directory_object_intents','snapshot_directory_reclamation'])
      await assert.rejects(reader.query(`DELETE FROM ${table} WHERE false`),{code:'42501'});
    assert.match(String(retiredId),/^[1-9][0-9]*$/);
    await assert.rejects(runtime.pool.query(`INSERT INTO snapshot_directory_evidence_links_g${retiredId}
      (directory_id,owner_kind,owner_no,evidence_no,role) VALUES($1,0,0,99999,0)`,[retiredId]),{code:'23503'});
    await runtime.savePublicSnapshot(input);
    assert.equal((await reader.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[retiredId])).rowCount,1);
    for(let pass=0;pass<30;pass++){
      const batch=await reclaimSnapshotDirectoryBatch(runtime.pool);assert.notEqual(batch.status,'retry',batch.errorCode);
      if(!(await reader.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[retiredId])).rowCount)break;
    }
    assert.equal((await reader.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',[retiredId])).rowCount,0);
    assert.deepEqual(await runtime.queryPublicSnapshot({publicKey:key,snapshotId,query:{entity_ids:['A'],include_metadata:false}}),expected);
    assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_directory_object_intents')).rows[0].n,0,'successful binding transfers upload ownership into the full manifest');
  }finally{
    await Promise.all([runtime?.close(),reader?.end()]);
    await store.pool.query(`DROP OWNED BY "${runtimeRole}","${readerRole}"`).catch(()=>undefined);
    await store.pool.query(`DROP ROLE IF EXISTS "${runtimeRole}","${readerRole}"`).catch(()=>undefined);
    await store.close();await rm(root,{recursive:true,force:true});
  }
});