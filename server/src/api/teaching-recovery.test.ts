import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { createProject } from '../domain/conversation.js';
import type { ServerConfig } from '../config.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import type { PiAgentRunOptions, PiRunResult, PiRunFinalization } from '../agent/types.js';

test('TA27 same-run API recovery restores a skip proposal, then explicit confirmation and message replay execute once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-teaching-recovery-'));
  const store = new FileStore(root); await store.init();
  const config = { root, dataDir: root, host: '127.0.0.1', port: 8398, nodeEnv: 'test', sessionDir: join(root, 'sessions'), memoryDir: join(root, 'memories'),
    githubClientId: null, githubClientSecret: null, githubCallbackUrl: null, databaseUrl: null,
    sessionSecret: 'recovery-test-only', keyEncryptionSecret: 'recovery-test-only',
    freeProviderBaseUrl: 'https://api.deepseek.com', freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used',
    skillVersionsRoot: join(root, 'skill-versions'), webUrl: 'http://127.0.0.1:5307', mcpTokens: [], mcpRequestsPerMinute: 60,
    retentionEnabled: true, quotaMaxProjects: 20, quotaCreationsPerHour: 30, quotaStorageBytes: 4 * 1024 * 1024 * 1024 } as ServerConfig;
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => {});
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => {});
  let runtimeCalls = 0;
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    runtimeCalls++;
    await options.beforePrompt?.(options.signal);
    await options.tools.find(tool => tool.name === 'interpret_teaching_turn')!.execute('interpret-skip',
      { parts: [{ kind: 'control', text: options.userMessage }] });
    await options.tools.find(tool => tool.name === 'propose_learning_action')!.execute('propose-skip',
      { action: 'advance_learning_step', advance_mode: 'skip' });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('skip-reply', { kind: 'action', text: '' });
    return (await finalize({ runId: options.runId!, stopReason: 'completed', text: '', events: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 } })).value;
  });
  const app = buildApp({ config, store, sessions: new PiSessionStore(join(root, 'sessions')), memories: new PiMemoryStore(join(root, 'memories')) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guest = await app.inject({ method: 'POST', url: '/api/auth/guest' });
  const owner = guest.json() as { owner_id: string };
  const cookie = guest.headers['set-cookie']!;
  const headers = { cookie: (Array.isArray(cookie) ? cookie[0]! : cookie).split(';')[0]! };
  const project = createProject(owner.owner_id, 'https://github.com/example/recovery', 'recovery', 'free:deepseek-chat');
  project.analysis.snapshot_id = 'snapshot:recovery'; project.analysis.stage = 'done';
  project.study = { ...project.study, phase: 'explaining', snapshot_id: 'snapshot:recovery', route_revision: 0, current_step: 0, total_steps: 2,
    dynamic_learning_plan: [1, 2].map(i => ({ step_id: `step:${i}`, order: i, title: `Step ${i}`, objective: 'Input',
      evidence_refs: [], component_ids: [], completion_check: 'Input?' })) };
  await store.saveProject(project);
  await store.saveSnapshot(project.project_id, { snapshot_id: 'snapshot:recovery', summary: { file_count: 0, symbol_count: 0, call_count: 0, component_count: 0 },
    graph: { semantic_mode: 'provider_supported', nodes: [], edges: [], layers: [], unassigned_component_ids: [] }, languages: [], value_points: [],
    learning_plan: { snapshot_id: 'snapshot:recovery', selected_value_point: null, steps: [] } } as EvidenceSnapshot);
  const runId = 'teaching-recovery-fixed-run-0001';
  const body = { content: '跳过这一步', run_id: runId };
  // Discard this first terminal response: the browser did not receive it.
  const first = await app.inject({ method: 'POST', url: `/api/projects/${project.project_id}/messages/stream`, headers, payload: body });
  assert.equal(first.statusCode, 200); assert.match(first.body, /event: result/);
  const resultFrame = (wire: string) => JSON.parse(wire.match(/event: result\r?\ndata: (.+)/)![1]!);
  const original = resultFrame(first.body);
  const restored = await app.inject({ method: 'GET', url: `/api/projects/${project.project_id}/runs/${runId}/stream?after=0`, headers });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(resultFrame(restored.body), original);
  // A retried POST before the client saw connected also joins the same run.
  const retried = await app.inject({ method: 'POST', url: `/api/projects/${project.project_id}/messages/stream`, headers, payload: body });
  assert.deepEqual(resultFrame(retried.body), original);
  const saved = (await store.loadProject(project.project_id, owner.owner_id))!;
  assert.equal(runtimeCalls, 1);
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(saved.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(saved.study.current_step, 0);
  assert.deepEqual(saved.study.skipped_steps, []);
  assert.equal(saved.messages.at(-1)!.learning_action!.status, 'pending');
  assert.equal(saved.messages.at(-1)!.learning_action!.execution_policy, 'confirm');
  assert.deepEqual(saved.study.mastered, []);
  const pending = saved.messages.at(-1)!;
  const actionId = pending.learning_action!.action_id;
  const confirmed = await app.inject({ method: 'POST', url: `/api/projects/${project.project_id}/learning-actions/${actionId}`, headers, payload: { decision: 'confirm' } });
  assert.equal(confirmed.statusCode, 200);
  const committed = (await store.loadProject(project.project_id, owner.owner_id))!;
  assert.equal(committed.study.current_step, 1);
  assert.deepEqual(committed.study.skipped_steps, ['step:1']);
  assert.deepEqual(committed.study.mastered, []);
  assert.equal(committed.messages.at(-1)!.learning_action!.status, 'executed');
  const duplicate = await app.inject({ method: 'POST', url: `/api/projects/${project.project_id}/learning-actions/${actionId}`, headers, payload: { decision: 'confirm' } });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().state_changed, false);
  const replay = await app.inject({ method: 'POST', url: `/api/projects/${project.project_id}/messages/stream`, headers,
    payload: { content: body.content, replace_message_id: committed.messages[0]!.message_id, run_id: 'teaching-recovery-replay-0002' } });
  assert.equal(replay.statusCode, 200);
  assert.equal(runtimeCalls, 1);
  const replayed = (await store.loadProject(project.project_id, owner.owner_id))!;
  assert.deepEqual(replayed.study, committed.study);
  assert.equal(replayed.messages.length, committed.messages.length);
  assert.equal(replayed.messages.at(-1)!.content_parts!.body, pending.content_parts!.body);
  assert.deepEqual(replayed.messages.at(-1)!.content_parts!.evidence_blocks, pending.content_parts!.evidence_blocks);
  assert.deepEqual(replayed.messages.at(-1)!.evidence_review, pending.evidence_review);
});
