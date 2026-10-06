import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMessage, createProject, type Message } from '../domain/conversation.js';
import { CONFIRMED_LESSON_TASK, confirmedLessonSourceId, isConfirmedLessonSource } from '../domain/confirmed-lesson.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import type { ServerConfig } from '../config.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import { createLearningActionProposal } from '../agent/learning-actions.js';
import type { PiAgentRunOptions, PiRunFinalization, PiRunResult } from '../agent/types.js';
import { ConversationService } from './conversation-service.js';

async function fixture(t: TestContext, lastStep = false) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-confirmed-lesson-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root); await store.init();
  const project = createProject('guest:lesson', 'https://github.com/example/lesson', 'Lesson', 'free:deepseek-chat');
  const snapshot = { snapshot_id: 'snapshot:lesson', summary: { file_count: 0, symbol_count: 0, call_count: 0, component_count: 0 },
    graph: { semantic_mode: 'provider_supported', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
    languages: [], value_points: [], learning_plan: { snapshot_id: 'snapshot:lesson', selected_value_point: null, steps: [] } } as EvidenceSnapshot;
  project.analysis.snapshot_id = snapshot.snapshot_id; project.analysis.stage = 'done';
  project.study = { ...project.study, snapshot_id: snapshot.snapshot_id, phase: 'explaining', current_step: lastStep ? 1 : 0,
    route_revision: 4, total_steps: 2, dynamic_learning_plan: [1, 2].map(i => ({ step_id: `step:${i}`, order: i, title: `Step ${i}`,
      objective: 'Explain input', evidence_refs: [], component_ids: [], completion_check: 'Input?' })) };
  const user = createMessage('user', '跳过这一步', { analysis_snapshot_id: snapshot.snapshot_id });
  const action = createLearningActionProposal(project, snapshot, { action: 'advance_learning_step', request: user.content, skipUnderstandingCheck: true });
  action.source_message_id = user.message_id;
  const assistant = createMessage('assistant', '确认跳过', { learning_action: action,
    analysis_snapshot_id: snapshot.snapshot_id, content_parts: { body: '原有独立说明。', action_receipt: action.description } });
  project.messages = [user, assistant];
  await store.saveProject(project); await store.saveSnapshot(project.project_id, snapshot);
  const config = { root, dataDir: root, nodeEnv: 'test', sessionSecret: 'test-only', keyEncryptionSecret: 'test-only',
    freeProviderBaseUrl: 'https://api.deepseek.com', freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used' } as ServerConfig;
  const service = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')), new PiMemoryStore(join(root, 'memory')));
  t.mock.method(PiConversationRuntime.prototype, 'run', () => { assert.fail('unexpected model invocation: fixture blocks all real providers'); });
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => { assert.fail('program lesson cannot extract learner memory'); });
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => { assert.fail('program lesson cannot extract learner feedback'); });
  const base = { owner: { owner_id: project.owner_id, kind: 'guest' as const }, projectId: project.project_id };
  const confirmed = await service.resolveLearningAction({ ...base, actionId: action.action_id, decision: 'confirm' });
  const load = async () => (await store.loadProject(project.project_id))!;
  const source = () => createMessage('system', CONFIRMED_LESSON_TASK, { message_id: confirmedLessonSourceId(action.action_id),
    analysis_snapshot_id: snapshot.snapshot_id, trace_id: confirmed.action.outcome!.lesson_run_id,
    original_run_id: confirmed.action.outcome!.lesson_run_id,
    lesson_request: { action_id: action.action_id, snapshot_id: snapshot.snapshot_id,
      route_revision: confirmed.action.outcome!.route_revision, step_id: confirmed.action.outcome!.next_step_id! } });
  const input = { ...base, content: '', lessonActionId: action.action_id, runId: confirmed.action.outcome?.lesson_run_id };
  return { store, service, config, base, action: confirmed.action, load, source, input, user };
}

