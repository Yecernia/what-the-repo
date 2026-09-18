import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { CapacityScheduler, LocalPermitStore, PostgresPermitStore, delay, type PermitStore } from './permits.js';

test('a stalled admission operation still respects its deadline', { timeout: 1000 }, async () => {
  const local = new LocalPermitStore();
  let stalled = false;
  const store: PermitStore = { change: async (namespace, operation, signal) => {
    if (stalled) await delay(10_000, signal);
    return local.change(namespace, operation, signal);
  } };
  const scheduler = new CapacityScheduler(store, 'chat', { running: 1, waiting: 1, waitMs: 50 });
  const first = await scheduler.acquire('first', 'first');
  try {
    stalled = true;
    await assert.rejects(scheduler.acquire('second', 'second'), { code: 'chat_wait_timeout' });
  } finally { stalled = false; await first.release(); }
});

test('aborting an in-flight permit SQL query destroys its connection exactly once', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let rejectQuery!: (error: Error) => void;
  const releases: boolean[] = [];
  const client = {
    query: async () => { started(); return new Promise((_resolve, reject) => { rejectQuery = reject; }); },
    release: (destroy = false) => { releases.push(destroy); rejectQuery(new Error('connection destroyed')); },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const controller = new AbortController();
  const pending = new PostgresPermitStore(pool).change('test', () => undefined, controller.signal);
  await ready;
  controller.abort(new Error('cancelled_by_test'));
  await assert.rejects(pending, /cancelled_by_test/);
  assert.deepEqual(releases, [true]);
});
