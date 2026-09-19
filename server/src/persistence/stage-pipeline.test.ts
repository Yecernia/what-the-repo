import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { PostgresStore } from './postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { loadConfig } from '../config.js';
import { executeStageProcess, isolatedStageExecutor } from '../analysis/stage-executor.js';
import { ResourceScheduler } from '../scheduling/resources.js';
import { PostgresPermitStore } from '../scheduling/permits.js';

test('isolated PostgreSQL: real subprocess stages retain personal quota, release memory, resume and publish without a provider',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 90_000 }, async () => {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-pipeline-pg-'));
  const source = 'export function answer() { return 42; }';
  const archive = zipSync({ 'repo-sha/src/main.ts': strToU8(source) });
  const gateway = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk);
    const request = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader('content-type', 'application/json');
    if (request.kind === 'archive') { res.end(archive); return; }
    res.end(JSON.stringify(request.kind === 'metadata' ? { default_branch: 'main' }
      : request.kind === 'commit' ? { sha: 'a'.repeat(40) }
      : request.kind === 'tree' ? { tree: [{ path: 'src/main.ts', type: 'blob', size: source.length }] } : {}));
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const config = loadConfig({ WHAT_THE_REPO_LOAD_LOCAL_ENV: '0', WHAT_THE_REPO_ROOT: resolve('..'),
    WHAT_THE_REPO_DATA_DIR: root, DATABASE_URL: url, WHAT_THE_REPO_KEY_ENCRYPTION_SECRET: 'isolated-stage-test-secret-32-chars',
    NODE_ENV: 'test' });
  // Direct fixture config avoids weakening production HTTPS validation.
  config.githubGatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  config.githubGatewaySharedSecret = 'test-only';
  const store = new PostgresStore({ root, databaseUrl: url, migrationsRoot: join(process.cwd(), 'migrations'),
    encryptionSecret: config.keyEncryptionSecret, poolMax: 1,
    analysisLimits: { running: 32, pending: 32, ownerRunning: 1, ownerWaiting: 4, waiting: 32 } });
  try {
    await store.init();
    await store.saveUser('guest:pipeline', { kind: 'guest' });
    const project = createProject('guest:pipeline', 'https://github.com/example/stages', 'Stages');
    await store.saveProject(project);
    await store.saveJob(newAnalysisJob(project.project_id, 'stage-one'));
    const job = (await store.claimAnalysisJob('pipeline-supervisor', 900))!;
    const other = createProject('guest:pipeline', 'https://github.com/example/other', 'Other');
    await store.saveProject(other); await store.saveJob(newAnalysisJob(other.project_id, 'stage-two'));
    assert.equal(await store.claimAnalysisJob('other-worker', 900), null);
    const signal = new AbortController().signal;
    assert.equal(await executeStageProcess(job, 'fetch', config, 768, signal), 'cpu');
    assert.equal((await store.analysisCheckpointInfo(project.project_id))?.stage, 'source');
    assert.equal(await store.claimAnalysisJob('other-worker', 900), null, 'phase handoff retains personal quota');
    assert.equal(await executeStageProcess(job, 'cpu', config, 1536, signal), 'semantic');
    const saved = await store.loadAnalysisCheckpoint(project.project_id);
    assert.ok(saved?.snapshot);
    assert.ok(Array.isArray(saved.checkpoint.parsed));
    // A deterministic completed semantic checkpoint exercises the real publication path.
    await store.saveAnalysisCheckpoint(project.project_id, { ...saved.checkpoint, stage: 'assembly', provenance_applied: true }, saved.snapshot);
    await isolatedStageExecutor(store, config).run(job, signal);
    assert.equal((await store.loadJob(job.job_id))?.status, 'succeeded');
    assert.equal(await store.analysisCheckpointInfo(project.project_id), null);
    assert.equal((await store.claimAnalysisJob('other-worker', 900))?.project_id, other.project_id);
    const permits = await store.pool.query('SELECT count(*)::int AS count FROM runtime_permits');
    assert.equal(permits.rows[0].count, 0, 'all stage/object resources are released');
  } finally { await store.close(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('isolated PostgreSQL: two resource clients cannot exceed shared memory or resurrect an expired execution',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 10_000 }, async () => {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-resource-pg-'));
  const store = new PostgresStore({ root, databaseUrl: url, migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'resource-test-only', poolMax: 1 });
  try {
    await store.init();
    const first = new ResourceScheduler(new PostgresPermitStore(store.pool));
    const second = new ResourceScheduler(new PostgresPermitStore(store.pool));
    const permit = await first.acquire({ owner: 'a', task: 'a', demands: { memory: { units: 4, limit: 4 } } });
    await assert.rejects(second.acquire({ owner: 'b', task: 'b', demands: { memory: { units: 1, limit: 4 } }, waitMs: 100 }));
    await store.pool.query("UPDATE runtime_permits SET payload=jsonb_set(payload,'{expires}','0'::jsonb)");
    const next = await second.acquire({ owner: 'b', task: 'b', demands: { memory: { units: 4, limit: 4 } } });
    await permit.release();
    const rows = await store.pool.query('SELECT permit_id FROM runtime_permits');
    assert.deepEqual(rows.rows.map(row => row.permit_id), [next.id]);
    await next.release();
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
