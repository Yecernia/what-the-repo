import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
import { buildSnapshotQueryDirectory, querySnapshotQueryDirectory, type SnapshotQueryInput, type SnapshotQueryResult } from '../domain/snapshot-query.js';
import { readSnapshotQuery } from './snapshot-query-reader.js';
import type { Pool } from 'pg';
const url = process.env.WTR_STORAGE_TEST_DATABASE_URL ?? process.env.WTR_ADMIN_TEST_DATABASE_URL;
function canonical(result: SnapshotQueryResult) {
  const copy=structuredClone(result);
  for(const field of ['evidence','evidence_links','layers','value_points','memberships','projections','aggregates'] as const)
    (copy[field] as unknown[])?.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return copy;
}
async function withQueryFixture(task: (store: PostgresStore, key: string, snapshotId: string, view: NonNullable<ReturnType<typeof asEvidenceSnapshot>>, analysis: Record<string, unknown>) => Promise<void>): Promise<void> {
  assert.equal(new URL(url!).hostname, '127.0.0.1');
  assert.match(new URL(url!).pathname,/^\/wtr_(storage|admin)_test_[a-z0-9_]+$/);
  const root=await mkdtemp(join(tmpdir(),'wtr-query-contract-'));
  const store=new PostgresStore({databaseUrl:url!,root,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:'query-contract-test-only',poolMax:2});
  const key=createHash('sha256').update(randomUUID()).digest('hex'),snapshotId='snap:'+key.slice(0,12);
  const evidence={stable_id:'proof:A',label:'源码',path:'src/a.ts',start_line:1,end_line:2,kind:'symbol'};
  const nodes=['A','B','C','D','cycle1','cycle2'].map((id,i)=>({id,name:id,label:id,responsibility:i===0?'入口 session code':'other '+id,
    entity_kind:i===0?'subsystem':'component',parent_entity_id:i===0?null:i<4?String.fromCharCode(64+i):i===4?'cycle2':'cycle1',depth:i,
    members:i===0?[evidence]:[],evidence:i===0?[evidence]:[],attributes:{path:'src/'+id+'.ts',language:i%2?'typescript':'TS',quoted:'a"b',tag:'entry_tag',note:'hello world'}}));
  const edges=['A','B','C'].map((id,i)=>({id:'edge:'+id,source:id,target:String.fromCharCode(66+i),relation_kind:'calls',weight:i+1,label:'call '+id,description:'connect',evidence:i===0?[evidence]:[]}));
  const view=asEvidenceSnapshot({snapshot_id:snapshotId,summary:{file_count:6,symbol_count:6,call_count:3},graph:{nodes,edges,layers:[],unassigned_component_ids:[]},value_points:[],languages:[],learning_plan:{steps:[]}})!;
  assert.ok(view);
  try {
    await store.init();await mkdir(store.publicSourceSnapshotRoot(key,snapshotId),{recursive:true});
    const analysis={fact_graph:{nodes:[],edges:[]}};
    await store.savePublicSnapshot({publicKey:key,repository:'test/query-'+key.slice(0,8),commitSha:'a'.repeat(40),snapshotId,view,analysis});
    await task(store,key,snapshotId,view,analysis);
  } finally {
    await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key]).catch(()=>undefined);
    await store.close();await rm(root,{recursive:true,force:true});
  }
}

