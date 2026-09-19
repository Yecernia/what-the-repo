import { LocalPermitStore } from '../scheduling/permits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { PostgresStore } from './postgres-store.js';
import { jsonBytes, snapshotObjectDigest, type SnapshotObjectStore } from './snapshot-object-store.js';
import { createProject } from '../domain/conversation.js';

test('view/analysis readers avoid the other payload while preserving requested-object and manifest checks', async () => {
  const key='f'.repeat(64),snapshotId='parts-test',timestamp='2026-09-15T00:00:00Z';
  const view={snapshot_id:snapshotId,graph:{nodes:[],edges:[],layers:[]},value_points:[],learning_plan:{steps:[]}};
  const analysis={fact_graph:{nodes:[],edges:[]},note:'unchanged analysis'};
  const bodies=new Map([['view',jsonBytes(view)],['analysis',jsonBytes(analysis)]]);
  const objects=[...bodies].map(([kind,body])=>({kind,key:kind,bytes:body.byteLength,sha256:snapshotObjectDigest(body)}));
  const manifest=jsonBytes({schema_version:1,public_snapshot_key:key,snapshot_id:snapshotId,objects,
    query_directory:{digest:'0'.repeat(64),nodes:0,edges:0,evidence:0,layers:0,value_points:0},created_at:timestamp});
  bodies.set('manifest',manifest);const reads:string[]=[],sqls:string[]=[];
  const storage:SnapshotObjectStore={kind:'local',get:async k=>{reads.push(k);return bodies.get(k)??null;},put:async()=>{throw Error('unexpected write');},delete:async()=>{throw Error('unexpected delete');}};
  const row={repository_identity:'test/parts',commit_sha:'a'.repeat(40),analyzer_bundle_version:'test',analysis_config_digest:'test',analysis_snapshot_id:snapshotId,
    source_storage_key:'source',reuse_count:'0',logical_bytes:'1',created_at:timestamp,last_used_at:null,
    view_payload:null as typeof view|null,analysis_payload:null,view_storage_key:'view',analysis_storage_key:'analysis',
    manifest_storage_key:'manifest',manifest_sha256:snapshotObjectDigest(manifest),manifest_bytes:String(manifest.byteLength),
    view_sha256:objects[0].sha256,view_bytes:String(objects[0].bytes),analysis_sha256:objects[1].sha256,analysis_bytes:String(objects[1].bytes),
    source_manifest_sha256:null,source_manifest_bytes:null,source_file_count:0,language_overlay_version:null,retired_at:null,purge_after:null,payload_purged_at:null};
  const store=new PostgresStore({databaseUrl:'postgresql://unused',objectAdmissionStore:new LocalPermitStore(),root:tmpdir(),migrationsRoot:tmpdir(),encryptionSecret:'parts-test-only-secret',objectStore:storage});
  const pool=store.pool;Object.assign(store,{pool:{query:async(sql:string)=>{sqls.push(sql);return{rows:sql.includes('FROM project_public_snapshot_bindings')?[{public_snapshot_key:key}]:[row]};}}});
  store.loadProject=async()=>createProject('guest:test','https://github.com/test/parts','parts');
  try {
    assert.deepEqual(await store.loadSnapshot('project'),view);
    assert.deepEqual(reads,['manifest','view']);
    assert.ok(sqls.some(sql=>sql.includes('NULL AS analysis_payload')));
    const offset=reads.length;
    assert.deepEqual(await store.loadAnalysisResult('project'),analysis);
    assert.deepEqual(reads.slice(offset),['manifest','analysis']);
    assert.ok(sqls.some(sql=>sql.includes('NULL AS view_payload')));
    const full=await store.loadPublicSnapshot(key);
    assert.deepEqual(full?.view,view);
    assert.deepEqual(full?.analysis,analysis);
    // Missing unrelated analysis must not break the view-only read.
    const originalAnalysis = bodies.get('analysis')!;
    bodies.delete('analysis');
    assert.deepEqual(await store.loadSnapshot('project'), view);
    await assert.rejects(store.loadAnalysisResult('project'), /snapshot_object_missing/);
    await assert.rejects(store.loadPublicSnapshot(key), /snapshot_object_missing/);
    bodies.set('analysis', originalAnalysis);
    const originalView = bodies.get('view')!;
    bodies.set('view', jsonBytes({ ...view, unexpected: true }));
    await assert.rejects(store.loadSnapshot('project'), /snapshot_object_integrity_mismatch/);
    assert.deepEqual(await store.loadAnalysisResult('project'), analysis);
    bodies.set('view', originalView);
    bodies.set('manifest', jsonBytes({ invalid: true }));
    await assert.rejects(store.loadSnapshot('project'), /snapshot_object_integrity_mismatch/);
    bodies.set('manifest', manifest);
    row.view_sha256 = '1'.repeat(64);
    await assert.rejects(store.loadSnapshot('project'), /public_snapshot_manifest_metadata_mismatch/);
    row.view_sha256 = objects[0].sha256;
    assert.deepEqual(await store.loadSnapshot('project'), view);

  } finally {await pool.end();}
});
