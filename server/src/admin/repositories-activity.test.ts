import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from '../persistence/postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob, type JobStatus } from '../domain/jobs.js';
import { loadConfig } from '../config.js';
import { AdminRepositories, executionStage } from './repositories.js';

test('admin execution stage cannot be replaced by stale project lifecycle', () => {
  for (const status of ['queued', 'succeeded', 'failed', 'cancelled'])
    assert.equal(executionStage(status, 'interpreting'), status);
  for (const stage of ['queued', 'idle', 'done', 'failed', null, undefined])
    assert.equal(executionStage('running', stage), 'running');
  assert.equal(executionStage('running', 'interpreting'), 'interpreting');
});
const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('admin repository activity follows the current executor, not queued batch metadata', { skip: !url, timeout: 60000 }, async t => {
  assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-admin-activity-'));
  const store = new PostgresStore({ root, databaseUrl: url!, migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'isolated-activity-secret'.repeat(2) });
  const admin = new AdminRepositories(store, { ...loadConfig({}), dataDir: root });
  const stamp = '2026-01-01T00:00:00Z', later = '2026-01-01T01:00:00Z';
  let initialized = false;
  try {
    await store.init(); initialized = true;
    await store.saveUser('github:activity-test', { login: 'activity-tester' });
    const makeCase = async (name: string, batchStatus: string, jobStatus: JobStatus, stage = 'interpreting') => {
      const project = createProject('github:activity-test', 'https://github.com/activity-case/' + name, name);
      project.analysis.stage = stage as typeof project.analysis.stage;
      await store.saveProject(project);
      const batch = 'activity-batch-' + name;
      await store.pool.query(`INSERT INTO repository_analysis_updates(update_id,repository_identity,analyzer_bundle_version,analysis_config_digest,status,leader_project_id,created_at,updated_at,completed_at)
        VALUES($1,$2,'test','test',$3,$4,$5,$5,$6)`, [batch, 'activity-case/' + name, batchStatus, project.project_id, stamp, ['succeeded','failed','cancelled'].includes(batchStatus) ? stamp : null]);
      await store.pool.query('INSERT INTO repository_analysis_update_projects(update_id,project_id,created_at) VALUES($1,$2,$3)', [batch, project.project_id, stamp]);
      const job = { ...newAnalysisJob(project.project_id, 'activity:' + name), status: jobStatus, repository_update_id: batch, execution_role: 'leader' as const,
        updated_at: later, completed_at: ['succeeded','failed','cancelled'].includes(jobStatus) ? later : null };
      await store.saveJob(job);
      return { project, batch, job };
    };
    const find = async (name: string) => (await admin.activity(1)).repositories.find(r => r.repository_identity === 'activity-case/' + name)!;
    const running = await makeCase('running', 'queued', 'running');
    await makeCase('requeued', 'running', 'queued');
    await makeCase('terminal', 'succeeded', 'running', 'fetching');
    await makeCase('failed', 'queued', 'failed');
    await t.test('running leader wins over queued batch and a newer waiter', async () => {
      await store.saveJob({ ...newAnalysisJob(running.project.project_id, 'activity:waiter'), repository_update_id: running.batch, execution_role: 'waiter', status: 'queued' });
      const row = await find('running');
      assert.equal(row.status, 'running'); assert.equal(row.stage, 'interpreting');
      assert.equal(new Date(row.updated_at).toISOString(), later.replace('Z', '.000Z'));
      assert.equal(row.user_count, 1);
    });
    await t.test('a requeued job is not shown as running because old progress remains', async () => {
      const row = await find('requeued'); assert.equal(row.status, 'queued'); assert.equal(row.stage, 'queued');
    });
    await t.test('terminal batch state and timestamp survive newer mutable project/job records', async () => {
      const row = await find('terminal'); assert.equal(row.status, 'succeeded'); assert.equal(row.stage, 'succeeded');
      assert.equal(new Date(row.updated_at).toISOString(), stamp.replace('Z', '.000Z'));
      assert.equal((await find('failed')).status, 'failed');
    });
    await t.test('a promoted leader is selected, never a previous project or overlay executor', async () => {
      const promoted = await makeCase('promoted', 'queued', 'running');
      const next = createProject('github:activity-test', 'https://github.com/activity-case/promoted', 'new leader');
      next.analysis.stage = 'scanning'; await store.saveProject(next);
      await store.pool.query('UPDATE repository_analysis_updates SET leader_project_id=$2 WHERE update_id=$1', [promoted.batch, next.project_id]);
      await store.saveJob({ ...newAnalysisJob(next.project_id, 'activity:next'), status: 'queued', repository_update_id: promoted.batch, execution_role: 'leader' });
      await store.saveJob({ ...newAnalysisJob(next.project_id, 'activity:overlay'), status: 'running', repository_update_id: promoted.batch, execution_role: 'overlay' });
      assert.equal((await find('promoted')).status, 'queued');
    });
    await t.test('legacy independent jobs still use execution state and ignore stale project completion', async () => {
      const p = createProject('github:activity-test', 'https://github.com/activity-case/legacy', 'legacy');
      p.analysis.stage = 'done'; await store.saveProject(p);
      await store.saveJob({ ...newAnalysisJob(p.project_id, 'activity:legacy'), status: 'running' });
      const row = await find('legacy'); assert.equal(row.status, 'running'); assert.equal(row.stage, 'running');
    });
    await t.test('effective running state is used before ordering and pagination', async () => {
      for (let i = 0; i < 26; i++) await makeCase('finished-' + i, 'succeeded', 'succeeded');
      const first = await admin.activity(1), second = await admin.activity(2);
      assert.equal(first.repositories.length, 25); assert.ok(second.repositories.length > 0);
      assert.ok(first.repositories.some(r => r.repository_identity === 'activity-case/running'));
      assert.equal(first.repositories[0].status, 'running');
    });
  } finally {
    try {
      if (initialized) {
        // Remove only this suite's fixtures, so later destructive-guard tests see no active job.
        await store.pool.query("DELETE FROM analysis_jobs WHERE idempotency_key LIKE 'activity:%'");
        await store.pool.query("DELETE FROM repository_analysis_updates WHERE update_id LIKE 'activity-batch-%'");
        await store.pool.query("DELETE FROM projects WHERE owner_id='github:activity-test'");
        await store.pool.query("DELETE FROM app_users WHERE owner_id='github:activity-test'");
      }
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});
