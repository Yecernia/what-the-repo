import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalProviderCallGate,
  createProviderGateFactory,
  providerGateKey,
} from "./provider-gate.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("local provider gate queues a call and releases permits exactly once", async () => {
  const gate = new LocalProviderCallGate(1);
  const first = await gate.acquire();
  let secondReady = false;
  const second = gate.acquire().then((permit) => {
    secondReady = true;
    return permit;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false);
  await first.release();
  const secondPermit = await second;
  assert.equal(secondReady, true);
  await secondPermit.release();
  await secondPermit.release();
});

test("waiting provider calls can be cancelled without consuming the next slot", async () => {
  const gate = new LocalProviderCallGate(1);
  const first = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  await first.release();
  const next = await gate.acquire();
  await next.release();
});


test('model capacity is shared across keys but isolated by business; upstream identity ignores connection labels', async () => {
  const factory = createProviderGateFactory({ maxConcurrent: 1, analysisConcurrent: 1 });
  const provider = { provider:'custom',connectionId:'one',baseUrl:'https://provider.example/v1',apiKey:'same-key',model:'m',modelId:'m',modelSelector:'m',api:'openai-completions' as const,builtin:false };
  assert.equal(providerGateKey(provider),providerGateKey({ ...provider,connectionId:'two',modelId:'another' }));
  assert.notEqual(providerGateKey(provider),providerGateKey({ ...provider,apiKey:'different' }));
  const first = await factory(provider,'chat').acquire();
  const controller = new AbortController();
  const second = factory({ ...provider,apiKey:'different' },'chat').acquire(controller.signal);
  const rejection = assert.rejects(second,/cancelled/);
  const analysis = await factory(provider,'analysis').acquire();
  controller.abort(new Error('cancelled')); await rejection;
  await first.release(); await analysis.release();
});

test('account/model ceilings combine atomically and cannot be bypassed by renaming a connection', async () => {
  const provider = { provider:'custom',connectionId:'one',baseUrl:'https://provider.example/v1',apiKey:'same-key',model:'m',modelId:'m',modelSelector:'m',api:'openai-completions',builtin:false };
  const factory = createProviderGateFactory({ maxConcurrent: 4, analysisConcurrent: 4, upstreamCapacities: [
    { account: 'shared-account', baseUrl: provider.baseUrl, credentialHashes: [providerGateKey(provider)], concurrency: 1 },
  ] });
  const first = await factory(provider, 'analysis', { ownerId: 'a', taskId: 'one' }).acquire();
  const controller = new AbortController();
  const denied = factory({ ...provider, connectionId: 'renamed' }, 'chat', { ownerId: 'b', taskId: 'two' }).acquire(controller.signal);
  const rejection = assert.rejects(denied, /cancelled/);
  const unrelated = await factory({ ...provider, apiKey: 'other-account' }, 'chat', { ownerId: 'c', taskId: 'three' }).acquire();
  controller.abort(new Error('cancelled')); await rejection;
  await unrelated.release(); await first.release();
});
