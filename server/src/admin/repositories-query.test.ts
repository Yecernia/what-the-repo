import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminRepositories } from './repositories.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { loadConfig } from '../config.js';

test('stored repository pages use bounded metadata queries and cached accounting', async () => {
  const keys=Array.from({length:25},(_,i)=>(i+1).toString(16).padStart(64,'0'));
  const repositories=keys.map((key,i)=>({
    repository_identity:`fixture/repo${i}`,keys:[key],legacy_projects:[],
    versions:1,created_at:'2026-09-25T00:00:00Z',
  }));
  const calls:string[]=[];
  const pool={async query(sql:string) {
    calls.push(sql);
    if(sql.includes('SELECT count(*) AS n FROM stored')) return {rows:[{n:25}]};
    if(sql.includes('SELECT * FROM stored ORDER BY')) return {rows:repositories};
    if(sql.includes('jsonb_build_object'))
      return {rows:[{value:{observedAt:new Date().toISOString(),totalBytes:0,snapshotBytes:{}}}]};
    if(sql.includes('WITH owners AS')) return {rows:[{
      repository_identity:'fixture/repo0',owner_id:'github:1',login:'one',
      display_name:'One',online:false,user_count:1,rank:1,
    }]};
    if(sql.includes('WITH snapshots AS')) return {rows:[]};
    if(sql.includes('SELECT key,value FROM admin_documents')) return {rows:[]};
    throw new Error('Unexpected SQL: '+sql);
  }};
  const store=Object.assign(Object.create(PostgresStore.prototype),{
    root:'unused',pool,adminPool:pool,
  }) as PostgresStore;
  const admin=new AdminRepositories(store,loadConfig({}));
  admin.localBytes=async()=>{throw new Error('An admin GET must not scan files');};
  admin.databaseBytes=async()=>{throw new Error('An admin GET must not count fact tables');};

  const result=await admin.stored(1);
  assert.equal(result.storedRepositories.length,25);
  assert.equal(result.storedRepositories[0].user_count,1);
  assert.equal(result.storedRepositories[0].host_file_bytes,null);
  assert.equal(result.storedRepositories[0].database_bytes,null);
  assert.equal(calls.length,7,'SQL count stays fixed as page fills');
});

test('activity cohorts are fetched once for the page', async () => {
  const calls:string[]=[];
  const pool={async query(sql:string) {
    calls.push(sql);
    if(sql.includes('SELECT count(*) AS n FROM latest')) return {rows:[{n:25}]};
    if(sql.includes('SELECT * FROM latest ORDER BY')) return {rows:Array.from({length:25},(_,i)=>({
      repository_identity:`fixture/repo${i}`,batch_id:`batch${i}`,status:'completed',analysis:null,
    }))};
    if(sql.includes('WITH selected AS')) return {rows:[{
      repository_identity:'fixture/repo0',batch_id:'batch0',owner_id:'github:1',
      login:'one',display_name:'One',online:false,user_count:1,rank:1,
    }]};
    throw new Error('Unexpected SQL: '+sql);
  }};
  const store=Object.assign(Object.create(PostgresStore.prototype),{root:'unused',pool,adminPool:pool}) as PostgresStore;
  const result=await new AdminRepositories(store,loadConfig({})).activity(1);
  assert.equal(result.repositories.length,25);
  assert.equal(result.repositories[0].user_count,1);
  assert.equal(calls.length,3);
});
