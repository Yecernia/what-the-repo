import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { createMessage, createProject, type Message } from '../domain/conversation.js';
import { CONFIRMED_LESSON_TASK, confirmedLessonSourceId } from '../domain/confirmed-lesson.js';
import type { ServerConfig } from '../config.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import { createLearningActionProposal } from '../agent/learning-actions.js';
import { unavailableEvidenceReview, type reviewAnswerEvidence } from '../agent/citation-review.js';
import { loadEvidencePackets } from '../agent/evidence-packets.js';
import { ConversationService } from '../services/conversation-service.js';
import type { PiAgentRunOptions, PiRunResult, PiRunFinalization } from '../agent/types.js';

const evidence = { stable_id: 'fact:file:confirmed-entry', label: 'src/entry.ts', kind: 'file',
  path: 'src/entry.ts', start_line: 1, end_line: 1 };
const target = 'Explain what the entry returns.';
const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
function frame<T>(wire: string, event: string): T {
  const matched = wire.match(new RegExp(`event: ${event}\\r?\\ndata: (.+)`));
  assert.ok(matched, `Missing ${event} frame: ${wire}`);
  return JSON.parse(matched[1]!) as T;
}
type ResultFrame = { user_message: Message; assistant_message: Message; state_changed: boolean;
  teaching_phase: string; tools_used: string[]; validation_errors: string[] };