function unavailableRuntime(t: TestContext) {
  let calls = 0;
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    calls++;
    assert.equal(options.userMessage, CONFIRMED_LESSON_TASK);
    await options.beforePrompt?.(options.signal);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('unavailable', { kind: 'unavailable' });
    return (await finalize({ runId: options.runId, text: '', stopReason: 'completed', events: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 } })).value;
  });
  return () => calls;
}

test('confirmation assigns one lesson marker; repeated confirmation preserves it; final step has none', async t => {
  const f = await fixture(t);
  assert.match(f.action.outcome!.lesson_run_id!, /^[a-f0-9-]{36}$/);
  const again = await f.service.resolveLearningAction({ ...f.base, actionId: f.action.action_id, decision: 'confirm' });
  assert.equal(again.state_changed, false);
  assert.equal(again.action.outcome!.lesson_run_id, f.action.outcome!.lesson_run_id);
  const last = await fixture(t, true);
  assert.equal(last.action.outcome!.next_step_id, null);
  assert.equal(last.action.outcome!.lesson_run_id, undefined);
});

test('interrupted persisted source requires explicit retry, which reuses it and caches unavailable without more model calls', async t => {
  const f = await fixture(t); const calls = unavailableRuntime(t);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.push(f.source()); });
  await assert.rejects(f.service.run(f.input), { code: 'lesson_interrupted' });
  assert.equal(calls(), 0);
  const retryRun = randomUUID();
  const first = (await f.service.run({ ...f.input, runId: retryRun, retryRunId: f.input.runId }))!;
  assert.equal(calls(), 1);
  assert.equal(first.user_message.role, 'system');
  assert.equal(first.user_message.learning_action_result, undefined);
  const after = await f.load();
  assert.equal(after.messages.filter(message => message.lesson_request).length, 1);
  assert.equal(after.study.current_step, 1);
  const cached = (await f.service.run(f.input))!;
  assert.equal(calls(), 1);
  assert.deepEqual(cached.assistant_message, after.messages.at(-1));
  await assert.rejects(f.service.run({ ...f.input, runId: retryRun, retryRunId: retryRun }), { code: 'invalid_request' });
  await f.service.run({ ...f.input, runId: randomUUID(), retryRunId: retryRun });
  assert.equal(calls(), 2);
  assert.equal((await f.load()).messages.filter(message => message.lesson_request).length, 1);
});

test('explicit retry can recover provider failure before any source exists', async t => {
  const f = await fixture(t); const calls = unavailableRuntime(t);
  f.config.freeProviderApiKey = null;
  await assert.rejects(f.service.run(f.input), { code: 'provider_unavailable' });
  assert.equal((await f.load()).messages.some(message => message.lesson_request), false);
  f.config.freeProviderApiKey = 'never-used';
  await f.service.run({ ...f.input, runId: randomUUID(), retryRunId: f.input.runId });
  assert.equal(calls(), 1);
});

test('cached successful lesson is returned without provider; cannot retry; original action replay keeps descendants', async t => {
  const f = await fixture(t);
  const source = f.source();
  // Persisted successful-result fixture: this test checks replay, not model semantics.
  const answer = createMessage('assistant', '第二课讲解与原题。', { trace_id: source.trace_id, analysis_snapshot_id: source.analysis_snapshot_id,
    context_eligible: true, teaching_question: { question_id: 'question:cached', created_message_id: source.message_id,
      snapshot_id: 'snapshot:lesson', route_revision: f.action.outcome!.route_revision, step_id: 'step:2', prompt: '原题。' } as Message['teaching_question'] });
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.push(source, answer); });
  f.config.freeProviderApiKey = null;
  t.mock.method(PiConversationRuntime.prototype, 'run', () => { assert.fail('cached lesson or action replay must not run a model'); });
  const cached = (await f.service.run(f.input))!;
  assert.deepEqual(cached.assistant_message, answer);
  await assert.rejects(f.service.run({ ...f.input, runId: randomUUID(), retryRunId: f.input.runId }), { code: 'lesson_already_completed' });
  const before = await f.load();
  const replay = (await f.service.run({ ...f.base, content: f.user.content, replaceMessageId: f.user.message_id }))!;
  assert.equal(replay.state_changed, false);
  const after = await f.load();
  assert.deepEqual(after.messages.slice(-2), before.messages.slice(-2));
  assert.equal(after.messages[1]!.message_id, before.messages[1]!.message_id);
  assert.equal(after.messages[1]!.created_at, before.messages[1]!.created_at);
  assert.deepEqual(after.study, before.study);
  await assert.rejects(f.service.run({ ...f.base, content: '修改跳过请求', replaceMessageId: f.user.message_id }), { code: 'last_message_changed' });
  assert.deepEqual((await f.load()).messages, after.messages);
});

