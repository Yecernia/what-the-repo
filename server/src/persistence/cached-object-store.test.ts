import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { cachedObjectStore } from './cached-object-store.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

const body = (text: string) => Buffer.from(text);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const keyFor = (text: string, scope = 'test') => `public-repository-snapshots/${scope}/analysis-${digest(body(text))}.json`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = { maxBytes: 8, maxEntryBytes: 8, maxEntries: 4, maxInFlight: 4 }) {
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const ranges: string[] = [];
  const store: SnapshotObjectStore = {
    kind: 'local',
    async get(key) { reads.push(key); return objects.get(key) ?? null; },
    async getRange(key, offset, length) {
      ranges.push(`${key}:${offset}:${length}`);
      const value = objects.get(key);
      if (!value) return null;
      if (offset + length > value.byteLength) throw new Error('snapshot_object_range_invalid');
      return value.subarray(offset, offset + length);
    },
    async put(key, value) { objects.set(key, value); return { key, bytes: value.byteLength, sha256: digest(value) }; },
    async delete(key) { objects.delete(key); },
    async purge(key) { objects.delete(key); },
  };
  const cache = cachedObjectStore(store, options);
  const add = (text: string, scope?: string) => { const key = keyFor(text, scope); objects.set(key, body(text)); return key; };
  return { objects, reads, ranges, store, cache, add };
}

test('byte-budget LRU evicts the least recently read object', async () => {
  const f = fixture();
  const a = f.add('aaaa'), b = f.add('bbbb'), c = f.add('cccc');
  await f.cache.get(a); await f.cache.get(b); await f.cache.get(a); await f.cache.get(c);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 8, entries: 2, inFlight: 0 });
  await f.cache.get(a);
  assert.deepEqual(f.reads, [a, b, c]);
  await f.cache.get(b);
  assert.deepEqual(f.reads, [a, b, c, b]);
});

test('oversized, missing, mutable and corrupt objects are not retained', async () => {
  const f = fixture({ maxBytes: 8, maxEntryBytes: 4, maxEntries: 4, maxInFlight: 4 });
  const large = f.add('large'), missing = keyFor('missing'), corrupt = keyFor('valid');
  f.objects.set('mutable.json', body('data'));
  f.objects.set(corrupt, body('bad'));
  for (const key of [large, missing, 'mutable.json', corrupt]) {
    await f.cache.get(key); await f.cache.get(key);
    assert.equal(f.reads.filter(read => read === key).length, 2);
  }
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
  f.objects.set(missing, body('missing'));
  assert.equal(Buffer.from((await f.cache.get(missing))!).toString(), 'missing');
});

test('entry limit bounds empty objects and unique range metadata', async () => {
  const f = fixture({ maxBytes: 100, maxEntryBytes: 100, maxEntries: 2, maxInFlight: 4 });
  for (const scope of ['a', 'b', 'c']) await f.cache.get(f.add('', scope));
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 2, inFlight: 0 });
  const key = f.add('0123456789');
  for (let offset = 0; offset < 10; offset++) await f.cache.getRange!(key, offset, 1);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 2, entries: 2, inFlight: 0 });
});

test('parallel reads coalesce and every caller owns its returned bytes', async () => {
  const f = fixture();
  const key = f.add('data');
  const gate = deferred<Uint8Array | null>();
  let calls = 0;
  f.store.get = async () => { calls++; return gate.promise; };
  const first = f.cache.get(key), second = f.cache.get(key);
  await setImmediate();
  assert.equal(calls, 1);
  gate.resolve(body('data'));
  const [a, b] = await Promise.all([first, second]);
  a![0] = 0;
  assert.equal(Buffer.from(b!).toString(), 'data');
  b![0] = 1;
  assert.equal(Buffer.from((await f.cache.get(key))!).toString(), 'data');
  f.objects.get(key)![0] = 2;
  assert.equal(Buffer.from((await f.cache.get(key))!).toString(), 'data');
});

