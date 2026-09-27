import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessage, createProject, type Project } from '../domain/conversation.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import type { ServerConfig } from '../config.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import { createLearningActionProposal, applyCompletedLearningRoute } from '../agent/learning-actions.js';
import type { PiAgentRunOptions, PiRunFinalization, PiRunResult } from '../agent/types.js';
import type { generateLearningRoute } from '../agent/teaching-workers.js';
import { ConversationService } from './conversation-service.js';
import { RepositoryService } from './repository-service.js';

const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const snapshot: EvidenceSnapshot = {
  snapshot_id: 'snapshot:regression', summary: { file_count: 0, symbol_count: 0, call_count: 0, component_count: 0 },
  graph: { semantic_mode: 'provider_supported', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
  languages: [], value_points: [], learning_plan: { snapshot_id: 'snapshot:regression', selected_value_point: null, steps: [] },
};
const steps = [1, 2, 3].map(i => ({ step_id: `step:${i}`, order: i, title: `Step ${i}`, objective: 'Explain input',
  component_ids: [], evidence_refs: [], completion_check: 'What is the input?' }));
const routeResult = (): Awaited<ReturnType<typeof generateLearningRoute>> => ({ completed: true, steps,
  trace: { worker_run_id: 'route:mock', skill_id: 'learning-route', skill_version: 'test', stop_reason: 'completed',
    completed: true, usage, evidence_ids: [], state_candidate: true } });

async function fixture(t: TestContext, generateRoute: typeof generateLearningRoute = async () => routeResult()) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-teaching-regression-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new FileStore(root); await store.init();
  const project = createProject('guest:teaching', 'https://github.com/example/teaching', 'Teaching', 'free:deepseek-chat');
  project.analysis.snapshot_id = snapshot.snapshot_id; project.analysis.stage = 'done';
  project.study = { ...project.study, snapshot_id: snapshot.snapshot_id, phase: 'explaining', current_step: 0,
    total_steps: 3, route_revision: 0, dynamic_learning_plan: structuredClone(steps) };
  await store.saveProject(project); await store.saveSnapshot(project.project_id, snapshot);
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => {});
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => {});
  const config = { root, dataDir: root, nodeEnv: 'test', sessionSecret: 'test-only',
    keyEncryptionSecret: 'test-only', freeProviderBaseUrl: 'https://api.deepseek.com',
    freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used' } as ServerConfig;
  const service = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')),
    new PiMemoryStore(join(root, 'memory')), undefined, undefined, undefined, undefined, { generateRoute });
  const secondService = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')),
    new PiMemoryStore(join(root, 'memory')), undefined, undefined, undefined, undefined, { generateRoute });
  const base = { owner: { owner_id: project.owner_id, kind: 'guest' as const }, projectId: project.project_id };
  const load = async () => (await store.loadProject(project.project_id, project.owner_id))!;
  return { root, store, project, service, secondService, base, load };
}

function mockTurn(t: TestContext, propose: boolean, text = '收到。') {
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    await options.beforePrompt?.(options.signal);
    if (propose) {
      try { await options.tools.find(tool => tool.name === 'propose_learning_action')!.execute('skip', {
        action: 'advance_learning_step', skip_understanding_check: true,
      }); } catch (error) {
        // The real runtime presents rejected tool calls to the model and continues the answer.
        assert.equal((error as { code?: string }).code, 'tool_request_rejected');
      }
    }
    return (await finalize({ runId: options.runId!, text, stopReason: 'completed', usage, events: [] })).value;
  });
}

test('negative, quoted and conditional requests never advance, even when a model asks to skip', async t => {
  const f = await fixture(t); mockTurn(t, true);
  for (const content of ['不要进入下一步，我还没懂。', '你刚才说“直接进入下一步”是什么意思？', '如果我跳过理解检查会怎样？', 'Do not go to the next step.']) {
    const result = await f.service.run({ ...f.base, content });
    assert.equal((await f.load()).study.current_step, 0);
    assert.equal(result?.assistant_message.learning_action ?? null, null);
    assert.doesNotMatch(result!.assistant_message.content, /你明确选择跳过/);
  }
});

test('natural language never manufactures an action, while an explicit button binds its original step', async t => {
  const f = await fixture(t); mockTurn(t, false);
  await f.service.run({ ...f.base, content: '直接进入下一步' });
  assert.equal((await f.load()).study.current_step, 0);
  await f.service.run({ ...f.base, content: '跳过这一步', learningIntent: {
    kind: 'skip_current_step', route_revision: 0, step_id: 'step:1', snapshot_id: snapshot.snapshot_id,
  } });
  assert.equal((await f.load()).study.current_step, 1);
  await assert.rejects(f.service.run({ ...f.base, content: '跳过这一步', learningIntent: {
    kind: 'skip_current_step', route_revision: 0, step_id: 'step:1', snapshot_id: snapshot.snapshot_id,
  } }), { code: 'learning_action_no_longer_current' });
});

test('retry, network replay and editing an applied message cannot authorize another advance', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  assert.equal((await f.load()).study.current_step, 1);
  assert.ok(first.user_message.learning_action_result);
  await f.service.run({ ...f.base, content: '直接进入下一步', replaceMessageId: first.user_message.message_id });
  const current = await f.load();
  await f.service.run({ ...f.base, content: '请直接进入下一步', retryRunId: current.messages[0]!.trace_id! });
  await f.service.run({ ...f.base, content: '直接进入下一步', retryRunId: first.user_message.trace_id! });
  const saved = await f.load();
  assert.equal(saved.study.current_step, 1);
  assert.equal(saved.study.route_revision, 1);
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.match(saved.messages.at(-1)!.content, /没有再次改变/);
});

