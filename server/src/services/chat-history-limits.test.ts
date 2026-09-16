import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessage } from '../domain/conversation.js';
import { loadConfig } from '../config.js';
import { assertChatHistoryCapacity } from './chat-history-limits.js';

test('chat limits count user turns, preserve retries at the limit and measure UTF-8 content', () => {
  const user = createMessage('user', '问题');
  const answer = createMessage('assistant', '回答');
  const messages = [user, answer];
  const original = structuredClone(messages);
  assert.throws(() => assertChatHistoryCapacity(messages, 'new', undefined, { chatMaxRounds: 1 }),
    { code: 'site_project_chat_round_limit', statusCode: 409 });
  assert.doesNotThrow(() => assertChatHistoryCapacity(messages, 'edited', user.message_id, { chatMaxRounds: 1 }));
  assert.throws(() => assertChatHistoryCapacity(messages, 'a', undefined, { chatMaxContentBytes: 13 }),
    { code: 'site_project_chat_size_limit' });
  assert.doesNotThrow(() => assertChatHistoryCapacity(messages, 'a', undefined, { chatMaxContentBytes: 14 }));
  assert.throws(() => assertChatHistoryCapacity([], '😀', undefined, { chatMaxContentBytes: 4 }),
    { code: 'site_project_chat_size_limit' });
  assert.doesNotThrow(() => assertChatHistoryCapacity(messages, 'a', user.message_id, { chatMaxContentBytes: 4 }));
  assert.deepEqual(messages, original, 'rejection never deletes or truncates history');
});

test('chat admission defaults and deployment overrides', () => {
  assert.equal(loadConfig({}).chatMaxRounds, 10_000);
  assert.equal(loadConfig({}).chatMaxContentBytes, 100 * 1024 * 1024);
  const config = loadConfig({ WHAT_THE_REPO_CHAT_MAX_ROUNDS: '2', WHAT_THE_REPO_CHAT_MAX_CONTENT_BYTES: '1024' });
  assert.equal(config.chatMaxRounds, 2);
  assert.equal(config.chatMaxContentBytes, 1024);
});