test('failed flights are removed and a later read retries', async () => {
  const f = fixture();
  const key = f.add('data');
  const gate = deferred<Uint8Array | null>();
  f.store.get = () => gate.promise;
  const first = assert.rejects(f.cache.get(key), /temporary/);
  const second = assert.rejects(f.cache.get(key), /temporary/);
  gate.reject(new Error('temporary'));
  await Promise.all([first, second]);
  assert.equal(f.cache.cacheStats().inFlight, 0);
  f.store.get = async () => body('data');
  assert.equal(Buffer.from((await f.cache.get(key))!).toString(), 'data');
  assert.equal(f.cache.cacheStats().entries, 1);
});

test('in-flight cap bypasses excess reads without retaining their keys', async () => {
  const f = fixture({ maxBytes: 8, maxEntryBytes: 8, maxEntries: 4, maxInFlight: 1 });
  const gate = deferred<Uint8Array | null>();
  f.store.get = () => gate.promise;
  const reads = [f.cache.get(keyFor('a')), f.cache.get(keyFor('b')), f.cache.get(keyFor('c'))];
  await setImmediate();
  assert.equal(f.cache.cacheStats().inFlight, 1);
  gate.resolve(null);
  await Promise.all(reads);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
});

test('range reads coalesce, cache exact slices and use a cached full object', async () => {
  const f = fixture();
  const key = f.add('01234567');
  const [a, b] = await Promise.all([f.cache.getRange!(key, 1, 3), f.cache.getRange!(key, 1, 3)]);
  a![0] = 0;
  assert.equal(Buffer.from(b!).toString(), '123');
  assert.equal(Buffer.from((await f.cache.getRange!(key, 1, 3))!).toString(), '123');
  assert.equal(f.ranges.length, 1);
  await f.cache.get(key);
  assert.equal(Buffer.from((await f.cache.getRange!(key, 4, 2))!).toString(), '45');
  assert.equal(f.ranges.length, 1);
  await assert.rejects(f.cache.getRange!(key, 7, 2), /range_invalid/);
  await assert.rejects(f.cache.getRange!(key, -1, 1), /range_invalid/);
});

test('fallback range reads reject truncation and do not retain invalid responses', async () => {
  const f = fixture();
  const key = f.add('data');
  delete f.store.getRange;
  assert.equal(Buffer.from((await f.cache.getRange!(key, 1, 2))!).toString(), 'at');
  await assert.rejects(f.cache.getRange!(key, 3, 2), /range_invalid/);
  f.store.getRange = async () => body('x');
  await assert.rejects(f.cache.getRange!(key, 0, 2), /range_invalid/);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 2, entries: 1, inFlight: 0 });
});

test('put, delete and purge invalidate full objects and ranges', async () => {
  for (const operation of ['put', 'delete', 'purge'] as const) {
    const f = fixture();
    const key = f.add('data');
    await f.cache.getRange!(key, 0, 2);
    await f.cache.get(key);
    if (operation === 'put') await f.cache.put(key, body('data'));
    else await f.cache[operation]!(key);
    assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
    const value = await f.cache.get(key);
    assert.equal(value === null, operation !== 'put');
    assert.equal(f.reads.length, 2);
  }
});

test('deletion detaches old flights and they cannot repopulate the cache', async () => {
  const f = fixture();
  const key = f.add('data');
  const gate = deferred<Uint8Array | null>();
  const original = f.store.get;
  f.store.get = () => gate.promise;
  const pending = f.cache.get(key);
  await setImmediate();
  await f.cache.delete(key);
  f.store.get = original;
  assert.equal(await f.cache.get(key), null);
  gate.resolve(body('data'));
  await pending;
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
});

test('reads during a failed mutation cannot survive its completion', async () => {
  const f = fixture();
  const key = f.add('data');
  const gate = deferred<void>();
  f.store.delete = () => gate.promise;
  const deletion = assert.rejects(f.cache.delete(key), /failed/);
  await f.cache.get(key);
  assert.equal(f.cache.cacheStats().entries, 1);
  gate.reject(new Error('failed'));
  await deletion;
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
});

