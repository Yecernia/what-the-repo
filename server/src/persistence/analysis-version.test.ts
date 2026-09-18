import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { PostgresStore } from './postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';

for (const backend of ['file', 'postgres'] as const) {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
  test(`${backend}: sharing matches commits and publication preserves a queued newer version`,
    { skip: backend === 'postgres' && !url, timeout: 15_000 }, async () => {
    if (backend === 'postgres') assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const root = await mkdtemp(join(tmpdir(), 'wtr-versions-'));
    const limits = { running: 2, ownerRunning: 2, ownerWaiting: 8, waiting: 16 };
    const store = backend === 'file' ? new FileStore(root, undefined, undefined, limits) : new PostgresStore({
      root, databaseUrl: url!, migrationsRoot: join(process.cwd(), 'migrations'),
      encryptionSecret: 'versions-test-only', poolMax: 1, analysisLimits: limits });
    try {
      await store.init();
      const owner = 'guest:versions-' + backend;
      await store.saveUser(owner, { kind: 'guest' });
      const identity = { repository: 'example/versions-' + backend, analyzerBundleVersion: 'test', analysisConfigDigest: 'test' };
      const oldKey = 'd'.repeat(64), newKey = 'e'.repeat(64);
      for (const [publicKey, commitSha, snapshotId] of [[oldKey, '0'.repeat(40), 'snap:old'], [newKey, 'a'.repeat(40), 'snap:new']]) {
        await mkdir(store.publicSourceSnapshotRoot(publicKey!, snapshotId!), { recursive: true });
        await store.savePublicSnapshot({ publicKey: publicKey!, repository: identity.repository, commitSha: commitSha!, snapshotId: snapshotId!,
          analyzerBundleVersion: identity.analyzerBundleVersion, analysisConfigDigest: identity.analysisConfigDigest,
          view: snapshotView(snapshotId!), analysis: { snapshot_id: snapshotId, fact_graph: { nodes: [], edges: [] } } });
      }
      const projects = ['old-version', 'same-version', 'new-version', 'other-repo'].map(title =>
        createProject(owner, 'https://github.com/' + identity.repository, title));
      projects[2]!.analysis.canonical_snapshot_key = oldKey;
      projects[2]!.analysis.snapshot_id = 'snap:old';
      const queued = [];
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i]!;
        const job = newAnalysisJob(project.project_id, 'versions:' + i);
        job.created_at = new Date(Date.now() - 10_000 + i * 1000).toISOString();
        queued.push(await store.createOrJoinRepositoryUpdate({ project, job,
          identity: i === 3 ? { ...identity, repository: 'example/unrelated-' + backend } : identity,
          targetCommitSha: (i === 2 ? 'b' : 'a').repeat(40), newProject: true }));
      }
      assert.equal(queued[0]!.update.update_id, queued[1]!.update.update_id);
      assert.notEqual(queued[0]!.update.update_id, queued[2]!.update.update_id);
      assert.equal((await store.claimAnalysisJob('worker:old', 30))?.job_id, queued[0]!.job.job_id);
      const unrelated = await store.claimAnalysisJob('worker:unrelated', 30);
      assert.equal(unrelated?.job_id, queued[3]!.job.job_id);
      await store.failRepositoryUpdate(queued[3]!.update.update_id, 'test complete');
      assert.equal(await store.claimAnalysisJob('worker:new-too-early', 30), null, 'same lineage does not overtake the old publication');
      await store.publishRepositoryUpdate({ updateId: queued[0]!.update.update_id, publicKey: newKey,
        commitSha: 'a'.repeat(40), snapshotId: 'snap:new', fileCount: 0, symbolCount: 0, callCount: 0,
        languages: [], readyLanguage: 'zh-CN', completedAt: new Date().toISOString(), redirects: [] });
      assert.equal((await store.loadJob(queued[1]!.job.job_id))?.status, 'succeeded');
      assert.equal((await store.loadJob(queued[2]!.job.job_id))?.status, 'queued');
      assert.equal((await store.loadProject(projects[2]!.project_id))?.analysis.snapshot_id, 'snap:old');
      assert.equal((await store.claimAnalysisJob('worker:new', 30))?.job_id, queued[2]!.job.job_id);
      await store.failRepositoryUpdate(queued[2]!.update.update_id, 'test complete');
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

function snapshotView(snapshotId: string) {
  return { snapshot_id: snapshotId,
    summary: { file_count: 0, symbol_count: 0, call_count: 0 },
    graph: { semantic_mode: 'static', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
    value_points: [], languages: [],
    learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] } };
}
