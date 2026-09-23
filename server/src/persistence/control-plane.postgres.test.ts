import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresStore } from './postgres-store.js';
import { PostgresPiSessionBackend } from './postgres-session-backend.js';
import { CapacityScheduler, PostgresPermitStore } from '../scheduling/permits.js';
import { ResourceScheduler } from '../scheduling/resources.js';
import { createProject } from '../domain/conversation.js';
import { runAbortCode } from '../services/execution-error.js';
import { defaultRuntimeMetrics } from '../observability/metrics.js';
import type { PoolClient } from 'pg';

const url=process.env.WTR_CONTROL_TEST_DATABASE_URL ?? process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('business pool saturation cannot starve chat, session, model or object renewals', {skip:!url,timeout:60000}, async()=>{
  assert.equal(new URL(url!).hostname,'127.0.0.1');
  assert.match(new URL(url!).pathname,/^\/wtr_admin_test_[a-z0-9_]+$/);
  const root=await mkdtemp(join(tmpdir(),'wtr-control-'));
  const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),
    encryptionSecret:'isolated-control-test-only',poolMax:5,connectionTimeoutMs:10000});
  const id=randomUUID(), owner='guest:'+id;
  let endSession!:()=>void, ready!:()=>void;
  const sessionReady=new Promise<void>(resolve=>{ready=resolve;});
  const sessionStop=new Promise<void>(resolve=>{endSession=resolve;});
  let sessionTask:Promise<void>|undefined;
  let sessionSignal:AbortSignal|undefined;
  const permits:Awaited<ReturnType<CapacityScheduler['acquire']>>[]=[];
  try {
    await store.init(); await store.saveUser(owner,{kind:'guest'});
    const project=createProject(owner,'https://github.com/example/control','control');await store.saveProject(project);
    const permitStore=new PostgresPermitStore(store.pool);
    assert.equal(permitStore.pool,store.controlPool,'all entry points route to the same bounded control pool');
    permits.push(await new CapacityScheduler(permitStore,'control-chat-'+id,{running:8,waiting:8,waitMs:1000}).acquire(owner,id));
    for(const lane of ['model','object']) permits.push(await new ResourceScheduler(permitStore,'control-'+lane+'-'+id)
      .acquire({owner,task:id,demands:{[lane]:{units:1,limit:2}}}));
    sessionTask=new PostgresPiSessionBackend(store.pool).withSession({ownerId:owner,projectId:project.project_id,
      sessionId:id,snapshotId:null,skillId:'primary-supervisor',skillVersion:'test'},async(session,signal)=>{
        sessionSignal=signal;await session.setName('before');ready();await sessionStop;
        signal?.throwIfAborted();await session.setName('after');
      });
    await sessionReady;
    const before=(await store.controlPool.query('SELECT permit_id,payload FROM runtime_permits')).rows;
    const clients=await Promise.all(Array.from({length:5},()=>store.pool.connect()));
    const slow=clients.map(client=>client.query('SELECT pg_sleep(24)').finally(()=>client.release()));
    try {
      await delay(21500);
      assert.ok(permits.every(permit=>!permit.signal.aborted));assert.equal(sessionSignal?.aborted,false);
      const after=(await store.controlPool.query('SELECT permit_id,payload FROM runtime_permits')).rows;
      const advances=before.map(row=>after.find(item=>item.permit_id===row.permit_id).payload.expires-row.payload.expires);
      assert.ok(Math.min(...advances)>=18000,'all permit types must renew across two intervals');
      assert.equal(store.pool.idleCount,0);assert.equal(store.controlPool.totalCount,1);
      console.log(JSON.stringify({businessConnections:5,controlConnections:1,renewedPermits:before.length,blockedMs:21500,minRenewalAdvanceMs:Math.min(...advances)}));
    } finally {await Promise.all(slow);}
    endSession();await sessionTask;
    for(const permit of permits) await permit.release();
    assert.equal((await store.controlPool.query('SELECT count(*)::int AS n FROM runtime_permits')).rows[0].n,0);
  } finally {endSession?.();await sessionTask?.catch(()=>undefined);for(const permit of permits)await permit.release();await store.close();await rm(root,{recursive:true,force:true});}
});

test('real session expiry fences writes and reports lease loss, not user cancellation', {skip:!url,timeout:25000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-control-loss-'));
  const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:'isolated-control-loss',poolMax:1});
  const owner='guest:'+randomUUID();
  try {
    await store.init();await store.saveUser(owner,{kind:'guest'});
    const project=createProject(owner,'https://github.com/example/loss','loss');await store.saveProject(project);
    await new PostgresPiSessionBackend(store.pool).withSession({ownerId:owner,projectId:project.project_id,
      sessionId:randomUUID(),snapshotId:null,skillId:'primary-supervisor',skillVersion:'test'},async(session,signal)=>{
        await session.setName('safe');
        await store.controlPool.query("UPDATE runtime_permits SET payload=jsonb_set(payload,'{expires}','0'::jsonb) WHERE namespace='session'");
        await assert.rejects(session.setName('stale'),/pi_session_lease_lost/);
        await delay(10500);assert.equal(signal?.aborted,true);assert.equal(runAbortCode(signal?.reason),'runtime_lease_lost');
        await assert.rejects(session.setName('still-stale'));
        assert.equal((await store.pool.query('SELECT name FROM pi_sessions WHERE project_id=$1',[project.project_id])).rows[0].name,'safe');
      }).catch(error=>{assert.equal(runAbortCode(error),'runtime_lease_lost');});
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});

