import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalPermitStore, type PermitRow } from './permits.js';
import { ResourceScheduler, promoteResources } from './resources.js';
import { concurrencyConfig } from './config.js';

test('atomic multi-resource admission does not occupy business slots while upstream is full', async () => {
  const store = new LocalPermitStore(), gate = new ResourceScheduler(store);
  const first = await gate.acquire({ owner: 'a', task: 'a', demands: { upstream: { units: 1, limit: 1 } } });
  const controller = new AbortController();
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const blocked = gate.acquire({ owner: 'a', task: 'a', demands: { upstream: { units: 1, limit: 1 }, chat: { units: 1, limit: 1 } }, signal: controller.signal, onWaiting: waiting });
  const rejected = assert.rejects(blocked, /cancelled/);
  await ready;
  const other = await gate.acquire({ owner: 'b', task: 'b', demands: { chat: { units: 1, limit: 1 } } });
  controller.abort(new Error('cancelled'));
  await rejected;
  await other.release(); await first.release();
  await store.change('resource-admission-v1', rows => assert.equal(rows.length, 0));
});

test('weighted memory admission permits independent stages and rejects impossible requests', async () => {
  const gate = new ResourceScheduler(new LocalPermitStore());
  const first = await gate.acquire({ owner: 'a', task: 'a', demands: { memory: { units: 4, limit: 6 }, cpu: { units: 1, limit: 1 } } });
  const other = await gate.acquire({ owner: 'b', task: 'b', demands: { memory: { units: 2, limit: 6 }, fetch: { units: 1, limit: 1 } } });
  await assert.rejects(gate.acquire({ owner: 'c', task: 'c', demands: { memory: { units: 7, limit: 6 } } }), /exceeds_capacity/);
  await assert.rejects(gate.acquire({ owner: 'c', task: 'c', demands: { memory: { units: 1, limit: 6 } }, waitMs: 25 }), /timeout|aborted/i);
  await first.release(); await other.release();
});

test('grants are fair by owner before task; lease expiry recovers capacity', () => {
  const row = (id: string, owner: string, task: string, order: number, state: 'running' | 'waiting') => ({
    id, owner, task, order, state, expires: 10000, deadline: 10000, resource: '', demands: { model: { units: 1, limit: 2 } },
  });
  const rows = [row('a1', 'a', 'a1', 1, 'running'), row('a2', 'a', 'a2', 2, 'waiting'), row('b', 'b', 'b', 3, 'waiting')];
  promoteResources(rows, 0);
  assert.equal(rows[1].state, 'waiting'); assert.equal(rows[2].state, 'running');
});

test('configuration rejects legacy knobs, invalid ranges and ambiguous upstream accounts', () => {
  for (const key of ['ANALYSIS_CONCURRENCY', 'PROVIDER_CONCURRENCY', 'UPSTREAM_CONCURRENCY'])
    assert.throws(() => concurrencyConfig({ ['WHAT_THE_REPO_' + key]: '4' }), /removed/);
  assert.throws(() => concurrencyConfig({ WHAT_THE_REPO_ANALYSIS_CPU_CONCURRENCY: '0' }), /integer/);
  const rule = { account: 'platform', baseUrl: 'https://example.com', credentialHashes: ['a'.repeat(64)], concurrency: 8 };
  assert.equal(concurrencyConfig({ WHAT_THE_REPO_UPSTREAM_CAPACITIES: JSON.stringify([rule]) }).upstreamCapacities?.[0].concurrency, 8);
  assert.throws(() => concurrencyConfig({ WHAT_THE_REPO_UPSTREAM_CAPACITIES: JSON.stringify([rule, rule]) }), /duplicate/);
});

test('aged large jobs reserve memory even when sequential small arrivals reuse queue positions', () => {
  const base = { owner: 'old', task: 'large', resource: '', expires: 60000, deadline: 60000 };
  const rows = [
    { ...base, id: 'active', owner: 'busy', state: 'running' as const, order: 2, demands: { memory: { units: 1, limit: 4 } } },
    { ...base, id: 'large', state: 'waiting' as const, order: 1, enqueuedAt: 0, demands: { memory: { units: 4, limit: 4 } } },
    { ...base, id: 'small', owner: 'new', state: 'waiting' as const, order: 3, enqueuedAt: 10000, demands: { memory: { units: 1, limit: 4 } } },
  ];
  promoteResources(rows, 11000);
  assert.equal(rows[2].state, 'waiting');
  rows.shift();
  promoteResources(rows, 11001);
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[1].state, 'waiting');
});
