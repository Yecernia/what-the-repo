import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from './postgres-store.js';
import { PostgresPiSessionBackend } from './postgres-session-backend.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob, type AnalysisJob } from '../domain/jobs.js';
import { CapacityScheduler, PostgresPermitStore } from '../scheduling/permits.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('PostgreSQL admission uses short connections, global analysis slots and per-user shared attachments', { skip: !url }, async () => {
  assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(),'wtr-concurrency-'));
  const store = new PostgresStore({ root, databaseUrl: url!, migrationsRoot: join(process.cwd(),'migrations'),
    encryptionSecret: 'concurrency-test-secret', poolMax: 1, connectionTimeoutMs: 1000,
    analysisLimits: { running: 2, ownerRunning: 1, ownerWaiting: 3, waiting: 8 } });
  try {
    await store.init();
    for (const owner of ['a','b','c']) await store.saveUser(owner, { login: owner });
    const project = async (owner: string, title: string) => { const p=createProject(owner,`https://github.com/example/${title}`,title); await store.saveProject(p); return p; };
    const pa = await project('a','a1'), pa2 = await project('a','a2'), pb = await project('b','b1');
    const scheduler = new CapacityScheduler(new PostgresPermitStore(store.pool),'chat', { running: 1, waiting: 1, waitMs: 1000, ownerActive: 2 });
    const chat = await scheduler.acquire('a',pa.project_id);
    assert.equal(store.pool.idleCount,1,'chat permit must not pin the only connection');
    const sessions = new PostgresPiSessionBackend(store.pool);
    await sessions.withSession({ sessionId:'concurrency-session',ownerId:'a',projectId:pa.project_id,snapshotId:null,skillId:'primary-supervisor',skillVersion:'test' },async session => {
      await store.pool.query('SELECT 1');
      await session.setName('short transaction');
      assert.equal(await session.getName(),'short transaction');
      assert.equal(store.pool.idleCount,1,'session held across tools/model work must not pin a connection');
    });
    await chat.release();
    const ja=newAnalysisJob(pa.project_id,'a1'), ja2=newAnalysisJob(pa2.project_id,'a2'), jb=newAnalysisJob(pb.project_id,'b1');
    ja.created_at='2026-09-01T00:00:00.000Z'; ja2.created_at='2026-09-01T00:00:00.001Z'; jb.created_at='2026-09-01T00:00:00.002Z';
    for (const job of [ja,ja2,jb]) await store.saveJob(job);
    const claimed = await Promise.all([store.claimAnalysisJob('worker1',30),store.claimAnalysisJob('worker2',30),store.claimAnalysisJob('worker3',30)]);
    assert.equal(claimed.filter(Boolean).length,2);
    assert.deepEqual(new Set(claimed.filter(Boolean).map(job=>job!.job_id)),new Set([ja.job_id,jb.job_id]));
    const finish = async (job: AnalysisJob) => assert.equal(await store.finishAnalysisJob({ ...job,status:'succeeded',lease_owner:null,lease_expires_at:null,completed_at:new Date().toISOString() },job.lease_owner!,job.attempt),true);
    for (const job of claimed) if(job) await finish(job);
    const next=await store.claimAnalysisJob('worker1',30); assert.equal(next?.job_id,ja2.job_id); await finish(next!);

    const busy = newAnalysisJob(pb.project_id,'busy'); await store.saveJob(busy);
    const runningBusy = await store.claimAnalysisJob('worker2',30); assert.equal(runningBusy?.job_id,busy.job_id);
    const sharedA=await project('a','shared-a'), sharedB=await project('b','shared-b');
    const identity={repository:'example/shared',analyzerBundleVersion:'test',analysisConfigDigest:'config'};
    const leader=await store.createOrJoinRepositoryUpdate({project:sharedA,job:newAnalysisJob(sharedA.project_id,'shared-a'),identity,targetCommitSha:'abc',newProject:false});
    const runningShared=await store.claimAnalysisJob('worker1',30); assert.equal(runningShared?.job_id,leader.job.job_id);
    const waiter=await store.createOrJoinRepositoryUpdate({project:sharedB,job:newAnalysisJob(sharedB.project_id,'shared-b'),identity,targetCommitSha:'abc',newProject:false});
    assert.equal(waiter.leader,false);
    assert.equal((await store.latestJob(sharedB.project_id))?.scheduling_state,'waiting_owner');
    assert.equal(await store.claimAnalysisJob('worker3',30),null);
    await finish(runningBusy!);
    assert.equal(await store.claimAnalysisJob('worker3',30),null,'attaching a user does not start a duplicate physical task');
    assert.equal((await store.latestJob(sharedB.project_id))?.scheduling_state,'running');
    assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM analysis_jobs WHERE status='running'")).rows[0].count,1);
    await finish(runningShared!);
  } finally { await store.close(); await rm(root,{recursive:true,force:true}); }
});
