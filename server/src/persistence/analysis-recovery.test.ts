import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { PostgresStore } from './postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { AnalysisCoordinator } from '../analysis/coordinator.js';
import type { ServerConfig } from '../config.js';
import { PostgresPiSessionBackend } from './postgres-session-backend.js';

for (const backend of ['file', 'postgres'] as const) {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
  test(`${backend}: exhausted shared analysis fails every participant without another model attempt`,
    { skip: backend === 'postgres' && !url, timeout: 10_000 }, async () => {
    if (backend === 'postgres') assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const root = await mkdtemp(join(tmpdir(), 'wtr-analysis-recovery-'));
    const store = backend === 'file' ? new FileStore(root) : new PostgresStore({ root, databaseUrl: url!,
      migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'recovery-test-only-secret', poolMax: 1 });
    try {
      await store.init();
      const owner = 'guest:recovery-' + backend;
      await store.saveUser(owner, { kind: 'guest' });
      const a = createProject(owner, 'https://github.com/example/recovery', 'first');
      const b = createProject(owner, 'https://github.com/example/recovery', 'second');
      const identity = { repository: 'example/recovery-' + backend, analyzerBundleVersion: 'test', analysisConfigDigest: 'test' };
      const leader = await store.createOrJoinRepositoryUpdate({ project: a, job: newAnalysisJob(a.project_id, 'leader', 1), identity, targetCommitSha: 'abc', newProject: true });
      const waiter = await store.createOrJoinRepositoryUpdate({ project: b, job: newAnalysisJob(b.project_id, 'waiter', 1), identity, targetCommitSha: 'abc', newProject: true });
      const claimed = await store.claimAnalysisJob('crashed-worker', 30);
      assert.equal(claimed?.job_id, leader.job.job_id);
      await store.saveJob({ ...claimed!, lease_expires_at: new Date(Date.now() - 1000).toISOString() });
      let modelCalls = 0;
      const config = { root, dataDir: root, nodeEnv: 'test', analysisQueueConcurrency: 1 } as ServerConfig;
      const coordinator = new AnalysisCoordinator(store, config, () => ({ acquire: async () => {
        modelCalls++; throw new Error('recovery must not call a model');
      } }));
      await coordinator.runOnce();
      await coordinator.stop();
      assert.equal(modelCalls, 0);
      for (const job of [leader.job, waiter.job]) {
        assert.equal((await store.loadJob(job.job_id))?.status, 'failed');
        assert.equal((await store.latestJob(job.project_id))?.scheduling_state, 'completed');
        assert.equal((await store.loadProject(job.project_id))?.analysis.stage, 'failed');
      }
      assert.equal((await store.loadJob(leader.job.job_id))?.attempt, 1, 'cleanup is not another model attempt');
      assert.equal((await store.loadRepositoryUpdateForProject(a.project_id))?.status, 'failed');
      assert.equal(await store.claimAnalysisJob('idle-worker', 30), null);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('PostgreSQL expired session leases reject stale writes while a new holder can write',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 10_000 }, async () => {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-session-fence-'));
  const store = new PostgresStore({ root, databaseUrl: url, migrationsRoot: join(process.cwd(), 'migrations'),
    encryptionSecret: 'session-fence-test-only', poolMax: 1 });
  try {
    await store.init();
    const owner = 'guest:session-fence';
    await store.saveUser(owner, { kind: 'guest' });
    const project = createProject(owner, 'https://github.com/example/session-fence', 'session');
    await store.saveProject(project);
    const identity = { sessionId: 'session-fence', ownerId: owner, projectId: project.project_id,
      snapshotId: null, skillId: 'primary-supervisor', skillVersion: 'test' };
    const backend = new PostgresPiSessionBackend(store.pool);
    await backend.withSession(identity, async old => {
      await old.setName('before expiry');
      await assert.rejects(backend.withSession(identity, async () => {}), { code: 'session_busy' });
      await store.pool.query("UPDATE runtime_permits SET payload=jsonb_set(payload,'{expires}',to_jsonb(0::bigint)) WHERE namespace='session'");
      await backend.withSession(identity, async current => {
        await current.setName('new holder');
        await assert.rejects(old.setName('stale overwrite'), /pi_session_lease_lost/);
        assert.equal(await current.getName(), 'new holder');
        assert.equal(store.pool.idleCount, 1);
      });
    });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
