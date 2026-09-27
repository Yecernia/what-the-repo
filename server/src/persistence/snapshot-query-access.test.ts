import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { readSnapshotQuery } from './snapshot-query-reader.js';
import { DIRECTORY_SECTIONS } from './directory-objects.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

test('exact candidate SQL uses numeric endpoint probes and never reads full payload tables',async()=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const client={async query(sql:string,values:unknown[]=[]){
    calls.push({sql,values});
    if(sql.includes('g.object_manifest'))return{rows:[{snapshot_id:'snapshot',schema_version:3,directory_digest:'digest',directory_id:'42',
      object_manifest:{version:1,sections:Object.fromEntries(DIRECTORY_SECTIONS.map(name=>[name,[]]))}}]};
    return{rows:[]};
  },release(){}};
  const pool={connect:async()=>client} as unknown as Pool;
  const objects={get:async()=>{throw new Error('empty query must not fetch objects');}} as unknown as SnapshotObjectStore;
  for(const hops of [0,1,2]){
    calls.length=0;
    await readSnapshotQuery(pool,{publicKey:'a'.repeat(64),snapshotId:'snapshot',query:{entity_ids:['precise-id'],include_metadata:false,expand_hops:hops}},objects);
    const ranked=calls.find(call=>call.sql.startsWith('WITH RECURSIVE'))!;
    assert.match(ranked.sql,/incident_edges AS MATERIALIZED/);
    assert.match(ranked.sql,/source_no=c.row_no/);assert.match(ranked.sql,/target_no=c.row_no/);
    assert.ok(calls.every(call=>!call.sql.includes('SELECT * FROM snapshot_query_nodes')));
    assert.equal(calls[0]!.sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(calls.at(-1)!.sql,'COMMIT');
  }
});