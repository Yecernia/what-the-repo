import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresPermitStore, type PermitRow } from './permits.js';
import { defaultRuntimeMetrics } from '../observability/metrics.js';

function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

class FakeControlPool {
  rows=new Map<string,Map<string,PermitRow>>();
  transactions=0;
  destroyed=0;
  waitingCount=0;
  connectGate?:ReturnType<typeof deferred<void>>;
  connectStarted?:()=>void;
  hangInsertOnce=false;
  insertStarted?:()=>void;
  hangCommitOnce=false;
  commitStarted?:()=>void;
  hangRollbackOnce=false;
  failRollbackOnce=false;
  rollbackStarted?:()=>void;
  lockUnavailableFor?:string;

  async connect() {
    this.connectStarted?.();
    await this.connectGate?.promise;
    let transaction:Map<string,Map<string,PermitRow>>|undefined;
    const client={
      query:async (sql:string,values:unknown[]=[])=>{
        if(sql==='BEGIN') {
          this.transactions++;
          transaction=structuredClone(this.rows);
          return {rows:[]};
        }
        if(sql.startsWith('SET LOCAL'))return {rows:[]};
        if(sql.includes('pg_try_advisory_xact_lock'))
          return {rows:[{acquired:values[0]!==`admission:${this.lockUnavailableFor}`}]};
        if(sql.includes('FROM now_value')) {
          const namespace=values[0] as string;
          const payloads=[...(transaction?.get(namespace)?.values()??[])];
          const now=String(Date.now());
          return {rows:payloads.length?payloads.map(payload=>({payload:structuredClone(payload),now})):[{payload:null,now}]};
        }
        if(sql.startsWith('DELETE FROM runtime_permits')) {
          const [namespace,ids]=values as [string,string[]];
          for(const id of ids)transaction?.get(namespace)?.delete(id);
          return {rows:[]};
        }
        if(sql.startsWith('INSERT INTO runtime_permits')) {
          if(this.hangInsertOnce) {
            this.hangInsertOnce=false;
            this.insertStarted?.();
            return new Promise<{rows:unknown[]}>(()=>{});
          }
          const [namespace,json]=values as [string,string];
          const changed=JSON.parse(json) as Array<{permit_id:string;payload:PermitRow}>;
          const current=transaction?.get(namespace)??new Map<string,PermitRow>();
          for(const row of changed)current.set(row.permit_id,structuredClone(row.payload));
          transaction?.set(namespace,current);
          return {rows:[]};
        }
        if(sql==='COMMIT') {
          if(this.hangCommitOnce) {
            this.hangCommitOnce=false;
            this.commitStarted?.();
            return new Promise<{rows:unknown[]}>(()=>{});
          }
          this.rows=transaction!;
          transaction=undefined;
          return {rows:[]};
        }
        if(sql==='ROLLBACK') {
          if(this.hangRollbackOnce) {
            this.hangRollbackOnce=false;
            this.rollbackStarted?.();
            return new Promise<{rows:unknown[]}>(()=>{});
          }
          if(this.failRollbackOnce) {
            this.failRollbackOnce=false;
            throw new Error('rollback_failed');
          }
          transaction=undefined;
          return {rows:[]};
        }
        throw new Error('unexpected_fake_sql');
      },
      release:(destroy=false)=>{if(destroy)this.destroyed++;transaction=undefined;},
    };
    return client;
  }

  asPool():Pool {return this as unknown as Pool;}
}

function row(id:string,now:number):PermitRow {
  return {id,owner:'owner',resource:id,state:'running',order:1,expires:now+30000,deadline:now+30000};
}
function outstanding() {
  return defaultRuntimeMetrics.snapshot().gauges.find(item=>item.name==='what_the_repo_control_outstanding')?.value??0;
}

test('stores sharing one Pool batch FIFO callbacks and keep earlier result drafts unchanged', async()=>{
  const pool=new FakeControlPool();
  const first=new PostgresPermitStore(pool.asPool()),second=new PostgresPermitStore(pool.asPool());
  const results=await Promise.all(Array.from({length:96},(_,index)=>(index%2?first:second).change('same',
    (rows,now)=>{rows.push(row(String(index),now));return rows.map(item=>item.id);})));
  assert.equal(pool.transactions,3);
  assert.deepEqual(results[0],['0']);
  assert.deepEqual(results[95],Array.from({length:96},(_,index)=>String(index)));
  assert.equal(pool.rows.get('same')?.size,96);
  assert.equal(outstanding(),0);
});