test('prefix invalidation removes matching entries and in-flight reads only', async () => {
  const f = fixture();
  const a = f.add('aa', 'a'), b = f.add('bb', 'b'), c = f.add('cc', 'a');
  await f.cache.get(a); await f.cache.get(b);
  const gate = deferred<Uint8Array | null>();
  f.store.get = () => gate.promise;
  const pending = f.cache.get(c);
  await setImmediate();
  f.cache.invalidatePrefix('public-repository-snapshots/a/');
  assert.deepEqual(f.cache.cacheStats(), { bytes: 2, entries: 1, inFlight: 0 });
  gate.resolve(body('cc'));
  await pending;
  assert.equal(Buffer.from((await f.cache.get(b))!).toString(), 'bb');
  assert.equal(f.cache.cacheStats().entries, 1);
});

test('disabled caches bypass retention and options reject invalid bounds', async () => {
  const f = fixture({ maxBytes: 0, maxEntryBytes: 8, maxEntries: 4, maxInFlight: 4 });
  const key = f.add('data');
  await f.cache.get(key); await f.cache.get(key);
  assert.equal(f.reads.length, 2);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
  for (const value of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => cachedObjectStore(f.store, { maxBytes: value, maxEntryBytes: 8 }), /cache_limit_invalid/);
  }
});

test('compressed directory chunks use their stored-byte digest as cache identity', async () => {
  const f = fixture();
  const value = body('opaque');
  const key = `public-repository-snapshots/test/directory/generation/nodes/0-${digest(value)}.json.gz`;
  f.objects.set(key, value);
  await f.cache.get(key); await f.cache.get(key);
  assert.deepEqual(f.reads, [key]);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 6, entries: 1, inFlight: 0 });
});

test('optional inventory capabilities are forwarded with their receiver and signal', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.store.inventory = async function () { assert.equal(this, f.store); return [{ key: 'a', bytes: 1 }]; };
  f.store.inventoryEntries = async function* (received) {
    assert.equal(this, f.store); assert.equal(received, signal);
    yield { key: 'b', bytes: 2 };
  };
  const cache = cachedObjectStore(f.store, { maxBytes: 8, maxEntryBytes: 8 });
  assert.deepEqual(await cache.inventory!(), [{ key: 'a', bytes: 1 }]);
  const streamed = [];
  for await (const row of cache.inventoryEntries!(signal)) streamed.push(row);
  assert.deepEqual(streamed, [{ key: 'b', bytes: 2 }]);
});

test('oversized parallel misses coalesce only for the lifetime of the read', async () => {
  const f = fixture({ maxBytes: 8, maxEntryBytes: 4, maxEntries: 4, maxInFlight: 2 });
  const key = keyFor('oversized');
  const gate = deferred<Uint8Array | null>();
  let calls = 0;
  f.store.get = async () => { calls++; return gate.promise; };
  const reads = Array.from({ length: 100 }, () => f.cache.get(key));
  await setImmediate();
  assert.equal(calls, 1);
  gate.resolve(body('oversized'));
  await Promise.all(reads);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
  await f.cache.get(key);
  assert.equal(calls, 2);
});

test('thousands of distinct pending misses never grow the bounded metadata maps', async () => {
  const f = fixture({ maxBytes: 8, maxEntryBytes: 4, maxEntries: 4, maxInFlight: 2 });
  const gate = deferred<Uint8Array | null>();
  f.store.get = () => gate.promise;
  const reads = Array.from({ length: 1000 }, (_, index) => f.cache.get(keyFor(String(index))));
  await setImmediate();
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 2 });
  gate.resolve(null);
  await Promise.all(reads);
  assert.deepEqual(f.cache.cacheStats(), { bytes: 0, entries: 0, inFlight: 0 });
});
