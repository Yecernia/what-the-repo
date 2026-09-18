import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityScheduler, LocalPermitStore, connectWithAbort, delay } from './permits.js';
import { admitAnalysis, scheduleAnalysis, type ScheduledAnalysis } from './analysis.js';
import { newAnalysisJob } from '../domain/jobs.js';

test('whole chat admission is owner scoped, bounded, FIFO and cancellable', async () => {
  const store = new LocalPermitStore();
  const policy = { running: 1, waiting: 2, waitMs: 1000, ownerActive: 2, ownerWaiting: 1, exclusiveResource: true };
  const a = new CapacityScheduler(store, 'chat', policy), b = new CapacityScheduler(store, 'chat', policy);
  const first = await a.acquire('alice', 'repo1');
  const cancel = new AbortController();
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => waiting = resolve);
  const second = b.acquire('alice', 'repo2', cancel.signal, waiting);
  const rejected = assert.rejects(second, /cancelled/);
  await ready;
  await assert.rejects(a.acquire('alice', 'repo3'), { code: 'chat_owner_busy' });
  await assert.rejects(b.acquire('bob', 'repo1'), { code: 'session_busy' });
  const order: string[] = [];
  const third = a.acquire('bob', 'repo3', undefined, () => order.push('waiting'));
  await delay(5);
  await assert.rejects(a.acquire('carol', 'repo4'), { code: 'chat_queue_full' });
  cancel.abort(new Error('cancelled'));
  await rejected;
  await first.release();
  const last = await third;
  assert.deepEqual(order, ['waiting']);
  await last.release(); await last.release();
  const again = await b.acquire('alice', 'repo1'); await again.release();
});

test('wait timeout releases personal quota and does not borrow another namespace capacity', async () => {
  const store = new LocalPermitStore();
  const scheduler = new CapacityScheduler(store, 'chat', { running: 1, waiting: 1, waitMs: 20 });
  const first = await scheduler.acquire('one', 'one');
  await assert.rejects(scheduler.acquire('two', 'two'), { code: 'chat_wait_timeout' });
  const other = await new CapacityScheduler(store, 'analysis-model', { running: 1, waiting: 1, waitMs: 20 }).acquire('two','two');
  await other.release(); await first.release();
});

test('cancelled database connection waits reject immediately and release a late client', async () => {
  let finish!: (client: { release(): void }) => void;
  let released = 0;
  const pool = { connect: () => new Promise<{ release(): void }>(resolve => finish=resolve) };
  const controller = new AbortController();
  const waiting = connectWithAbort(pool, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  finish({ release: () => released++ });
  await delay(0); assert.equal(released, 1);
});

function job(owner: string, id: string, group = id): ScheduledAnalysis {
  return { ...newAnalysisJob(id,id), job_id: id, owner_id: owner, repository_update_id: group,
    execution_role: 'leader', created_at: '2026-09-01T00:00:00Z', available_at: '2026-09-01T00:00:00Z' };
}
const limits = { running: 2, ownerRunning: 1, ownerWaiting: 2, waiting: 4 };
const now = Date.parse('2026-09-15T00:00:00Z');
function run(job: ScheduledAnalysis) { job.status='running'; job.lease_expires_at = new Date(now+30000).toISOString(); }

test('analysis rotates owners, skips saturated owners and fills all usable slots', () => {
  const jobs = [job('a','a1'), job('a','a2'), job('b','b1')];
  const served = new Map<string,number>();
  assert.equal(scheduleAnalysis(jobs,served,limits,now)?.job_id,'a1'); run(jobs[0]!);
  assert.equal(scheduleAnalysis(jobs,served,limits,now)?.job_id,'b1'); run(jobs[2]!);
  assert.equal(scheduleAnalysis(jobs,served,limits,now),null);
  jobs[0]!.status='succeeded';
  assert.equal(scheduleAnalysis(jobs,served,limits,now)?.job_id,'a2');
});

test('shared analysis consumes one global slot but each participant has a personal running slot', () => {
  const shared = job('a','a1','shared'); run(shared); shared.participation_state='running';
  const own = job('b','b1'); run(own); own.participation_state='running';
  const waiter = { ...job('b','b2','shared'), execution_role: 'waiter' as const };
  const jobs = [shared,own,waiter];
  assert.equal(admitAnalysis(jobs.slice(0,2),waiter,limits,now),'waiting');
  assert.equal(scheduleAnalysis(jobs,new Map(),limits,now),null);
  assert.equal(waiter.participation_state,undefined);
  own.status='succeeded';
  assert.equal(scheduleAnalysis(jobs,new Map(),limits,now),null);
  assert.equal(waiter.participation_state,'running');
  assert.equal(admitAnalysis(jobs,job('b','b3'),{ ...limits, ownerWaiting: 1 },now),'waiting');
});

test('shared joins do not add physical queue entries, completed results bypass admission', () => {
  const first = job('a','a1','shared');
  const waiter = { ...job('b','b1','shared'), execution_role: 'waiter' as const };
  const small = { ...limits, waiting: 1, ownerWaiting: 1 };
  assert.equal(admitAnalysis([first],waiter,small,now),'waiting');
  assert.throws(() => admitAnalysis([first,waiter],job('b','b2'),small,now),{ code: 'analysis_owner_queue_full' });
  assert.throws(() => admitAnalysis([first],job('c','c1'),small,now),{ code: 'analysis_queue_full' });
  assert.equal(admitAnalysis([first],{ ...job('c','c1'),status:'succeeded' },small,now),'waiting');
});
