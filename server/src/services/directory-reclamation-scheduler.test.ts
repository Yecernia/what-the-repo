import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { RuntimeMetrics } from '../observability/metrics.js';
import { createDirectoryReclamationTask } from './directory-reclamation-scheduler.js';
import { RetentionScheduler } from './retention-scheduler.js';

test('reclamation polling backs off, exposes backlog and never logs database messages', async () => {
  let now = 0, calls = 0, backlogCalls = 0;
  const metrics = new RuntimeMetrics();
  const task = createDirectoryReclamationTask({} as Pool, metrics, {
    now: () => now,
    batch: async () => {
      calls++;
      if (calls === 2) throw new Error('untrusted-database-message');
      return { status: calls === 1 ? 'idle' : 'progress', deletedRows: calls === 1 ? 0 : 12 };
    },
    backlog: async () => { backlogCalls++; return { pending: 3, failed: 1, oldestSeconds: 90 }; },
  });
  await task(); assert.equal(calls, 1); assert.equal(backlogCalls, 1);
  now = 4_999; await task(); assert.equal(calls, 1);
  now = 5_000; await task(); assert.equal(calls, 2);
  now = 9_999; await task(); assert.equal(calls, 2);
  now = 10_000; await task(); assert.equal(calls, 3); assert.equal(backlogCalls, 2);
  now = 10_099; await task(); assert.equal(calls, 3);
  now = 10_100; await task(); assert.equal(calls, 4);
  assert.doesNotMatch(metrics.prometheus(), /untrusted-database-message/);
  assert.match(metrics.prometheus(), /reclamation_errors_total/);
  assert.match(metrics.prometheus(), /reclamation_pending 3/);
});

test('scheduler coalesces cleanup ticks and waits for the active bounded batch on stop', async () => {
  let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new RetentionScheduler(async () => { entered++; await gate; }, 1);
  const first = scheduler.runNow();
  assert.equal(scheduler.runNow(), first);
  scheduler.start();
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(entered, 1); assert.equal(stopped, false);
  release(); await stop;
  assert.equal(stopped, true); assert.equal(entered, 1);
});
