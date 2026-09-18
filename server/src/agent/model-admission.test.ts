import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { modelsWithProviderControl, withProviderPermit } from './model-runtime.js';
import { LocalProviderUsageBudget } from './provider-budget.js';
import type { PiModelRuntime } from './types.js';

function fixture() {
  const faux = fauxProvider({ provider: 'controlled-model-test' });
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('OK')));
  const models = createModels(); models.setProvider(faux.provider);
  const budget = new LocalProviderUsageBudget({ maxCallsPerMinute: 1, minimumReservationUsd: 0,
    policies: { chat_daily: null, analysis_daily: null, evolution_daily: null, evolution_task: null } });
  let acquired = 0, released = 0;
  const runtime: PiModelRuntime = { models, model: faux.getModel(), ownerId: 'owner', providerBudget: budget,
    attribution: { business: 'chat', payer: 'user' },
    providerGate: { acquire: async () => { acquired++; return { release: async () => { released++; } }; } } };
  return { runtime, budget, counts: () => ({ acquired, released }) };
}

test('all direct Models entry points reserve and settle once, including compaction completeSimple', async () => {
  const { runtime, budget, counts } = fixture();
  const models = modelsWithProviderControl(runtime);
  const context = { messages: [{ role: 'user' as const, content: 'test', timestamp: Date.now() }] };
  for (const name of ['stream', 'streamSimple', 'complete', 'completeSimple'] as const) {
    const value = models[name](runtime.model, context);
    const result = 'result' in value ? await value.result() : await value;
    assert.equal(result.stopReason, 'stop');
  }
  assert.deepEqual(counts(), { acquired: 4, released: 4 });
  assert.equal(budget.events.length, 4);
  assert.ok(budget.events.every(event => event.settled));
});

test('rebinding a derived runtime uses its current budget and attribution without double admission', async () => {
  const { runtime, budget, counts } = fixture();
  const bound = modelsWithProviderControl(runtime);
  const derived = { ...runtime, models: bound, attribution: { business: 'analysis' as const, payer: 'platform' as const } };
  await modelsWithProviderControl(derived).completeSimple(runtime.model, { messages: [] });
  assert.deepEqual(counts(), { acquired: 1, released: 1 });
  assert.equal(budget.events[0]?.attribution.business, 'analysis');
});

test('a model permit losing its lease cancels the nonstream helper operation', async () => {
  const { runtime } = fixture();
  const lease = new AbortController(); let released = false;
  runtime.providerGate = { acquire: async () => ({ signal: lease.signal, release: async () => { released = true; } }) };
  await assert.rejects(withProviderPermit(runtime, undefined, async signal => {
    assert.ok(signal);
    lease.abort(new Error('runtime_lease_lost'));
    signal.throwIfAborted();
  }), /runtime_lease_lost/);
  assert.equal(released, true);
});