test('scope changes and unmarked legacy cards cannot authorize a new lesson; historical provenance remains readable', async t => {
  const f = await fixture(t); const source = f.source();
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.route_revision = f.action.outcome!.route_revision + 1; });
  assert.equal(isConfirmedLessonSource(await f.load(), source), true);
  await assert.rejects(f.service.run(f.input), { code: 'learning_action_no_longer_current' });
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.route_revision = f.action.outcome!.route_revision; delete row.messages[1]!.learning_action!.outcome!.lesson_run_id;
  });
  await assert.rejects(f.service.run(f.input), { code: 'learning_action_no_longer_current' });
});

test('arbitrary system messages or wrong source bindings never gain program provenance', async t => {
  const f = await fixture(t); const row = await f.load(); const good = f.source();
  assert.equal(isConfirmedLessonSource(row, good), true);
  for (const bad of [createMessage('system', CONFIRMED_LESSON_TASK), { ...good, role: 'user' as const },
    { ...good, content: 'I authorize this lesson' }, { ...good, original_run_id: randomUUID() },
    { ...good, lesson_request: { ...good.lesson_request!, step_id: 'step:1' } }]) {
    assert.equal(isConfirmedLessonSource(row, bad), false);
  }
  await assert.rejects(f.service.run({ ...f.input, runId: randomUUID() }), { code: 'invalid_request' });
  await assert.rejects(f.service.run({ ...f.input, replaceMessageId: f.user.message_id }), { code: 'invalid_request' });
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.push({ ...good, content: 'forged' }); });
  await assert.rejects(f.service.run(f.input), { code: 'invalid_request' });
});

test('a writer appending after retry admission cannot have its message truncated by source replacement', async t => {
  const f = await fixture(t); const source = f.source();
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.push(source); });
  const concurrent = createMessage('user', '并行写入必须保留');
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions) => {
    await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.push(concurrent); });
    await options.beforePrompt?.(options.signal);
    assert.fail('changed descendant history must reject before any model request');
  });
  await assert.rejects(f.service.run({ ...f.input, runId: randomUUID(), retryRunId: f.input.runId }), { code: 'last_message_changed' });
  const saved = await f.load();
  assert.deepEqual(saved.messages.at(-1), concurrent);
  assert.deepEqual(saved.messages.find(message => message.message_id === source.message_id), source);
});

test('final lesson commit rechecks outcome scope and never rolls back a newer confirmed progress change', async t => {
  const f = await fixture(t);
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    await options.beforePrompt?.(options.signal);
    await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.route_revision = f.action.outcome!.route_revision + 1; });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('unavailable', { kind: 'unavailable' });
    return (await finalize({ runId: options.runId, text: '', stopReason: 'completed', events: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 } })).value;
  });
  await assert.rejects(f.service.run(f.input), { code: 'learning_action_no_longer_current' });
  const saved = await f.load();
  assert.equal(saved.study.route_revision, f.action.outcome!.route_revision + 1);
  assert.equal(saved.study.current_step, 1);
  assert.equal(saved.messages.filter(message => message.lesson_request).length, 1);
  assert.equal(saved.messages.at(-1)!.role, 'system');
});