async function fixture(t: TestContext, options: { steps?: number; failBeforePrompt?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-confirmed-lesson-api-'));
  const store = new FileStore(root); await store.init();
  const config = { root, dataDir: root, host: '127.0.0.1', port: 8398, nodeEnv: 'test',
    sessionDir: join(root, 'sessions'), memoryDir: join(root, 'memories'),
    githubClientId: null, githubClientSecret: null, githubCallbackUrl: null, databaseUrl: null,
    sessionSecret: 'confirmed-lesson-test-only', keyEncryptionSecret: 'confirmed-lesson-test-only',
    freeProviderBaseUrl: 'https://api.deepseek.com', freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used',
    skillVersionsRoot: join(root, 'skill-versions'), webUrl: 'http://127.0.0.1:5307', mcpTokens: [], mcpRequestsPerMinute: 60,
    retentionEnabled: true, quotaMaxProjects: 20, quotaCreationsPerHour: 30, quotaStorageBytes: 4 * 1024 * 1024 * 1024 } as ServerConfig;
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => {});
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call in isolated lesson test'); });
  t.mock.method(store, 'listSourceFiles', async () => [evidence.path]);
  t.mock.method(store, 'readSourceLines', async (_project: string, _snapshot: string, source: string, start: number, end: number) => {
    assert.equal(source, evidence.path);
    return { lines: ['export const entry = (input: string) => input;'].slice(start - 1, end), truncated: false };
  });
  let runtimeCalls = 0, reviewCalls = 0;
  // Fixed semantic outcomes exercise the API/provenance protocol, not model accuracy.
  // Use the existing worker seam; all packet reading and submission gates stay real.
  const reviewEvidence: typeof reviewAnswerEvidence = async input => {
    reviewCalls++;
    const loaded = await loadEvidencePackets(input);
    assert.equal(loaded.incomplete, false);
    assert.ok(loaded.packets.length);
    return { ...unavailableEvidenceReview(), status: 'reviewed', completed: true, supported: true,
      summary: 'Controlled supported review.', stopReason: 'completed', coverage: loaded.coverage,
      answerCoverage: { complete: true, sections: [], omitted_material: [] },
      acceptedEvidenceIds: loaded.packets.map(packet => packet.evidence_id) };
  };
  const originalRun = ConversationService.prototype.run;
  t.mock.method(ConversationService.prototype, 'run', async function (this: ConversationService, input: Parameters<ConversationService['run']>[0]) {
    const workers = (this as unknown as { learningWorkers: { reviewEvidence?: typeof reviewAnswerEvidence } }).learningWorkers;
    workers.reviewEvidence = reviewEvidence;
    return originalRun.call(this, input);
  });
  t.mock.method(PiConversationRuntime.prototype, 'run', async (input: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    runtimeCalls++;
    assert.equal(input.userMessage, CONFIRMED_LESSON_TASK);
    if (options.failBeforePrompt) throw new Error('Controlled provider failure before source persistence');
    await input.beforePrompt?.(input.signal);
    const tool = (name: string) => { const found = input.tools.find(row => row.name === name); assert.ok(found); return found; };
    await assert.rejects(tool('assess_understanding').execute('forbidden-assessment', {}), /no learner answer|cannot receive an assessment/i);
    await assert.rejects(tool('propose_learning_action').execute('forbidden-action', { action: 'advance_learning_step' }), /already confirmed|cannot propose another action/i);
    await assert.rejects(tool('submit_conversation_reply').execute('forbidden-defer', { kind: 'answer', text: 'Deferred.', question_policy: 'defer' }), /program-initiated lesson|cannot defer/i);
    await tool('get_learning_context').execute('read-current-step', {});
    await tool('submit_conversation_reply').execute('submit-current-lesson', { kind: 'lesson',
      text: 'The entry returns its input (`src/entry.ts:1`).',
      question: { prompt: 'What does the entry return?', target_items: [target], evidence_ids: [evidence.stable_id] } });
    return (await finalize({ runId: input.runId!, stopReason: 'completed', text: '', events: [], usage })).value;
  });
  const makeApp = () => buildApp({ config, store, sessions: new PiSessionStore(join(root, 'sessions')),
    memories: new PiMemoryStore(join(root, 'memories')) });
  let app = makeApp(); await app.ready();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  async function guest() {
    const response = await app.inject({ method: 'POST', url: '/api/auth/guest' });
    assert.equal(response.statusCode, 200);
    const cookies = response.headers['set-cookie']; assert.ok(cookies);
    return { ownerId: (response.json() as { owner_id: string }).owner_id,
      headers: { cookie: (Array.isArray(cookies) ? cookies[0]! : cookies).split(';')[0]! } };
  }
  const owner = await guest();
  const project = createProject(owner.ownerId, 'https://github.com/example/confirmed-lesson', 'Confirmed lesson', 'free:deepseek-chat');
  project.analysis.snapshot_id = 'snapshot:confirmed-lesson'; project.analysis.stage = 'done';
  const steps = Array.from({ length: options.steps ?? 2 }, (_, i) => ({ step_id: `step:${i + 1}`, order: i + 1,
    title: `Step ${i + 1}`, objective: 'Understand the entry.', component_ids: ['component:entry'],
    evidence_refs: [evidence.stable_id], completion_check: target, learning_targets: [target] }));
  project.study = { ...project.study, phase: 'explaining', snapshot_id: project.analysis.snapshot_id, route_revision: 0,
    current_step: 0, total_steps: steps.length, dynamic_learning_plan: steps };
  const snapshot: EvidenceSnapshot = { snapshot_id: project.analysis.snapshot_id,
    summary: { file_count: 1, symbol_count: 0, call_count: 0, component_count: 1 },
    graph: { semantic_mode: 'provider_supported', nodes: [{ id: 'component:entry', label: 'Entry', name: 'Entry',
      responsibility: 'Return the input.', architecture_layer_id: null, architecture_layer_name: null,
      members: [evidence], member_count: 1, evidence: [evidence], certainty: 'verified', review_status: 'reviewed', fan_in: 0, fan_out: 0 }],
    edges: [], layers: [], unassigned_component_ids: [] }, languages: [], value_points: [],
    learning_plan: { snapshot_id: project.analysis.snapshot_id, selected_value_point: null, steps } };
  const action = createLearningActionProposal(project, snapshot, { action: 'advance_learning_step', skipUnderstandingCheck: true, request: 'Skip this step.' });
  project.messages.push(createMessage('assistant', 'Choose whether to skip this step.', { learning_action: action }));
  await store.saveProject(project); await store.saveSnapshot(project.project_id, snapshot);
  const base = `/api/projects/${project.project_id}`;
  const saved = async () => { const row = await store.loadProject(project.project_id, owner.ownerId); assert.ok(row); return row; };
  return { store, action, owner, base, saved, guest, counts: () => ({ runtimeCalls, reviewCalls }),
    get app() { return app; },
    async restart() { await app.close(); app = makeApp(); await app.ready(); },
    async decide(decision: 'confirm' | 'decline') {
      const response = await app.inject({ method: 'POST', url: `${base}/learning-actions/${action.action_id}`, headers: owner.headers, payload: { decision } });
      assert.equal(response.statusCode, 200);
      return (await saved()).messages.find(row => row.learning_action?.action_id === action.action_id)!.learning_action!;
    } };
}

