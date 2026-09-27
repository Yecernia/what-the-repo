import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { LocalSnapshotObjectStore } from './snapshot-object-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { writeDirectoryObjects } from './directory-objects.js';
import type { SnapshotQueryDirectory } from '../domain/snapshot-query.js';

test('exact evidence lookups hydrate only matching COS rows and preserve snapshot scope and requested order',async()=>{
  const root=await mkdtemp(join(tmpdir(),'what-the-repo-evidence-'));
  const objects=new LocalSnapshotObjectStore(root),publicKey='a'.repeat(64);
  const store=new PostgresStore({databaseUrl:'postgresql://unused',root,migrationsRoot:join(root,'migrations'),
    encryptionSecret:'evidence-test-secret',objectStore:objects,objectAdmissionStore:new LocalPermitStore()});
  const originalPool=store.pool;
  const directory:SnapshotQueryDirectory={public_snapshot_key:publicKey,snapshot_id:'snapshot',digest:'digest',nodes:[],edges:[],evidence_links:[],
    layers:[],value_points:[],memberships:[],projections:[],aggregates:[],evidence:['a','b'].map(evidence_id=>({
      public_snapshot_key:publicKey,snapshot_id:'snapshot',evidence_id,label:evidence_id,path:'src/a.ts',start_line:1,end_line:2,
      kind:'symbol',source_id:null,target_id:null,payload:{}}))};
  const manifest=await writeDirectoryObjects(objects,directory,'42');
  store.loadPublicSnapshot=async()=>{throw new Error('must not load full canonical snapshot');};
  let lookups=0,released=0;
  const calls:string[]=[];
  const client={release(){released++;},async query(sql:string,values:unknown[]=[]){calls.push(sql);
    if(sql.includes('g.object_manifest'))return{rows:values[0]===publicKey?[{snapshot_id:'snapshot',schema_version:3,directory_digest:'digest',directory_id:'42',object_manifest:manifest}]:[]};
    if(sql.startsWith('SELECT row_no,evidence_id')){lookups++;assert.deepEqual(values,['42',['b','a','missing']]);return{rows:[{row_no:0,evidence_id:'a'},{row_no:1,evidence_id:'b'}]};}
    return{rows:[]};
  }};
  (store as unknown as {pool:Pool}).pool={connect:async()=>client} as unknown as Pool;
  try{
    const input={publicKey,snapshotId:'snapshot',evidenceIds:['b','a','missing','b']};
    assert.deepEqual((await store.readPublicSnapshotEvidence(input)).map(row=>row.stable_id),['b','a']);
    assert.deepEqual(await store.readPublicSnapshotEvidence({...input,snapshotId:'other'}),[]);
    assert.deepEqual(await store.readPublicSnapshotEvidence({...input,publicKey:'b'.repeat(64)}),[]);
    assert.deepEqual(await store.readPublicSnapshotEvidence({...input,evidenceIds:[]}),[]);
    await assert.rejects(store.readPublicSnapshotEvidence({...input,evidenceIds:Array(21).fill('a')}),/request_invalid/);
    assert.equal(lookups,1);assert.equal(released,3);
    const transaction=calls.findIndex(sql=>sql.startsWith('BEGIN'));
    const localJit=calls.findIndex(sql=>sql.includes('SET LOCAL jit=off'));
    const metadata=calls.findIndex(sql=>sql.includes('g.object_manifest'));
    assert.ok(transaction>=0&&localJit>transaction&&metadata>localJit,
      'interactive lookup disables compilation only inside its read transaction, before querying inherited tables');
    assert.ok(!calls.some(sql=>sql.includes('view_payload')||sql.includes('snapshot_query_evidence')));
  }finally{await originalPool.end();await store.controlPool.end();await rm(root,{recursive:true,force:true});}
});
