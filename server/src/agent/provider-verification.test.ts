import assert from 'node:assert/strict';
import test from 'node:test';
import dns from 'node:dns/promises';
import { verifyManualModel } from './provider-verification.js';

test('manual verification uses the Anthropic adapter and requires a text response', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://api.minimaxi.com/anthropic/v1/messages');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fake-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'MiniMax-new-preview');
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, true);
    const events = [
      { type: 'message_start', message: { id: 'probe', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 6, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const connection = { connection_id: 'probe', provider: 'minimax-cn' as const, label: 'Probe', base_url: null, custom_models: [], last_verified_at: null, verify_error: null };
  assert.equal((await verifyManualModel(connection, 'fake-key', 'MiniMax-new-preview')).ok, true);
  assert.equal((await verifyManualModel(connection, 'fake-key', 'minimax-video-h3')).ok, false);
  assert.equal(calls, 1, 'Non-chat names must be rejected before a paid call');
});

test('manual custom endpoints use conversational wire defaults and reject private destinations', async (t) => {
  t.mock.method(dns, 'lookup', async (hostname: string) => [{ address: hostname === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }]);
  let calls = 0;
  let payload: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://public.example/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    payload = body;
    return new Response('data: ' + JSON.stringify({ id: 'probe', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const connection = { connection_id: 'probe', provider: 'custom' as const, label: 'Probe', base_url: 'https://public.example/v1', custom_models: [], last_verified_at: null, verify_error: null };
  assert.equal((await verifyManualModel(connection, 'fake-key', 'unlisted-chat')).ok, true);
  assert.equal(payload.model, 'unlisted-chat');
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 1024);
  assert.equal((await verifyManualModel({ ...connection, base_url: 'https://private.example/v1' }, 'fake-key', 'unlisted-chat')).ok, false);
  assert.equal(calls, 1);
});
