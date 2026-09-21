import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { credentialSafeEvents } from './credential-stream.js';
import { providerErrorCode } from './provider-error.js';

const key = 'canary_private_KEY-42.test';
const message = (): AssistantMessage => ({ role: 'assistant', content: [], api: 'openai-completions',
  provider: 'custom', model: 'model', stopReason: 'stop', timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test('streamed upstream credential echoes never reach Agent deltas, results or errors', async () => {
  const partial = message();
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'text_start', contentIndex: 0, partial };
    yield { type: 'text_delta', contentIndex: 0, delta: 'Reply ' + key.slice(0, 7), partial };
    partial.content = [{ type: 'text', text: 'Reply ' + key }];
    yield { type: 'text_delta', contentIndex: 0, delta: key.slice(7), partial };
    yield { type: 'text_end', contentIndex: 0, content: 'Reply ' + key, partial };
    yield { type: 'done', reason: 'stop', message: partial };
  }
  const events: AssistantMessageEvent[] = [];
  for await (const event of credentialSafeEvents(source(), [key])) events.push(event);
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'Reply [redacted]');
  assert.equal(JSON.stringify(events).includes(key), false);
  assert.equal((events.at(-1) as Extract<AssistantMessageEvent, { type: 'done' }>).message.content[0]?.type, 'text');
});

test('provider failures become fixed codes rather than provider prose or credential fragments', async () => {
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: 'error', reason: 'error', error: { ...message(), stopReason: 'error',
      errorMessage: '401 invalid API key ' + key + ' query=' + encodeURIComponent(key) } };
  }
  for await (const event of credentialSafeEvents(source(), [key])) {
    assert.equal(event.type, 'error');
    if (event.type === 'error') assert.equal(event.error.errorMessage, 'provider_authentication_failed');
    assert.equal(JSON.stringify(event).includes(key), false);
  }
  for (const code of ['provider_busy', 'provider_connection_failed', 'provider_authentication_failed', 'site_budget_busy']) {
    assert.equal(providerErrorCode(code), code);
  }
});

test('keys split across separate text content blocks cannot be reconstructed from deltas or the final answer', async () => {
  const partial = message();
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    for (const [contentIndex, text] of [key.slice(0, 10), key.slice(10)].entries()) {
      partial.content.push({ type: 'text', text });
      yield { type: 'text_delta', contentIndex, delta: text, partial };
      yield { type: 'text_end', contentIndex, content: text, partial };
    }
    yield { type: 'done', reason: 'stop', message: partial };
  }
  let deltas = '', final = '';
  for await (const event of credentialSafeEvents(source(), [key])) {
    if (event.type === 'text_delta') deltas += event.delta;
    if (event.type === 'done') final = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  }
  assert.equal(deltas, '[redacted]'); assert.equal(final, '[redacted]');
});
