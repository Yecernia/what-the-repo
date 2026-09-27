import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { createMessage, createProject } from "../domain/conversation.js";
import { FileStore } from "../persistence/file-store.js";
import { applyMemoryOutput, MemoryMaintenance } from "./memory-maintenance.js";
import { changeLearner, invalidateMemory, readLearner } from '../services/learner-context.js';
import { PiMemoryStore } from "./memory-store.js";

test("memory maintenance keeps sourced learning facts and rejects secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-memory-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const memories = new PiMemoryStore(join(root, "pi-memory"));
    const project = createProject(
      "github:1",
      "https://github.com/example/repo",
      "repo",
      "free:deepseek-v4-flash",
    );
    const user = createMessage("user", "我主要写 Go，希望先理解调用链。");
    project.messages.push(user);
    await store.saveProject(project);
    const applied = await applyMemoryOutput({
      ownerId: project.owner_id,
      project,
      store,
      memories,
      output: {
        memories: [{
          key: "preferred-language",
          value: "用户主要使用 Go。",
          confidence: 0.9,
          source_message_id: user.message_id,
          evidence: "我主要写 Go",
        }, {
          key: "api-key",
          value: "secret-value",
          confidence: 1,
          source_message_id: user.message_id,
          evidence: "我主要写 Go",
        }],
        profile_claims: [{
          claim: "更适合从调用链开始学习。",
          confidence: 0.85,
          source_message_id: user.message_id,
          evidence: "希望先理解调用链",
        }],
      },
    });
    assert.deepEqual(applied, { memories: 1, profileClaims: 1 });
    assert.equal((await memories.list(project.owner_id)).length, 1);
    const profile = await store.loadProfile(project.owner_id);
    assert.equal(profile.inferred.length, 1);
    assert.equal(profile.last_inferred_message_id, user.message_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-memory-durable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root); await store.init();
  const memories = new PiMemoryStore(join(root, 'memory'));
  const project = createProject('guest:memory', 'https://github.com/example/repo', 'repo');
  const worker = new MemoryMaintenance(store, memories);
  return { root, store, memories, project, worker };
}

function model(response: FauxResponseFactory) {
  const faux = fauxProvider({ provider: 'memory-regression', tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => response));
  return { models, model: faux.getModel() };
}

test('durable extraction catches up every message, survives restart and keeps a per-project cursor', async t => {
  const { store, memories, project, worker, root } = await fixture(t);
  project.messages = Array.from({ length: 7 }, (_, i) => createMessage('user', '长期偏好' + i + (i === 0 ? '背景'.repeat(3000) + '尾部要求' : '')));
  await store.saveProject(project);
  await worker.queue.enqueue(project.owner_id, project.project_id, 0);
  const seen: string[] = [];
  const runtime = model(context => {
    const content = context.messages.find(row => row.role === 'user')!.content;
    const text = typeof content === 'string' ? content : content.filter(row => row.type === 'text').map(row => row.text).join('');
    const input = JSON.parse(text);
    for (const row of input.recent_messages) seen.push(row.content);
    return fauxAssistantMessage(fauxToolCall('submit_result', { memories: [], profile_claims: [] }));
  });
  const restarted = new MemoryMaintenance(store, memories);
  await restarted.runPending(runtime);
  assert.deepEqual(seen, project.messages.map(row => row.content), 'no last-ten-message window or per-message truncation');
  const other = createProject(project.owner_id, 'https://github.com/example/other', 'other');
  other.messages = [createMessage('user', '另一个项目的偏好')]; await store.saveProject(other);
  await restarted.queue.enqueue(other.owner_id, other.project_id, 0); await restarted.runPending(runtime);
  await restarted.queue.enqueue(project.owner_id, project.project_id, 0); await restarted.runPending(runtime);
  assert.equal(seen.length, 8, 'returning to A after B must not call the model again');
  const rows = JSON.parse(await readFile(join(root, 'memory-work.json'), 'utf8'));
  assert.ok(rows.every((row: { requested: number; completed: number }) => row.requested === row.completed));
});

