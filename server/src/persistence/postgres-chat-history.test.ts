import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMessage, createProject } from '../domain/conversation.js';
import { assertChatHistoryCapacity } from '../services/chat-history-limits.js';
import { PostgresStore } from './postgres-store.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('PostgreSQL only writes changed messages and atomically edits/rejects turns', { skip: !url }, async () => {
  assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-chat-history-'));
  const store = new PostgresStore({ root, databaseUrl: url!, migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'chat-history-test-secret' });
  try {
    await store.init();
    const owner = 'github:chat-history-test';
    await store.saveUser(owner, { login: 'chat-history-test' });
    const project = createProject(owner, 'https://github.com/example/chat-history', 'Chat history');
    for (let i = 0; i < 1_000; i++) project.messages.push(createMessage(i % 2 ? 'assistant' : 'user', 'retained history ' + i));
    await store.saveProject(project);
    const positions = async () => new Map((await store.pool.query<{ message_id: string; version: string }>(
      'SELECT message_id, ctid::text AS version FROM project_messages WHERE project_id=$1', [project.project_id],
    )).rows.map(row => [row.message_id, row.version]));
    const before = await positions();
    await store.saveProject(project);
    assert.deepEqual(await positions(), before, 'resaving identical values does not update tuples');
    await store.updateProject(project.project_id, owner, row => { row.title = 'New title'; });
    assert.deepEqual(await positions(), before, 'metadata-only updates leave all message tuples untouched');
    const user = createMessage('user', 'new question');
    const answer = createMessage('assistant', 'old answer');
    await store.updateProject(project.project_id, owner, row => { row.messages.push(user, answer); });
    const appended = await positions();
    for (const [id, version] of before) assert.equal(appended.get(id), version);
    const oldUserVersion = appended.get(user.message_id);
    await store.updateProject(project.project_id, owner, row => {
      row.messages = row.messages.filter(message => message.message_id !== answer.message_id);
      row.messages.at(-1)!.content = 'edited question';
    });
    const edited = await positions();
    assert.equal(edited.has(answer.message_id), false);
    assert.notEqual(edited.get(user.message_id), oldUserVersion);
    for (const [id, version] of before) assert.equal(edited.get(id), version);
    const stable = await store.loadProject(project.project_id, owner);
    await assert.rejects(store.updateProject(project.project_id, owner, row => {
      row.title = 'must roll back';
      row.messages.shift();
      assertChatHistoryCapacity(row.messages, 'blocked', undefined, { chatMaxRounds: 1 });
    }), { code: 'site_project_chat_round_limit' });
    assert.deepEqual(await store.loadProject(project.project_id, owner), stable);
    // An in-place feedback mutation must still update exactly its target row.
    await store.updateProject(project.project_id, owner, row => {
      row.messages[1].feedback = { vote: 'up', updated_at: new Date().toISOString() };
    });
    const feedback = await positions();
    assert.notEqual(feedback.get(project.messages[1].message_id), before.get(project.messages[1].message_id));
    assert.equal(feedback.get(project.messages[0].message_id), before.get(project.messages[0].message_id));
    const limited = createProject(owner, 'https://github.com/example/limited', 'Limited');
    await store.saveProject(limited);
    const attempts = await Promise.allSettled([1, 2].map(i => store.updateProject(limited.project_id, owner, row => {
      assertChatHistoryCapacity(row.messages, String(i), undefined, { chatMaxRounds: 1 });
      row.messages.push(createMessage('user', String(i)));
    })));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await store.loadProject(limited.project_id))!.messages.length, 1, 'concurrent admission cannot pass the last available turn twice');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