test('code review cannot silently skip a repository claim without tools, and details survive in history', async t => {
  const f = await fixture(t); mockTurn(t, false, '这个仓库保证绝对不会生成重复 ID。');
  const result = (await f.service.run({ ...f.base, content: '核对 ID 是否重复', reviewEvidence: true }))!;
  assert.equal(result.assistant_message.context_eligible, false);
  assert.equal(result.assistant_message.evidence_review?.status, 'unverified');
  assert.ok(result.validation_errors.includes('citation_review_unavailable'));
  assert.match(result.assistant_message.content, /没有可复查/);
  assert.match((await f.load()).messages.at(-1)!.content, /绝对不会生成重复 ID/);
});

test('a pending normal advance expires when the later understanding check revoked mastery', async t => {
  const f = await fixture(t);
  f.project.study.step_passed = { step_id: 'step:1', snapshot_id: snapshot.snapshot_id, route_revision: 0,
    mastered_items: ['Input'], evidence_ids: ['evidence:input'] };
  const action = createLearningActionProposal(f.project, snapshot, { action: 'advance_learning_step', request: 'Continue' });
  f.project.messages.push(createMessage('assistant', 'Continue?', { learning_action: action }));
  f.project.study.step_passed = null;
  f.project.study.misconceptions = ['Confused input and output'];
  await f.store.saveProject(f.project);
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'expired');
  assert.equal(result.state_changed, false);
  assert.equal(result.project.study.current_step, 0);
});

test('selecting a new value point invalidates pending actions even on the same snapshot', async t => {
  const f = await fixture(t);
  const old = createLearningActionProposal(f.project, snapshot, { action: 'stop_guided_learning', request: 'Stop' });
  f.project.messages.push(createMessage('assistant', 'Stop?', { learning_action: old }));
  await f.store.saveProject(f.project);
  const repository = new RepositoryService(f.store);
  t.mock.method(repository, 'boundSnapshot', async () => ({ project: await f.load(),
    snapshot: { ...snapshot, value_points: [{ stable_id: 'value:new' }] } as unknown as EvidenceSnapshot }));
  await repository.getLearningPlan(f.project.owner_id, f.project.project_id, snapshot.snapshot_id, 'value:new');
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: old.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'expired');
  assert.equal(result.project.study.selected_value_point, 'value:new');
  assert.equal(result.project.study.route_revision, 1);
});

async function addRoute(store: FileStore, project: Project) {
  const source = createMessage('user', 'Teach me');
  const card = createLearningActionProposal(project, snapshot, { action: 'start_learning_route', targetKind: 'repository', request: 'Teach me' });
  card.source_message_id = source.message_id;
  project.messages.push(source, createMessage('assistant', 'Confirm goal', { learning_action: card }));
  await store.saveProject(project);
  return card;
}

test('configuration and trace failures leave route cards retryable; duplicate confirmation returns original result', async t => {
  const f = await fixture(t); const card = await addRoute(f.store, f.project);
  const input = { ...f.base, actionId: card.action_id, decision: 'confirm' as const };
  const settings = t.mock.method(f.store, 'loadSettings', async () => { throw new Error('database unavailable'); });
  assert.equal((await f.service.resolveLearningAction(input)).action.status, 'failed');
  settings.mock.restore();
  const trace = t.mock.method(f.store, 'saveTrace', async () => { throw new Error('trace unavailable'); });
  assert.equal((await f.service.resolveLearningAction(input)).action.status, 'failed');
  assert.equal((await f.load()).study.route_revision, 0);
  trace.mock.restore();
  const completed = await f.service.resolveLearningAction(input);
  assert.equal(completed.action.status, 'executed');
  assert.equal(completed.project.study.route_revision, 1);
  assert.ok(completed.project.messages[0]!.learning_action_result);
  assert.equal((await f.service.resolveLearningAction(input)).state_changed, false);
  assert.equal((await f.load()).study.route_revision, 1);
});

test('expired confirmed route can recover and late generation cannot replace a newer route', async t => {
  let replace = false;
  const f = await fixture(t, async () => {
    if (replace) await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
      const newer = createLearningActionProposal(row, snapshot, { action: 'switch_learning_target', targetKind: 'repository', request: 'New goal' });
      applyCompletedLearningRoute(row, newer, [{ ...steps[0]!, step_id: 'new:step' }]);
    });
    return routeResult();
  });
  const card = await addRoute(f.store, f.project);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    const action = row.messages[1]!.learning_action!; action.status = 'confirmed'; action.run_expires_at = new Date(0).toISOString();
  });
  replace = true;
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'failed');
  assert.equal((await f.load()).study.dynamic_learning_plan?.[0]?.step_id, 'new:step');
  assert.equal((await f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' })).action.status, 'expired');
});

test('route generation shares project exclusion with chat and cancellation releases the project', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async input => {
    entered();
    await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return routeResult();
  });
  const card = await addRoute(f.store, f.project);
  const running = f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' });
  await started;
  await assert.rejects(f.service.run({ ...f.base, content: 'Another turn' }), { code: 'session_busy' });
  await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'session_busy' });
  await assert.rejects(f.secondService.run({ ...f.base, content: 'Concurrent instance retry' }), { code: 'session_busy' });
  await assert.rejects(f.secondService.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'session_busy' });
  assert.equal(f.service.controlRun({ ...f.base, runId: card.action_id, action: 'cancel' }), true);
  assert.equal((await running).action.status, 'failed');
  assert.equal((await f.load()).study.route_revision, 0);
  mockTurn(t, false);
  assert.ok(await f.service.run({ ...f.base, content: 'Recovered' }));
});
