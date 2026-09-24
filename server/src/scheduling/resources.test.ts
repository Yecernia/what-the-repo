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

test('unattended background work leaves the user reserve and never overtakes a waiting user', () => {
  const base = { resource: '', expires: 60000, deadline: 60000, enqueuedAt: 0 };
  const user = (id: string, units: number, state: 'running' | 'waiting', order: number) =>
    ({ ...base, id, owner: 'user:' + id, task: id, state, order, demands: { memory: { units, limit: 8 } } });
  const background = (units: number, order: number) => ({ ...base, id: 'bg', owner: 'system:background', task: 'bg',
    state: 'waiting' as 'running' | 'waiting', order, demands: { memory: { units, limit: 8, backgroundCeiling: 6 } } });
  // 2 in use + 4 = 6 fits the background ceiling; + 5 would not, though the pool has room.
  let rows = [user('a', 2, 'running', 1), background(4, 2)];
  promoteResources(rows, 20000);
  assert.equal(rows[1]!.state, 'running');
  rows = [user('a', 2, 'running', 1), background(5, 2)];
  promoteResources(rows, 20000);
  assert.equal(rows[1]!.state, 'waiting', 'the reserve stays free for users');
  // A stage larger than the ceiling starts only on an idle pool.
  rows = [background(8, 1)];
  promoteResources(rows, 20000);
  assert.equal(rows[0]!.state, 'running');
  // A user that cannot fit yet still blocks background admission, and background never ages into a reservation.
  rows = [user('a', 4, 'running', 1), user('b', 6, 'waiting', 2), background(1, 3)];
  promoteResources(rows, 20000);
  assert.deepEqual(rows.map(row => row.state), ['running', 'waiting', 'waiting']);
  rows = [user('a', 7, 'running', 1), background(1, 0), user('c', 1, 'waiting', 5)];
  rows[2]!.enqueuedAt = 19000;
  promoteResources(rows, 20000);
  assert.equal(rows[2]!.state, 'running', 'an old background waiter does not reserve the pool');
});