test('a throwing or async callback does not contaminate another callback in its batch', async()=>{
  const pool=new FakeControlPool(),store=new PostgresPermitStore(pool.asPool());
  const first=store.change('isolation',(rows,now)=>{rows.push(row('first',now));return rows;});
  const bad=store.change('isolation',(rows,now)=>{rows.push(row('bad',now));throw new Error('bad_callback');});
  const asyncBad=store.change('isolation',async rows=>{rows.push(row('async_bad',Date.now()));});
  const last=store.change('isolation',(rows,now)=>{rows.push(row('last',now));return rows;});
  await assert.rejects(bad,{code:'database_control_unavailable'});
  await assert.rejects(asyncBad,{code:'database_control_unavailable'});
  const [firstResult,lastResult]=await Promise.all([first,last]);
  assert.deepEqual(firstResult.map(item=>item.id),['first']);
  assert.deepEqual(lastResult.map(item=>item.id),['first','last']);
  assert.deepEqual([...pool.rows.get('isolation')!.keys()],['first','last']);
  assert.equal(pool.transactions,1);
  assert.equal(outstanding(),0);
});

test('bulk upsert retains the old last-changed duplicate permit ID behavior', async()=>{
  const pool=new FakeControlPool(),store=new PostgresPermitStore(pool.asPool());
  await store.change('duplicate',(rows,now)=>rows.push(row('same',now)));
  await store.change('duplicate',rows=>{
    const changed={...rows[0]!,resource:'changed'};
    rows.push(changed,{...rows[0]!});
  });
  assert.equal(pool.rows.get('duplicate')?.get('same')?.resource,'changed');
  assert.equal(outstanding(),0);
});

test('queued abort and 1024-outstanding bound include callers waiting for the shared connection', async()=>{
  const pool=new FakeControlPool(),gate=deferred<void>(),started=deferred<void>();
  pool.connectGate=gate;pool.connectStarted=()=>started.resolve();
  const store=new PostgresPermitStore(pool.asPool()),cancel=new AbortController();
  const pending=Array.from({length:1024},(_,index)=>store.change('bound',(rows,now)=>{
    rows.push(row(String(index),now));
  },cancel.signal).then(()=>null,error=>error));
  await started.promise;
  assert.equal(outstanding(),1024);
  await assert.rejects(store.change('bound',()=>undefined),{code:'database_control_busy'});
  cancel.abort(new Error('cancelled_by_test'));
  gate.resolve();
  const results=await Promise.all(pending);
  assert.ok(results.every(error=>error instanceof Error && error.message==='cancelled_by_test'));
  assert.equal(pool.rows.get('bound')?.size??0,0);
  assert.equal(outstanding(),0);
});

test('precommit cancellation rolls back its whole attempt and retries surviving callers', async()=>{
  const pool=new FakeControlPool(),inserted=deferred<void>();
  pool.hangInsertOnce=true;pool.insertStarted=()=>inserted.resolve();
  const store=new PostgresPermitStore(pool.asPool()),cancel=new AbortController();
  const removed=store.change('retry',(rows,now)=>rows.push(row('removed',now)),cancel.signal);
  const kept=store.change('retry',(rows,now)=>rows.push(row('kept',now)));
  await inserted.promise;
  cancel.abort(new Error('cancelled_by_test'));
  await assert.rejects(removed,/cancelled_by_test/);
  await kept;
  assert.deepEqual([...pool.rows.get('retry')!.keys()],['kept']);
  assert.equal(pool.transactions,2);
  assert.equal(pool.destroyed,1);
  assert.equal(outstanding(),0);
});

test('a hung COMMIT exits when every caller aborts and does not replay its unknown outcome', async()=>{
  const pool=new FakeControlPool(),committing=deferred<void>();
  pool.hangCommitOnce=true;pool.commitStarted=()=>committing.resolve();
  const store=new PostgresPermitStore(pool.asPool());
  const left=new AbortController(),right=new AbortController();
  const a=store.change('commit',(rows,now)=>rows.push(row('a',now)),left.signal);
  const b=store.change('commit',(rows,now)=>rows.push(row('b',now)),right.signal);
  await committing.promise;
  left.abort(new Error('left_cancelled'));
  right.abort(new Error('right_cancelled'));
  await assert.rejects(a,/left_cancelled/);
  await assert.rejects(b,/right_cancelled/);
  await store.change('after_commit',(rows,now)=>rows.push(row('after',now)));
  assert.equal(pool.transactions,2,'the unknown COMMIT must not be replayed');
  assert.equal(pool.destroyed,1);
  assert.equal(pool.rows.get('after_commit')?.size,1);
  assert.equal(outstanding(),0);
});

for(const mode of ['hang','fail'] as const) test(`a ${mode}ing ROLLBACK after all callbacks fail destroys the client and drains later work`,
  {timeout:5000},async()=>{
    const pool=new FakeControlPool(),rollback=deferred<void>();
    pool.hangRollbackOnce=mode==='hang';pool.failRollbackOnce=mode==='fail';
    pool.rollbackStarted=()=>rollback.resolve();
    const store=new PostgresPermitStore(pool.asPool());
    const failed=store.change('rollback',()=>{throw new Error('callback_failed');});
    await assert.rejects(failed,{code:'database_control_unavailable'});
    const resumed=store.change('later',(rows,now)=>rows.push(row('after',now)));
    if(mode==='hang')await rollback.promise;
    await resumed;
    assert.equal(pool.destroyed,1);
    assert.equal(pool.rows.get('later')?.size,1);
    assert.equal(outstanding(),0);
  });
