import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { forEachBounded } from './bounded-tasks.js';

test('bounded tasks stop admission and drain before rejecting', async () => {
  let release!: () => void, closed = false, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  function* values() { try { yield* [0, 1, 2, 3]; } finally { closed = true; } }
  const failure = new Error('first failure');
  const result = forEachBounded(values(), 2, async value => {
    started.push(value);
    if (value === 0) throw failure;
    await gate;
  });
  const checked = assert.rejects(result, error => error === failure).then(() => { settled = true; });
  await setImmediate();
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);
  release();
  await checked;
  assert.equal(closed, true);
  assert.deepEqual(started, [0, 1]);
});

test('invalid concurrency never starts work', async () => {
  for (const concurrency of [0, -1, NaN, Infinity, 1.5, 65]) {
    await assert.rejects(forEachBounded([1], concurrency, async () => {
      assert.fail('invalid concurrency admitted work');
    }), /invalid_task_concurrency/);
  }
});

test('iterator failures close the iterator and preserve falsy rejection reasons', async () => {
  let closed = false;
  function* values() { try { yield 1; throw undefined; } finally { closed = true; } }
  let rejected = false;
  await forEachBounded(values(), 1, async () => {}).catch(error => {
    rejected = true; assert.equal(error, undefined);
  });
  assert.equal(rejected, true);
  assert.equal(closed, true);
});