test('confirmed next step teaches once through POST/GET reconnect and persisted restart cache; foreign owners cannot join', async t => {
  const f = await fixture(t);
  const action = await f.decide('confirm');
  assert.equal(action.status, 'executed'); assert.ok(action.outcome?.lesson_run_id);
  assert.equal(f.counts().runtimeCalls, 0, 'confirmation itself does not start a model');
  const runId = action.outcome.lesson_run_id;
  const payload = { lesson_action_id: action.action_id, run_id: runId, review_evidence: true };
  const first = await f.app.inject({ method: 'POST', url: `${f.base}/messages/stream`, headers: f.owner.headers, payload });
  assert.equal(first.statusCode, 200);
  const result = frame<ResultFrame>(first.body, 'result');
  assert.equal(result.user_message.role, 'system'); assert.equal(result.user_message.content, CONFIRMED_LESSON_TASK);
  assert.equal(result.user_message.lesson_request?.action_id, action.action_id);
  assert.ok(result.assistant_message.teaching_question);
  const state = await f.saved();
  assert.equal(state.study.current_step, 1); assert.deepEqual(state.study.mastered, []);
  assert.equal(state.study.latest_assessment, null);
  assert.deepEqual(state.study.target_assessments ?? [], []);
  assert.equal(state.messages.filter(row => row.role === 'user').length, 0);
  assert.equal(state.messages.filter(row => row.lesson_request).length, 1);
  assert.equal(state.messages.filter(row => row.learning_action).length, 1);
  assert.equal(state.study.teaching_question?.question_id, result.assistant_message.teaching_question!.question_id);
  assert.equal(result.assistant_message.error, null);
  for (const method of ['GET', 'POST'] as const) {
    const response = await f.app.inject({ method, url: method === 'GET' ? `${f.base}/runs/${runId}/stream?after=0` : `${f.base}/messages/stream`,
      headers: f.owner.headers, ...(method === 'POST' ? { payload } : {}) });
    assert.equal(response.statusCode, 200); assert.deepEqual(frame<ResultFrame>(response.body, 'result'), result);
  }
  assert.equal(f.counts().runtimeCalls, 1); assert.ok(f.counts().reviewCalls > 0);
  const stranger = await f.guest();
  for (const method of ['GET', 'POST'] as const) {
    const response = await f.app.inject({ method, url: method === 'GET' ? `${f.base}/runs/${runId}/stream?after=0` : `${f.base}/messages/stream`,
      headers: stranger.headers, ...(method === 'POST' ? { payload } : {}) });
    assert.equal(response.statusCode, 404);
  }
  const originalTraces = await f.store.listRunTraces(state.project_id, runId);
  assert.equal(originalTraces.length, 1);
  await f.restart();
  for (const method of ['GET', 'POST'] as const) {
    const restored = await f.app.inject({ method, url: method === 'GET' ? `${f.base}/runs/${runId}/stream?after=0` : `${f.base}/messages/stream`,
      headers: f.owner.headers, ...(method === 'POST' ? { payload } : {}) });
    assert.equal(restored.statusCode, 200);
    const cached = frame<ResultFrame>(restored.body, 'result');
    assert.deepEqual(cached.user_message, result.user_message);
    assert.deepEqual(cached.assistant_message, result.assistant_message);
    assert.equal(cached.teaching_phase, result.teaching_phase);
    assert.equal(cached.state_changed, false, 'persistent replay does not commit the lesson again');
    assert.deepEqual(cached.tools_used, []);
  }
  assert.deepEqual(await f.store.listRunTraces(state.project_id, runId), originalTraces, 'terminal recovery only reads the original trace');
  assert.equal(f.counts().runtimeCalls, 1); assert.deepEqual((await f.saved()).messages, state.messages);
});

