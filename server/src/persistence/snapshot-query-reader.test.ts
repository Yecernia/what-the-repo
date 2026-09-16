import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
import { buildSnapshotQueryDirectory, querySnapshotQueryDirectory, type SnapshotQueryInput, type SnapshotQueryResult } from '../domain/snapshot-query.js';
const url = process.env.WTR_STORAGE_TEST_DATABASE_URL ?? process.env.WTR_ADMIN_TEST_DATABASE_URL;
function canonical(result: SnapshotQueryResult) {
  const copy=structuredClone(result);
  for(const field of ['evidence','evidence_links','layers','value_points','memberships','projections','aggregates'] as const)
    (copy[field] as unknown[])?.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return copy;
}
test('PostgreSQL ranked pages match the in-memory contract for filters, scopes, cycles, budgets and continuation', {skip:!url}, async () => {
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
    const directory=buildSnapshotQueryDirectory(key,snapshotId,view,analysis);
    const cases:SnapshotQueryInput[]=[{}, {text:'session'}, {text:'源码'}, {text:'entry_tag'}, {text:'"tag":"entry_tag"'}, {text:'a\\"b'},
      {paths:['src/A']},{paths:['%']},{languages:['ts']},{symbol_ids:['B']},{entity_ids:['A'],scope:'self'},
      {component_ids:['A'],scope:'subtree'}, {entity_ids:['D'],scope:'ancestors'}, {entity_ids:['B'],scope:'neighbors'},
      {entity_ids:['cycle1'],scope:'ancestors'}, {entity_ids:['cycle1'],scope:'subtree'},
      {entity_ids:['A'],expand_hops:1},{entity_ids:['A'],expand_hops:2}, {depth:1},{entity_kinds:['component']},
      {personalized_entity_ids:['D']},{relation_kinds:['missing']},{projection:'human'}, {entity_ids:['missing']},
      {text:'  session  ',include_metadata:false},{evidence_budget_tokens:256},{scope:'subtree',include_metadata:false}];
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
  } finally {
    await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key]).catch(()=>undefined);
    await store.close();await rm(root,{recursive:true,force:true});
  }
});
