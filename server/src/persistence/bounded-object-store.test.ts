import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceScheduler } from '../scheduling/resources.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { boundedObjectStore } from './bounded-object-store.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

function fixture() {
  const permits = new LocalPermitStore();
  const scheduler = new ResourceScheduler(permits);
  const active = () => permits.change('resource-admission-v1', rows => rows.filter(row => row.state === 'running').length);
  const store: SnapshotObjectStore = {
    kind: 'local',
    async get() { return null; },
    async put(key, body) { return { key, bytes: body.byteLength, sha256: '' }; },
    async delete() { assert.equal(await active(), 1); },
  };
  return { store, scheduler, active };
}

test('stream inventory holds a permit while advancing, but not while consuming rows', { timeout: 3000 }, async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.store.inventoryEntries = async function* (received) {
    assert.equal(this, f.store); assert.equal(received, signal);
    for (const key of ['a', 'b']) {
      assert.equal(await f.active(), 1);
      yield { key, bytes: 1 };
    }
  };
  const store = boundedObjectStore(f.store, f.scheduler, 1);
  const seen = [];
  for await (const object of store.inventoryEntries!(signal)) {
    assert.equal(await f.active(), 0);
    await store.delete(object.key);
    seen.push(object.key);
  }
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(await f.active(), 0);
});

test('early termination closes underlying inventory with a permit and releases it', async () => {
  const f = fixture();
  let closed = false;
  f.store.inventoryEntries = async function* () {
    try { yield { key: 'a', bytes: 1 }; yield { key: 'b', bytes: 1 }; }
    finally { assert.equal(await f.active(), 1); closed = true; }
  };
  const store = boundedObjectStore(f.store, f.scheduler, 1);
  for await (const object of store.inventoryEntries!()) { assert.equal(object.key, 'a'); break; }
  assert.equal(closed, true);
  assert.equal(await f.active(), 0);
});

test('inventory errors and cancellation release permits and close iterators', async () => {
  const f = fixture();
  f.store.inventoryEntries = async function* () { throw new Error('inventory_failure'); };
  let store = boundedObjectStore(f.store, f.scheduler, 1);
  await assert.rejects(async () => { for await (const _ of store.inventoryEntries!()) { /* consume */ } }, /inventory_failure/);
  assert.equal(await f.active(), 0);
  let closed = false;
  const controller = new AbortController();
  f.store.inventoryEntries = async function* () {
    try { yield { key: 'a', bytes: 1 }; yield { key: 'b', bytes: 1 }; }
    finally { closed = true; }
  };
  store = boundedObjectStore(f.store, f.scheduler, 1);
  await assert.rejects(async () => {
    for await (const _ of store.inventoryEntries!(controller.signal)) controller.abort(new Error('cancel_inventory'));
  }, /cancel_inventory/);
  assert.equal(closed, true);
  assert.equal(await f.active(), 0);
});
