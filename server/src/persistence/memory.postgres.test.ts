import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';
import { PostgresMemoryStore } from './postgres-memory-store.js';
import { MemoryWorkQueue } from './memory-work.js';
import { createMessage, createProject } from '../domain/conversation.js';
import { applyMemoryOutput, memoryMessageRevision } from '../agent/memory-maintenance.js';
import { changeLearner, invalidateMemory } from '../services/learner-context.js';

const databaseUrl = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('memory transactions fence workers, preserve concurrent edits, and migrate guest facts atomically', { skip: !databaseUrl, timeout: 30_000 }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-memory-pg-'));
  const options = { root, databaseUrl: url.toString(), migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'isolated-memory-test' };
  const store = new PostgresStore(options), second = new PostgresStore(options);
  const source = 'guest:' + randomUUID(), target = 'github:' + randomUUID();
  try {
    await store.init(); await second.init();
    for (const owner of [source, target]) await store.saveUser(owner, { kind: owner === source ? 'guest' : 'github' });
    const memories = new PostgresMemoryStore(store.pool), queue = new MemoryWorkQueue(root, store.pool);
    const project = createProject(source, 'https://github.com/example/memory', 'memory');
    const user = createMessage('user', '我长期使用 Go'); project.messages.push(user); await store.saveProject(project);
    assert.equal((await store.pool.query('SELECT 1 FROM memory_work WHERE project_id=$1', [project.project_id])).rowCount, 1,
      'saving the user message also persists extraction work, without calling schedule');
    const output = { memories: [{ key: 'language', value: 'Go', confidence: 1, source_message_id: user.message_id, evidence: '长期使用 Go' }], profile_claims: [] };
    await queue.enqueue(source, project.project_id, 0);
    const lease = (await queue.claim())!;
    assert.equal(await new MemoryWorkQueue(root, second.pool).claim(), null, 'two replicas cannot claim the same job');
    const work = { queue, lease, processed: { [user.message_id]: memoryMessageRevision(user) }, complete: true };
    // A worker that lost its lease must roll back both the profile and memory rows.
    await store.pool.query("UPDATE memory_work SET lease_until=now()-interval '1 second' WHERE project_id=$1", [project.project_id]);
    await assert.rejects(applyMemoryOutput({ ownerId: source, project, output, store, memories, work }), /memory_lease_lost/);
    assert.deepEqual(await memories.list(source), []);
    assert.deepEqual((await store.loadProfile(source)).inferred, []);
    const reclaimed = (await queue.claim())!; assert.notEqual(reclaimed.leaseId, lease.leaseId);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const edit = changeLearner(store, memories, source, async state => {
      state.profile.goals = ['用户手动目标']; invalidateMemory(state.profile); entered(); await gate;
    });
    await inside;
    const worker = applyMemoryOutput({ ownerId: source, project, output, store: second, memories: new PostgresMemoryStore(second.pool), expectedRevision: 0,
      work: { ...work, lease: reclaimed } });
    release(); await edit; assert.deepEqual(await worker, { memories: 0, profileClaims: 0 });
    assert.deepEqual((await store.loadProfile(source)).goals, ['用户手动目标']);
    assert.deepEqual(await memories.list(source), []);
    const fresh = (await queue.claim())!;
    await applyMemoryOutput({ ownerId: source, project, output, store, memories, expectedRevision: 1, work: { ...work, lease: fresh } });
    assert.equal((await memories.list(source))[0].value, 'Go');
    assert.equal(await queue.claim(), null);
    const createdAt = (await memories.list(source))[0].createdAt;
    const sourceMemoryId = (await memories.list(source))[0].memoryId;
    await memories.upsert({ ...(await memories.list(source))[0], createdAt: '2099-01-01T00:00:00.000Z', value: 'Go and Rust' });
    assert.equal((await memories.list(source))[0].createdAt, createdAt);
    await queue.enqueue(source, project.project_id, 0);
    const staleOwnerLease = (await queue.claim())!;
    const concurrentMessage = createMessage('user', '我偏好从示例开始');
    const editDuringMerge = second.updateProject(project.project_id, source, row => { row.messages.push(concurrentMessage); });
    const summary = await store.mergeOwners({ sourceOwnerId: source, targetOwnerId: target });
    const editedProject = await editDuringMerge;
    if (editedProject) assert.ok((await store.loadProject(project.project_id, target))!.messages.some(row => row.message_id === concurrentMessage.message_id));
    assert.equal(summary.memories, 1);
    assert.equal(await store.loadUser(source), null);
    const transferred = await memories.list(target);
    assert.equal(transferred.length, 1); assert.equal(transferred[0].ownerId, target);
    assert.notEqual(transferred[0].memoryId, sourceMemoryId, 'the target account has its own stable ID');
    assert.equal(await queue.owns(staleOwnerLease), false);
    assert.equal((await queue.claim())!.ownerId, target);
    assert.ok((await store.loadProfile(target)).memory_revision! > 1);
  } finally {
    await store.pool.query('DELETE FROM app_users WHERE owner_id=ANY($1::text[])', [[source, target]]).catch(() => undefined);
    await Promise.all([store.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
