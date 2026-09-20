import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRuntime } from './model-runtime.js';
import { providerReservation } from './provider-reservation.js';
import { resolveDeploymentProvider } from './provider-resolver.js';
import type { Context } from '@earendil-works/pi-ai';

const config = resolveDeploymentProvider({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash', apiKey: 'test-key', connectionId: 'analysis' })!;
const model = createModelRuntime(config).model;
const context: Context = { messages: [{ role: 'user', content: '你好', timestamp: 1 }] };

test('short input reserves less than a full window while retaining the entire output ceiling', () => {
  const full = providerReservation(model);
  const short = providerReservation(model, context);
  assert.ok(short < full);
  assert.ok(short > model.maxTokens * model.cost.output / 1e6);
  assert.equal(model.maxTokens, 384_000);
  assert.equal(full, 0.7608);
});

test('system instructions, tool schemas, tool results and multilingual history count towards reservations', () => {
  const base = providerReservation(model, context);
  assert.ok(providerReservation(model, { ...context, systemPrompt: '说明'.repeat(1000) }) > base);
  assert.ok(providerReservation(model, { ...context, tools: [{ name: 'tool', description: 'schema'.repeat(1000), parameters: { type: 'object' } as never }] }) > base);
  assert.ok(providerReservation(model, { messages: [...context.messages, { role: 'toolResult', toolName: 'tool', toolCallId: '1', isError: false, timestamp: 2, content: [{ type: 'text', text: '结果'.repeat(1000) }] }] }) > base);
  assert.equal(providerReservation(model, { messages: [{ role: 'user', content: 'x'.repeat(model.contextWindow), timestamp: 1 }] }), providerReservation(model));
});

test('images and arbitrary payload rewrites retain full-window safety', () => {
  assert.equal(providerReservation(model, context, true), providerReservation(model));
  assert.equal(providerReservation(model, { messages: [{ role: 'user', timestamp: 1,
    content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }] }), providerReservation(model));
});
