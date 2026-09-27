import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { RECLAMATION_TABLES, reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';
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
  const source = 'export function target(){ return 42; } export const run = () => target();';
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
    assert.equal((saved.checkpoint.syntax_files as unknown[]).length, 1);
    const staticAnalysis = saved.snapshot.static_analysis as import('../domain/snapshot.js').EvidenceSnapshot['static_analysis'];
    assert.equal(staticAnalysis?.coverage.discovered_call_sites, 1);
    assert.equal(staticAnalysis?.files[0]?.calls[0]?.status, 'static');
    // A deterministic completed semantic checkpoint exercises the real publication path.
    await store.saveAnalysisCheckpoint(project.project_id, { ...saved.checkpoint, stage: 'assembly', provenance_applied: true }, saved.snapshot);
    const publicKey = String(saved.checkpoint.public_key), snapshotId = String(saved.checkpoint.snapshot_id);
    const oldView = {snapshot_id:snapshotId,graph:{nodes:[],edges:[],layers:[{id:'retired-layer',name:'retired layer',responsibility:'',certainty:'verified',evidence:[]}]},value_points:[],learning_plan:{steps:[]}};
    await store.savePublicSnapshot({publicKey,snapshotId,repository:String(saved.checkpoint.repository),
      commitSha:String(saved.checkpoint.commit_sha),sourceRoot:String(saved.checkpoint.source_root),view:oldView,
      analyzerBundleVersion:String(saved.checkpoint.analyzer_bundle_version),analysisConfigDigest:String(saved.checkpoint.analysis_config_digest),
      analysis:{fact_graph:{nodes:[{id:'retired-marker',name:'retired-marker',members:[],certainty:'verified',
        evidence:[{stable_id:'retired-marker-evidence',label:'retired marker',path:'src/main.ts',start_line:1,end_line:1,kind:'file'}]}],edges:[]}}});
    const oldId = (await store.pool.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',[publicKey])).rows[0].directory_id;
    await isolatedStageExecutor(store, config).run(job, signal);
    assert.equal((await store.loadJob(job.job_id))?.status, 'succeeded');
    assert.equal(await store.analysisCheckpointInfo(project.project_id), null);
    // Reopen through another pool: facts must survive without in-memory state.
    const reader = new PostgresStore({ root, databaseUrl: url, migrationsRoot: join(process.cwd(), 'migrations'),
      encryptionSecret: config.keyEncryptionSecret, poolMax: 1 });
    try {
      await reader.init();
      const published = await reader.loadPublicSnapshot(String(saved.checkpoint.public_key));
      assert.deepEqual(published?.analysis.static_analysis, staticAnalysis);
      assert.deepEqual((published?.view.static_analysis as { files: unknown[] }).files, []);
      const cache = published?.analysis.analysis_cache as { syntax_files: unknown[]; parsed_files: unknown[] };
      assert.equal(cache.syntax_files.length, 1);
      assert.equal(cache.parsed_files.length, 1);
      const snapshotId = String(saved.checkpoint.snapshot_id);
      assert.deepEqual(await reader.readSourceLines(project.project_id, snapshotId, 'src/main.ts', 1, 1),
        { lines: [source], truncated: false });
      await assert.rejects(reader.readSourceLines(project.project_id, 'another-snapshot', 'src/main.ts', 1, 1), /snapshot_not_bound/);
      const detail = await reader.readStaticFile(project.project_id, snapshotId, 'src/main.ts');
      assert.equal(detail?.calls[0]?.callee, 'target');
      assert.equal(detail?.calls[0]?.status, 'static');
      assert.equal(await reader.readStaticFile(project.project_id, snapshotId, 'absent.ts'), null);
      await assert.rejects(reader.readStaticFile(project.project_id, 'another-snapshot', 'src/main.ts'), /snapshot_not_bound/);
    } finally { await reader.close(); }
    assert.equal((await store.claimAnalysisJob('other-worker', 900))?.project_id, other.project_id);
    const permits = await store.pool.query('SELECT count(*)::int AS count FROM runtime_permits');
    assert.equal(permits.rows[0].count, 0, 'all stage/object resources are released');
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rowCount,1,
      'the completed child leaves durable cleanup for the independent maintenance process');
    // Layers now live in objects. Delay the cleanup DELETE statement even when its SQL table is empty.
    while ((await store.pool.query('SELECT table_index FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rows[0].table_index<RECLAMATION_TABLES.indexOf('layers')) {
      await reclaimSnapshotDirectoryBatch(store.pool);
    }
    const cleanupPool = new Pool({connectionString:url,max:1,application_name:'wtr-cleanup-release-proof'});
    const cleanupPid = (await cleanupPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const trigger = 'wtr_cleanup_delay_' + project.project_id.replaceAll('-','');
    let cleanup: ReturnType<typeof reclaimSnapshotDirectoryBatch> | undefined;
    try {
    await store.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.8); RETURN NULL; END $$;
      CREATE TRIGGER ${trigger} BEFORE DELETE ON snapshot_directory_layers FOR EACH STATEMENT
      EXECUTE FUNCTION ${trigger}()`);
      cleanup = reclaimSnapshotDirectoryBatch(cleanupPool);
      let observed = false; const deadline = performance.now()+3_000;
      while (!observed && performance.now()<deadline) {
        observed = (await store.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'",[cleanupPid])).rowCount===1;
        if (!observed) await delay(10);
      }
      assert.equal(observed,true,'observe real delayed SQL, not a timer standing in for cleanup');
      assert.equal((await store.loadJob(job.job_id))?.status,'succeeded');
      const active = (await store.pool.query('SELECT count(*)::int AS n FROM runtime_permits')).rows[0].n;
      assert.equal(active,0,'analysis and publication permits are free while cleanup is still executing');
      assert.deepEqual(await cleanup, { status: 'progress', deletedRows: 0, directoryId: String(oldId) });
      console.log(JSON.stringify({analysisPermitsDuringCleanup:active,jobStatus:'succeeded',cleanupSqlDelayObserved:observed}));
    } finally {
      await cleanup?.catch(() => undefined);
      try { await store.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON snapshot_directory_layers; DROP FUNCTION IF EXISTS ${trigger}()`); }
      finally { await cleanupPool.end(); }
    }
    for (let i=0;i<20;i++) {
      if (!(await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rowCount) break;
      await reclaimSnapshotDirectoryBatch(store.pool);
    }
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation WHERE directory_id=$1',[oldId])).rowCount,0);
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