test('a saturated control pool fails with a bounded pool error and recovers without leaked waiters',{skip:!url,timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-control-deadline-'));
  const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:'isolated-control-deadline',poolMax:1});
  try {
    await store.init();const held=await store.controlPool.connect();
    const started=performance.now();
    try {
      await assert.rejects(new PostgresPermitStore(store.pool).change('deadline-test',()=>true),{code:'database_pool_timeout'});
      assert.ok(performance.now()-started<7000);
    } finally {held.release();}
    await delay(30);
    assert.equal(store.controlPool.waitingCount,0);
    assert.equal(await new PostgresPermitStore(store.pool).change('deadline-test',()=>true),true);
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});

test('answer transaction rolls back if its session lease expires immediately before commit',{skip:!url,timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-answer-fence-'));
  const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:'isolated-answer-fence',poolMax:2});
  const owner='guest:'+randomUUID(),trigger='wtr_answer_fence_'+randomUUID().replaceAll('-','');
  try {
    await store.init();await store.saveUser(owner,{kind:'guest'});
    const project=createProject(owner,'https://github.com/example/fence','unchanged');await store.saveProject(project);
    await new PostgresPiSessionBackend(store.pool).withSession({ownerId:owner,projectId:project.project_id,
      sessionId:randomUUID(),snapshotId:null,skillId:'primary-supervisor',skillVersion:'test'},async(_session,signal,fence)=>{
      assert.ok(fence);assert.match(fence.permitId,/^[a-zA-Z0-9-]+$/);
      await store.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        UPDATE runtime_permits SET payload=jsonb_set(payload,'{expires}','0'::jsonb) WHERE permit_id='${fence.permitId}';
        RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE UPDATE ON projects FOR EACH ROW
        WHEN(NEW.project_id='${project.project_id}') EXECUTE FUNCTION ${trigger}()`);
      try {
        await assert.rejects(store.updateProject(project.project_id,owner,row=>{row.title='stale';},undefined,fence),/pi_session_lease_lost/);
        assert.equal((await store.loadProject(project.project_id,owner))?.title,'unchanged');
        assert.equal(signal?.aborted,false,'SQL fence works before the next renewal timer');
      } finally {await store.pool.query(`DROP TRIGGER ${trigger} ON projects; DROP FUNCTION ${trigger}()`);}
    });
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});

for (const persistent of [false, true]) test(
  persistent ? 'persistent permit row contention respects the operation deadline and recovers'
    : 'transient permit row contention yields the control connection and retries successfully',
  {skip:!url,timeout:15000}, async()=>{
    assert.equal(new URL(url!).hostname,'127.0.0.1');
    assert.match(new URL(url!).pathname,/^\/wtr_admin_test_[a-z0-9_]+$/);
    const root=await mkdtemp(join(tmpdir(),'wtr-control-lock-'));
    const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),
      encryptionSecret:'isolated-control-lock',poolMax:1});
    const namespace='row-lock-'+randomUUID(), id=randomUUID();
    const retries=()=>defaultRuntimeMetrics.snapshot().counters
      .filter(row=>row.name==='what_the_repo_control_lock_retries_total')
      .reduce((sum,row)=>sum+row.value,0);
    let blocker:PoolClient|undefined;
    let pending:Promise<{error?:unknown}>|undefined;
    try {
      await store.init();
      const permits=new PostgresPermitStore(store.pool);
      await permits.change(namespace,(rows,now)=>rows.push({id,owner:'test',resource:'test',state:'running',
        order:1,expires:now+30000,deadline:now+30000}));
      blocker=await store.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT permit_id FROM runtime_permits WHERE namespace=$1 FOR UPDATE',[namespace]);
      const before=retries(), started=performance.now();
      pending=permits.change(namespace,rows=>{rows[0]!.resource='renewed';})
        .then(()=>({}),error=>({error}));
      while(retries()===before && performance.now()-started<2000) await delay(10);
      assert.ok(retries()>before,'real row-lock timeout must exercise 55P03 retry');
      assert.equal(await permits.change(namespace+'-unrelated',()=>true),true,
        'another namespace can use the single control connection while the row remains locked');
      if (persistent) {
        const result=await pending;
        assert.ok(['database_query_timeout','database_pool_timeout'].includes(runAbortCode(result.error)));
        assert.ok(performance.now()-started>=4500 && performance.now()-started<7000);
      }
      await blocker.query('ROLLBACK');blocker.release();blocker=undefined;
      const result=await pending;
      if (!persistent) assert.equal(result.error,undefined);
      await permits.change(namespace,rows=>{rows[0]!.resource='recovered';});
      assert.equal((await store.controlPool.query('SELECT payload->>\'resource\' AS resource FROM runtime_permits WHERE namespace=$1',[namespace])).rows[0].resource,'recovered');
      assert.equal(store.controlPool.waitingCount,0);
      console.log(JSON.stringify({persistent,elapsedMs:performance.now()-started,lockRetries:retries()-before,
        error:persistent?runAbortCode(result.error):null,controlConnections:store.controlPool.totalCount}));
      await permits.change(namespace,rows=>{rows.length=0;});
    } finally {
      if(blocker){await blocker.query('ROLLBACK');blocker.release();}
      await pending;await store.close();await rm(root,{recursive:true,force:true});
    }
  });
