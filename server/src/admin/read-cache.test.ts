import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminReadCache } from './read-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('display reads coalesce, serve old data during refresh, and back off after failure', async () => {
  let now = 1_000, calls = 0;
  const cache = new AdminReadCache(() => now);
  const first = deferred<Record<string, unknown>>();
  const load = () => { calls++; return first.promise; };
  const a = cache.read('/storage', 100, load), b = cache.read('/storage', 100, load);
  first.resolve({ count: 1 });
  assert.equal((await a).count, 1);
  assert.equal((await b).count, 1);
  assert.equal(calls, 1);
  now += 101;
  const next = deferred<Record<string, unknown>>();
  const stale = await cache.read('/storage', 100, () => next.promise);
  assert.equal(stale.count, 1);
  assert.equal(stale.readState.stale, true);
  assert.equal(stale.readState.refreshing, true);
  next.resolve({ count: 2 });
  assert.equal((await cache.read('/storage', 100, load, true)).count, 2);
  now += 101;
  let failures = 0;
  const fail = async () => { failures++; throw new Error('database unavailable'); };
  const failed = await cache.read('/storage', 100, fail, true);
  assert.equal(failed.count, 2);
  assert.equal(failed.readState.refreshFailed, true);
  await cache.read('/storage', 100, fail, true);
  assert.equal(failures, 1);
  now += 15 * 60_000;
  await assert.rejects(cache.read('/storage', 100, fail), /admin_read_unavailable/);
  await cache.close();
});

test('bounded admission rejects excess cold reads; pre-write reads cannot replace post-write data', async () => {
  const cache = new AdminReadCache();
  const old = deferred<Record<string, unknown>>();
  const pending = cache.read('/storage', 100, () => old.promise);
  cache.invalidate();
  const updated = cache.read('/storage', 100, async () => ({ version: 2 }));
  await assert.rejects(cache.read('/activity', 100, async () => ({})), /admin_read_busy/);
  assert.equal((await updated).version, 2);
  old.resolve({ version: 1 });
  await pending;
  assert.equal((await cache.read('/storage', 100, async () => ({}))).version, 2);
  await cache.close();
});