test('PostgreSQL ranked pages match the in-memory contract for filters, scopes, cycles, budgets and continuation', {skip:!url}, async () => {
  await withQueryFixture(async (store,key,snapshotId,view,analysis) => {
    const directory=buildSnapshotQueryDirectory(key,snapshotId,view,analysis);
    const cases:SnapshotQueryInput[]=[{}, {text:'session'}, {text:'源码'}, {text:'entry_tag'}, {text:'entry_tag',expand_hops:1},
      {text:'entryXtag'}, {text:'e'}, {text:'on'}, {text:'hello world'}, {text:'ENTRY_TAG'}, {text:'absent'},
      {text:'"tag":"entry_tag"'}, {text:'a\\"b'},
      {paths:['src/A']},{paths:['%']},{languages:['ts']},{symbol_ids:['B']},{entity_ids:['A'],scope:'self'},
      {component_ids:['A'],scope:'subtree'}, {entity_ids:['D'],scope:'ancestors'}, {entity_ids:['B'],scope:'neighbors'},
      {entity_ids:['cycle1'],scope:'ancestors'}, {entity_ids:['cycle1'],scope:'subtree'},
      {entity_ids:['A'],expand_hops:1},{entity_ids:['A'],expand_hops:2}, {depth:1},{entity_kinds:['component']},
      {personalized_entity_ids:['D']},{relation_kinds:['missing']},{projection:'human'}, {entity_ids:['missing']},
      {text:'  session  ',include_metadata:false},{evidence_budget_tokens:256},{scope:'subtree',include_metadata:false},
      {paths:['missing/path.ts']},{paths:['src/B.ts']},{paths:['src/B'],relation_kinds:['calls']},
      {paths:['src/B'],expand_hops:1},{paths:['src/B'],languages:['typescript']},{paths:['src/B'],languages:['python']},
      {paths:['src/B'],symbol_ids:['B']},{paths:['src/B'],entity_kinds:['subsystem']},
      {paths:['src/B','src/D']},{paths:['_']},{paths:['src/B'],include_payload:false,evidence_per_owner:{node:8,edge:4}},
      {include_payload:false,evidence_per_owner:{node:1,edge:1},evidence_budget_tokens:256}];
    let pages=0;
    for(const base of cases){let cursor:string|null=null;const visited=new Set<string>();
      for(let page=0;page<20;page++){
        const query: SnapshotQueryInput={...base,limit:2,cursor};
        const expected=querySnapshotQueryDirectory(directory,query);
        const actual=await store.queryPublicSnapshot({publicKey:key,snapshotId,query});
        assert.deepEqual(canonical(actual),canonical(expected),JSON.stringify(query));pages++;
        cursor=actual.next_cursor;if(!cursor)break;
        assert.ok(!visited.has(cursor),'cursor must advance');visited.add(cursor);
      }
    }
    const oneHop=await store.queryPublicSnapshot({publicKey:key,snapshotId,query:{entity_ids:['A'],expand_hops:1,limit:100}});
    assert.deepEqual(new Set(oneHop.nodes.map(n=>n.node_id)),new Set(['A','B']),'one hop cannot cascade through an edge chain');
    await assert.rejects(store.queryPublicSnapshot({publicKey:key,snapshotId:'wrong-snapshot',query:{}}),/snapshot_query_not_found/);
    assert.ok(pages>30);
    console.log(JSON.stringify({ queryContractCases: cases.length, pages }));
  });
});

