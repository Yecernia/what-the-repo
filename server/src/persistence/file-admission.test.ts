import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { KeyedMutex } from '../agent/mutex.js';

const limits = { running: 2, ownerRunning: 2, ownerWaiting: 1, waiting: 1 };
test('FileStore rejects full admission before persisting projects or shared memberships', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-local-admission-'));
  const store = new FileStore(root, undefined, undefined, limits);
  try {
    await store.init();
    const owner = 'guest:admission'; await store.saveUser(owner, { kind: 'guest' });
    const first = createProject(owner, 'https://github.com/example/first', 'first');
    await store.createProjectWithJob(first, newAnalysisJob(first.project_id, 'first'));
    for (const kind of ['standalone', 'repository', 'overlay']) {
      const project = createProject(owner, 'https://github.com/example/' + kind, kind);
      const job = newAnalysisJob(project.project_id, kind);
      const request = kind === 'standalone' ? () => store.createProjectWithJob(project, job)
        : kind === 'repository' ? () => store.createOrJoinRepositoryUpdate({ project, job, newProject: true,
          identity: { repository: 'example/rejected', analyzerBundleVersion: 'test', analysisConfigDigest: 'test' } })
          : () => store.createOrJoinSnapshotLanguageOverlay({ project, job, newProject: true, publicKey: 'f'.repeat(64), language: 'en' });
      await assert.rejects(request(), { code: 'analysis_owner_queue_full' });
      assert.equal(await store.loadProject(project.project_id), null);
      assert.equal(await store.loadRepositoryUpdateForProject(project.project_id), null);
      assert.equal(await store.loadJob(job.job_id), null);
    }
    assert.equal((await store.listJobs()).length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('FileStore skips a fenced writer without deadlocking admission or stealing its lease', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-local-lease-lock-'));
  const store = new FileStore(root, undefined, undefined, { ...limits, waiting: 4, ownerWaiting: 4 });
  let release = () => {};
  try {
    await store.init();
    const owner = 'guest:lease-lock'; await store.saveUser(owner, { kind: 'guest' });
    const jobs = [];
    for (let i = 0; i < 2; i++) {
      const project = createProject(owner, 'https://github.com/example/lock-' + i, 'lock');
      const job = newAnalysisJob(project.project_id, 'lock:' + i);
      job.created_at = new Date(i).toISOString();
      await store.createProjectWithJob(project, job); jobs.push(job);
    }
    const claimed = await store.claimAnalysisJob('old-worker', 30);
    assert.equal(claimed?.job_id, jobs[0]!.job_id);
    const internals = store as unknown as { mutex: KeyedMutex; analysisLeaseKey(jobId: string): string };
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const holder = internals.mutex.runExclusive(internals.analysisLeaseKey(claimed!.job_id), async () => { entered(); await blocked; });
    await ready;
    await store.saveJob({ ...claimed!, lease_expires_at: new Date(0).toISOString() });
    assert.equal((await store.claimAnalysisJob('other-worker', 30))?.job_id, jobs[1]!.job_id);
    assert.equal((await store.loadJob(claimed!.job_id))?.lease_owner, 'old-worker');
    release(); await holder;
    const resumed = await store.claimAnalysisJob('new-worker', 30);
    assert.equal(resumed?.job_id, jobs[0]!.job_id);
    assert.equal(resumed?.attempt, 2);
  } finally { release(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
