import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { compatibleReplayContext, PromptCacheObserver, workerPromptCacheKey } from './prompt-cache.js';
import type { PiModelRuntime } from './types.js';

test('same-model protocol state stays intact; cross-model reasoning never becomes ordinary text', () => {
  const model = fauxProvider({ provider: 'replay-test' }).getModel();
  const context: Context = { messages: [{ role: 'assistant', provider: model.provider, api: model.api, model: model.id,
    content: [{ type: 'thinking', thinking: '', thinkingSignature: 'encrypted-state' },
      { type: 'text', text: 'answer', textSignature: 'message-signature' },
      { type: 'toolCall', id: 'call', name: 'read', arguments: {}, thoughtSignature: 'tool-signature' }],
  } as AssistantMessage] };
  assert.equal(compatibleReplayContext(context, model), context);
  const changed = compatibleReplayContext(context, { ...model, id: 'other' });
  assert.deepEqual((changed.messages[0] as AssistantMessage).content, [
    { type: 'text', text: 'answer' }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} },
  ]);
  assert.equal((context.messages[0] as AssistantMessage).content.length, 3);
});

test('wire diagnostics distinguish prefix changes, stay bounded, and retain only digests', () => {
  const observer = new PromptCacheObserver(2, 1);
  const payload = { system: 'private system', tools: [{ name: 'read' }], messages: [
    { role: 'user', content: 'private question' }, { role: 'assistant', content: 'private answer' },
  ] };
  assert.equal(observer.observe('a', payload, 0).reason, 'first_request');
  const extended = { ...payload, messages: [...payload.messages, { role: 'user', content: 'next' }] };
  const next = observer.observe('a', extended, 1);
  assert.equal(next.reason, 'prefix_preserved');
  assert.equal(next.commonMessages, 1);
  assert.doesNotMatch(JSON.stringify(next), /private|question|answer/);
  const changed = { ...extended, messages: [payload.messages[0], { role: 'assistant', content: 'changed outside sampled range' }] };
  assert.equal(observer.observe('a', changed, 2).reason, 'history_changed');
  assert.equal(observer.observe('a', { ...changed, system: 'new' }, 3).reason, 'system_changed');
  assert.equal(observer.observe('a', { ...changed, tools: [] }, 4).reason, 'tools_changed');
  observer.observe('b', payload, 5); observer.observe('c', payload, 6);
  assert.equal(observer.observe('a', payload, 7).reason, 'first_request');
  assert.equal(observer.observe('a', payload, 30 * 60_000 + 8).reason, 'first_request');
  observer.observe('anthropic', { messages: [{ role: 'user', content: [
    { type: 'text', text: 'first', cache_control: { type: 'ephemeral' } },
  ] }] });
  assert.equal(observer.observe('anthropic', { messages: [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'user', content: [{ type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }] },
  ] }).reason, 'prefix_preserved');
});

test('only known OpenAI workers share cache keys within owner and credential boundaries', () => {
  const runtime = { model: { ...fauxProvider().getModel(), api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    ownerId: 'owner', apiKey: 'key-a', providerConnectionId: 'connection',
    attribution: { business: 'analysis', payer: 'platform', agentRole: 'component-explanation' },
  } as PiModelRuntime;
  const context = { systemPrompt: 'stable', messages: [] };
  const key = workerPromptCacheKey(runtime, context, 'worker-one');
  assert.match(key!, /^[a-f0-9]{64}$/);
  assert.equal(key, workerPromptCacheKey(runtime, context, 'worker-two'));
  assert.notEqual(key, workerPromptCacheKey({ ...runtime, ownerId: 'another' }, context, 'worker-one'));
  assert.notEqual(key, workerPromptCacheKey({ ...runtime, apiKey: 'key-b' }, context, 'worker-one'));
  assert.equal(workerPromptCacheKey(runtime, context, 'conversation'), 'conversation');
  assert.equal(workerPromptCacheKey({ ...runtime, model: { ...runtime.model, baseUrl: 'https://api.deepseek.com' } }, context, 'worker-one'), 'worker-one');
});