test('PostgreSQL search-column migration preserves values and indexes', {skip:!url}, async () => {
  await withQueryFixture(async (store,key) => {
    // Exercise backfill on existing rows, not only new publications. The legacy
    // views must keep their shape and public results must not leak search data.
    const before=(await store.pool.query('SELECT * FROM snapshot_query_nodes WHERE public_snapshot_key=$1 ORDER BY node_key',[key])).rows;
    await store.pool.query(await readFile(join(process.cwd(),'migrations/0024_snapshot_text_search.down.sql'),'utf8'));
    await store.pool.query(await readFile(join(process.cwd(),'migrations/0024_snapshot_text_search.sql'),'utf8'));
    assert.deepEqual((await store.pool.query('SELECT * FROM snapshot_query_nodes WHERE public_snapshot_key=$1 ORDER BY node_key',[key])).rows,before);
    const normalized=await store.pool.query(`SELECT bool_and(n.search_text=lower(concat_ws(' ',NULLIF(n.node_key,''),NULLIF(n.node_id,''),NULLIF(n.name,''),NULLIF(n.label,''),NULLIF(n.responsibility,''),NULLIF(n.path,''),NULLIF(n.payload::text,'')))) AS same
      FROM snapshot_directory_nodes n JOIN snapshot_query_directories d USING(directory_id) WHERE d.public_snapshot_key=$1`,[key]);
    assert.equal(normalized.rows[0].same,true);
    const db=await store.pool.connect();
    try {
      await db.query('BEGIN');await db.query('SET LOCAL enable_seqscan=off');
      for(const table of ['nodes','edges']) {
        const plan=await db.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM snapshot_directory_${table} WHERE search_text LIKE $1`,['%session%']);
        assert.match(JSON.stringify(plan.rows),new RegExp(`snapshot_directory_${table}_text_idx`));
      }
    } finally {await db.query('ROLLBACK');db.release();}
  });
});

test('Agent evidence hydration caps distinct IDs and retains their role links', {skip:!url},async()=>{
  await withQueryFixture(async(store,key,snapshotId,view,analysis)=>{
    const refs=Array.from({length:30},(_,i)=>({stable_id:'many:'+String(i).padStart(3,'0'),label:'proof',path:'src/A.ts',start_line:i+1,end_line:i+1,kind:'symbol'}));
    view.graph.nodes[0]!.evidence=refs;view.graph.nodes[0]!.members=refs;
    view.graph.edges[0]!.evidence=refs;
    await store.savePublicSnapshot({publicKey:key,repository:'test/query-'+key.slice(0,8),commitSha:'a'.repeat(40),snapshotId,view,analysis});
    const directory=buildSnapshotQueryDirectory(key,snapshotId,view,analysis);
    const query:SnapshotQueryInput={entity_ids:['A'],include_metadata:false,include_payload:false,
      evidence_per_owner:{node:8,edge:4},evidence_budget_tokens:4000,limit:8};
    const actual=await store.queryPublicSnapshot({publicKey:key,snapshotId,query});
    const expected=querySnapshotQueryDirectory(directory,query);
    assert.deepEqual(canonical(actual),canonical(expected));
    assert.equal(actual.evidence_truncated,true);
    assert.equal(actual.nodes.length,1);assert.equal(actual.edges.length,1);
    assert.equal(actual.evidence.length,8);
    assert.ok(actual.nodes.every(row=>Object.keys(row.payload).length===0));
    assert.equal(new Set(actual.evidence_links.filter(link=>link.owner_kind==='node').map(link=>link.evidence_id)).size,8);
    const full=await store.queryPublicSnapshot({publicKey:key,snapshotId,query:{entity_ids:['A'],limit:8}});
    assert.equal(full.evidence.length,30,'full public queries still return all references');
  });
});

test('evidence-heavy owners scan their links once and keep distinct-ID role semantics', {skip:!url,timeout:60000},async()=>{
  await withQueryFixture(async(store,key,snapshotId,view,analysis)=>{
    const refs=Array.from({length:3500},(_,i)=>({stable_id:'proof:'+String(i).padStart(5,'0'),
      label:'proof',path:'src/A.ts',start_line:i+1,end_line:i+1,kind:'symbol'}));
    view.graph.nodes[0]!.evidence=refs;view.graph.nodes[0]!.members=refs;
    view.graph.nodes[1]!.evidence=[refs[0]!];view.graph.edges[0]!.evidence=refs;
    await store.savePublicSnapshot({publicKey:key,repository:'test/query-'+key.slice(0,8),commitSha:'a'.repeat(40),snapshotId,view,analysis});
    await store.pool.query('ANALYZE snapshot_directory_evidence_links');
    const directory=buildSnapshotQueryDirectory(key,snapshotId,view,analysis);
    const query:SnapshotQueryInput={entity_ids:['A','B'],include_metadata:false,include_payload:false,
      evidence_per_owner:{node:8,edge:4},limit:8};
    const statements:Array<{text:string;values:unknown[]}> = [];
    const observed={connect:async()=>{
      const client=await store.pool.connect();
      return {release:(destroy?:boolean)=>client.release(destroy),query:(text:string,values?:unknown[])=>{
        if(text.includes('AS owner(key)'))statements.push({text,values:values!});
        return client.query(text,values);
      }};
    }} as unknown as Pool;
    const request={publicKey:key,snapshotId,query};
    const actual=await readSnapshotQuery(observed,request);assert.ok(actual);
    assert.deepEqual(canonical(actual),canonical(querySnapshotQueryDirectory(directory,query)));
    assert.equal(actual.evidence_truncated,true);
    assert.ok(actual.evidence_links.filter(link=>link.owner_key==='component:A'&&link.evidence_id===refs[0]!.stable_id).length>=2,
      'one distinct evidence ID must retain its separate member and evidence roles');
    let visited=0;
    const visit=(plan:Record<string,any>)=>{
      if(plan['Relation Name']==='snapshot_directory_evidence_links')
        visited+=(plan['Actual Rows']+(plan['Rows Removed by Filter']??0)) * plan['Actual Loops'];
      for(const child of plan.Plans??[])visit(child);
    };
    assert.equal(statements.length,2);
    for(const statement of statements){
      const plan=(await store.pool.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+statement.text,statement.values)).rows[0]['QUERY PLAN'][0];
      visit(plan.Plan);
    }
    assert.ok(visited<=directory.evidence_links.length*2,
      `link visits ${visited} must stay linear in owner links ${directory.evidence_links.length}`);
    for(const result of await Promise.all(Array.from({length:5},()=>readSnapshotQuery(store.pool,request))))
      assert.deepEqual(canonical(result!),canonical(actual));
    console.log(JSON.stringify({evidenceHeavyLinks:directory.evidence_links.length,visited,returnedEvidence:actual.evidence.length}));
  });
});