test('clearing or pausing while extraction is in flight fences the result and replay', async t => {
  for (const pause of [false, true]) {
    const { store, memories, project, worker } = await fixture(t);
    const user = createMessage('user', '我长期使用 Go');
    user.created_at = '2026-01-01T00:00:00.000Z';
    project.messages = [user]; await store.saveProject(project);
    await worker.queue.enqueue(project.owner_id, project.project_id, 0);
    await worker.runPending(model(async () => {
      await changeLearner(store, memories, project.owner_id, state => {
        state.profile.enabled = !pause;
        state.profile.goals = ['手动修改必须保留'];
        state.memories = []; state.clearMemories = true;
        invalidateMemory(state.profile, true);
      });
      return fauxAssistantMessage(fauxToolCall('submit_result', { memories: [{ key: 'language', value: 'Go', confidence: 1,
        source_message_id: user.message_id, evidence: '长期使用 Go' }], profile_claims: [] }));
    }));
    assert.deepEqual(await memories.list(project.owner_id), []);
    assert.deepEqual((await store.loadProfile(project.owner_id)).goals, ['手动修改必须保留']);
    assert.equal(await worker.queue.claim(), null, 'ignored work is drained without re-learning forgotten history');
  }
});

test('retractions prevent older projects from resurrecting facts and sensitive claims never persist', async t => {
  const { store, memories, project } = await fixture(t);
  const old = createMessage('user', '长期使用 Go'), recent = createMessage('user', '不再使用 Go');
  old.created_at = '2026-01-01T00:00:00.000Z'; recent.created_at = '2026-01-02T00:00:00.000Z';
  const output = { memories: [{ key: 'language', value: 'Go', confidence: 1, source_message_id: old.message_id, evidence: old.content }], profile_claims: [] };
  project.messages = [old, recent]; await store.saveProject(project);
  const base = { store, memories, project, ownerId: project.owner_id };
  await applyMemoryOutput({ ...base, output });
  await applyMemoryOutput({ ...base, output: { memories: [], profile_claims: [], retractions: [{ kind: 'memory', key: 'language', source_message_id: recent.message_id, evidence: recent.content }] } });
  await applyMemoryOutput({ ...base, output });
  assert.deepEqual(await memories.list(project.owner_id), []);
  await applyMemoryOutput({ ...base, output: { memories: [], profile_claims: [{ claim: 'sk-test-sensitive1234', confidence: 1, source_message_id: old.message_id, evidence: old.content }] } });
  assert.deepEqual((await store.loadProfile(project.owner_id)).inferred, []);
  await changeLearner(store, memories, project.owner_id, state => { state.profile.memory_summary_mode = 'edited'; state.profile.memory_summary = '请优先讲 Rust'; });
  await applyMemoryOutput({ ...base, output });
  assert.equal((await readLearner(store, memories, project.owner_id)).profile.memory_summary, '请优先讲 Rust');
  assert.deepEqual(await memories.list(project.owner_id), []);
});

test('failed extraction leaves a durable retry with no cursor advance', async t => {
  const { root, store, memories, project, worker } = await fixture(t);
  project.messages = [createMessage('user', '长期偏好')]; await store.saveProject(project);
  await worker.queue.enqueue(project.owner_id, project.project_id, 0);
  await new MemoryMaintenance(store, memories, async () => { throw new Error('provider offline'); }).runPending();
  const [row] = JSON.parse(await readFile(join(root, 'memory-work.json'), 'utf8'));
  assert.equal(row.attempts, 1); assert.equal(row.completed, 0); assert.deepEqual(row.processed, {});
  assert.equal(row.lastError, 'memory_extraction_failed'); assert.ok(row.availableAt > Date.now());
});