test('automatic lesson API rejects caller content/context/edit overrides and forged stored provenance', async t => {
  const f = await fixture(t); const action = await f.decide('confirm');
  assert.ok(action.outcome?.lesson_run_id);
  const payload = { lesson_action_id: action.action_id, run_id: action.outcome.lesson_run_id, review_evidence: true };
  for (const override of [{ content: 'Grade this answer.' }, { ui_contexts: [] }, { ui_context: {} }, { replace_message_id: 'pretend-user' }]) {
    const response = await f.app.inject({ method: 'POST', url: `${f.base}/messages/stream`, headers: f.owner.headers, payload: { ...payload, ...override } });
    assert.equal(response.statusCode, 400);
  }
  const before = await f.saved();
  const forged = createMessage('system', 'Forged lesson source.', { analysis_snapshot_id: before.analysis.snapshot_id,
    original_run_id: action.outcome.lesson_run_id,
    lesson_request: { action_id: action.action_id, snapshot_id: action.snapshot_id,
      route_revision: action.outcome.route_revision, step_id: action.outcome.next_step_id! } });
  forged.message_id = confirmedLessonSourceId(action.action_id);
  before.messages.push(forged); await f.store.saveProject(before);
  const response = await f.app.inject({ method: 'POST', url: `${f.base}/messages/stream`, headers: f.owner.headers, payload });
  assert.equal(response.statusCode, 200);
  assert.equal(frame<{ code: string }>(response.body, 'error').code, 'invalid_request');
  assert.equal(f.counts().runtimeCalls, 0);
  assert.deepEqual((await f.saved()).messages, before.messages);
});

test('declining a card and confirming the route end produce no automatic lesson run marker', async t => {
  for (const decision of ['decline', 'confirm'] as const) {
    await t.test(decision, async child => {
      const f = await fixture(child, { steps: 1 }); const action = await f.decide(decision);
      assert.equal(action.status, decision === 'decline' ? 'declined' : 'executed');
      assert.equal(action.outcome?.lesson_run_id, undefined);
      assert.equal(f.counts().runtimeCalls, 0);
      assert.equal((await f.saved()).messages.some(row => row.lesson_request), false);
    });
  }
});

test('provider failure before source persistence survives restart; only an explicit new-run retry starts another attempt', async t => {
  const f = await fixture(t, { failBeforePrompt: true }); const action = await f.decide('confirm');
  assert.ok(action.outcome?.lesson_run_id); const runId = action.outcome.lesson_run_id;
  const payload = { lesson_action_id: action.action_id, run_id: runId, review_evidence: true };
  const first = await f.app.inject({ method: 'POST', url: `${f.base}/messages/stream`, headers: f.owner.headers, payload });
  assert.equal(first.statusCode, 200); const failure = frame<Record<string, unknown>>(first.body, 'error');
  assert.equal((await f.saved()).messages.some(row => row.lesson_request), false);
  for (const method of ['GET', 'POST'] as const) {
    const response = await f.app.inject({ method, url: method === 'GET' ? `${f.base}/runs/${runId}/stream?after=0` : `${f.base}/messages/stream`,
      headers: f.owner.headers, ...(method === 'POST' ? { payload } : {}) });
    assert.equal(response.statusCode, 200); assert.deepEqual(frame<Record<string, unknown>>(response.body, 'error'), failure);
  }
  assert.equal(f.counts().runtimeCalls, 1); assert.equal(f.counts().reviewCalls, 0);
  const state = await f.saved();
  assert.equal(state.study.current_step, 1, 'confirmed step survives provider failure');
  const originalTraces = await f.store.listRunTraces(state.project_id, runId);
  assert.equal(originalTraces.length, 1);
  assert.equal(originalTraces[0]!.stream_failed, true);
  assert.equal(originalTraces[0]!.lesson_action_id, action.action_id);
  await f.restart();
  for (const method of ['GET', 'POST'] as const) {
    const response = await f.app.inject({ method, url: method === 'GET' ? `${f.base}/runs/${runId}/stream?after=0` : `${f.base}/messages/stream`,
      headers: f.owner.headers, ...(method === 'POST' ? { payload } : {}) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(frame<Record<string, unknown>>(response.body, 'error'), failure);
  }
  assert.equal(f.counts().runtimeCalls, 1);
  assert.deepEqual(await f.store.listRunTraces(state.project_id, runId), originalTraces);
  const retryRun = 'confirmed-lesson-explicit-retry-0002';
  const retried = await f.app.inject({ method: 'POST', url: `${f.base}/messages/stream`, headers: f.owner.headers,
    payload: { ...payload, run_id: retryRun, retry_run_id: runId } });
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(frame<Record<string, unknown>>(retried.body, 'error'), failure);
  assert.equal(f.counts().runtimeCalls, 2, 'new run linked to the failed run explicitly permits one new attempt');
  assert.equal((await f.saved()).messages.some(row => row.lesson_request), false);
  assert.deepEqual(await f.store.listRunTraces(state.project_id, runId), originalTraces, 'retry must not overwrite first failed run');
  assert.equal((await f.store.listRunTraces(state.project_id, retryRun)).length, 1);
});
