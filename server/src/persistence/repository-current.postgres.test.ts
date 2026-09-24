import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from './postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;

test('isolated PostgreSQL: one current version, bounded old reads, leased cleanup and background admission',
  { skip: !url, timeout: 30_000 }, async () => {
    assert.match(new URL(url!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const root = await mkdtemp(join(tmpdir(), 'wtr-repository-current-'));
    const store = new PostgresStore({ root, databaseUrl: url!, migrationsRoot: join(process.cwd(), 'migrations'),
      encryptionSecret: 'repository-current-test-only', poolMax: 4 });
    try {
      await store.init();
      const owner = 'guest:repository-current';
      await store.saveUser(owner, { kind: 'guest' });
      const repository = 'example/current';
      const identity = { repository, analyzerBundleVersion: 'test', analysisConfigDigest: 'test' };
      const oldKey = '1'.repeat(64), newKey = '2'.repeat(64);
      for (const [publicKey, commitSha, snapshotId] of [[oldKey, '0'.repeat(40), 'snap:old'], [newKey, 'a'.repeat(40), 'snap:new']] as const) {
        const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(join(sourceRoot, 'a.ts'), `export const version = '${snapshotId}';\n`);
        await store.savePublicSnapshot({ publicKey, repository, commitSha, snapshotId,
          analyzerBundleVersion: 'test', analysisConfigDigest: 'test', view: view(snapshotId),
          analysis: { snapshot_id: snapshotId, fact_graph: { nodes: [], edges: [] } } });
      }
      const reader = createProject(owner, `https://github.com/${repository}`, 'reader');
      reader.analysis.stage = 'done';
      reader.analysis.canonical_snapshot_key = oldKey;
      reader.analysis.snapshot_id = 'snap:old';
      await store.saveProject(reader);
      const requester = createProject(owner, `https://github.com/${repository}`, 'requester');
      const job = newAnalysisJob(requester.project_id, 'current:update');
      const queued = await store.createOrJoinRepositoryUpdate({ project: requester, job, identity,
        targetCommitSha: 'a'.repeat(40), newProject: true });
      assert.equal((await store.claimAnalysisJob('worker:current', 30))?.job_id, job.job_id);
      const publishedAt = new Date().toISOString();
      await store.publishRepositoryUpdate({ updateId: queued.update.update_id, publicKey: newKey, commitSha: 'a'.repeat(40),
        snapshotId: 'snap:new', fileCount: 1, symbolCount: 0, callCount: 0, languages: [], readyLanguage: 'zh-CN',
        completedAt: publishedAt, redirects: [], snapshotGraceHours: 2 });

      // Every project of the repository follows the single current pointer.
      const head = await store.loadCurrentRepositoryHead(repository);
      assert.equal(head?.current_public_snapshot_key, newKey);
      assert.equal(head?.generation, 1);
      assert.equal((await store.loadProject(reader.project_id))?.analysis.snapshot_id, 'snap:new');
      const retired = await store.loadPublicSnapshotMetadata(oldKey);
      assert.equal(Date.parse(retired!.purge_after!) - Date.parse(retired!.retired_at!), 2 * 3600_000);

      // A request pinned to the retired version still reads it.
      assert.equal(await store.historicalPublicKey(reader.project_id, 'snap:old'), oldKey);
      assert.equal(await store.historicalPublicKey(reader.project_id, 'snap:new'), null);
      assert.deepEqual((await store.readSourceLines(reader.project_id, 'snap:old', 'a.ts', 1, 1)).lines,
        ["export const version = 'snap:old';"]);
      await assert.rejects(store.readSourceLines(reader.project_id, 'snap:missing', 'a.ts', 1, 1), /snapshot_not_bound/);
      assert.deepEqual(await store.listSourceFiles(reader.project_id, 'snap:old'), ['a.ts'], 'citation checks list the pinned version');

      // Cleanup waits for the grace period and for every in-flight read.
      const lease = await store.acquireSnapshotReadLease(oldKey, 30);
      assert.ok(lease);
      const later = new Date(Date.now() + 3 * 3600_000).toISOString();
      assert.deepEqual((await store.listPurgeablePublicSnapshots(new Date().toISOString())).map(row => row.public_snapshot_key), []);
      assert.equal(await store.purgePublicSnapshotPayload(oldKey, later), false);
      await store.releaseSnapshotReadLease(lease!);
      assert.deepEqual((await store.listPurgeablePublicSnapshots(later)).map(row => row.public_snapshot_key), [oldKey]);
      assert.equal(await store.purgePublicSnapshotPayload(oldKey, later), true);
      assert.equal(await store.acquireSnapshotReadLease(oldKey, 30), null, 'a purged version admits no new reads');
      assert.equal(await store.historicalPublicKey(reader.project_id, 'snap:old'), null);
      assert.equal(await store.purgePublicSnapshotPayload(newKey, later), false, 'the current version is never cleaned');

      // Background admission needs recent real use and reserves one start.
      const background = { project: reader, identity, targetCommitSha: 'c'.repeat(40), dailyUsd: 10, updateMaxUsd: 4,
        maxStartsPerDay: 2, maxActive: 1, maxQueued: 4, minUpdateIntervalHours: 24, activeWindowDays: 7 };
      const now = new Date().toISOString();
      assert.equal(await store.createBackgroundRepositoryUpdate({ ...background,
        job: newAnalysisJob(reader.project_id, 'background:idle'), now }), 'deferred', 'an unused repository is not refreshed');
      await store.touchRepositoryRealUse(repository, now, 15);
      assert.equal(await store.createBackgroundRepositoryUpdate({ ...background,
        job: newAnalysisJob(reader.project_id, 'background:first'), now }), 'queued');
      const active = await store.loadActiveRepositoryUpdate(repository);
      assert.equal(active?.trigger, 'background');
      assert.equal(await store.createBackgroundRepositoryUpdate({ ...background,
        job: newAnalysisJob(reader.project_id, 'background:second'), now }), 'deferred', 'one active update per repository');
      const usage = await store.pool.query('SELECT starts, reserved_usd::float AS reserved FROM repository_background_daily_usage');
      assert.deepEqual(usage.rows, [{ starts: 1, reserved: 4 }]);
      // A user request joins the running background update instead of queueing another version.
      const joiner = createProject(owner, `https://github.com/${repository}`, 'joiner');
      const joined = await store.createOrJoinRepositoryUpdate({ project: joiner, job: newAnalysisJob(joiner.project_id, 'current:join'),
        identity, targetCommitSha: 'd'.repeat(40), newProject: true });
      assert.equal(joined.update.update_id, active?.update_id);
      assert.equal(joined.update.target_commit_sha, 'c'.repeat(40));
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });

function view(snapshotId: string) {
  return { snapshot_id: snapshotId,
    summary: { file_count: 1, symbol_count: 0, call_count: 0 },
    graph: { semantic_mode: 'static', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
    value_points: [], languages: [],
    learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] } };
}
