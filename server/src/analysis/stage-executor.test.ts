import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../persistence/file-store.js';
import { stageDatabasePoolMax, stageHeapCapMb, stageMemoryMb, stageMemoryFailureDetector, isolatedStageExecutor, type executeStageProcess } from './stage-executor.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { createProject } from '../domain/conversation.js';
import type { ProductStore } from '../persistence/store.js';
import type { ServerConfig } from '../config.js';
import { permitStoreFor } from '../scheduling/permits.js';
import { ResourceScheduler } from '../scheduling/resources.js';
import { concurrencyConfig } from '../scheduling/config.js';
import { isRetryableAnalysisError } from './coordinator.js';
import { checkpointExecutionStage } from './stage-protocol.js';

test('semantic checkpoint loading excludes static caches and preserves them for publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-stage-checkpoint-'));
  const store = new FileStore(root);
  try {
    await store.init();
    const staticFields = { parsed: [{ path: 'a.ts' }], syntax_files: [{ path: 'a.ts', syntaxKey: 'test' }], lsp_results: [], previous_fact_graph: { nodes: ['old'] } };
    const checkpoint = { stage: 'semantic', fetched: { manifest: [{ bytes: 25 }] }, ...staticFields };
    await store.saveAnalysisCheckpoint('project', checkpoint, { graph: { nodes: ['facts'] } });
    const info = await store.analysisCheckpointInfo('project');
    assert.equal(info?.stage, 'semantic'); assert.equal(info?.sourceBytes, 25);
    const light = await store.loadAnalysisCheckpoint('project', { omitStatic: true });
    assert.equal(light?.checkpoint.parsed, undefined);
    assert.equal(light?.checkpoint.syntax_files, undefined);
    assert.deepEqual(light?.snapshot, { graph: { nodes: ['facts'] } });
    await store.saveAnalysisCheckpoint('project', { ...light!.checkpoint, stage: 'assembly' }, { graph: { nodes: ['enriched'] } });
    const full = await store.loadAnalysisCheckpoint('project');
    assert.deepEqual(full?.checkpoint.parsed, staticFields.parsed);
    assert.deepEqual(full?.checkpoint.syntax_files, staticFields.syntax_files);
    assert.deepEqual(full?.checkpoint.previous_fact_graph, staticFields.previous_fact_graph);
    assert.deepEqual(full?.snapshot, { graph: { nodes: ['enriched'] } });
    assert.equal(checkpointExecutionStage((await store.analysisCheckpointInfo('project'))?.stage), 'publish');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('stage resource estimates distinguish source expansion and graph publication', () => {
  assert.equal(checkpointExecutionStage(), 'fetch');
  assert.equal(checkpointExecutionStage('source'), 'cpu');
  const small = { bytes: 1048576, sourceBytes: 1048576 };
  const large = { bytes: 100 * 1048576, sourceBytes: 100 * 1048576 };
  assert.ok(stageMemoryMb('cpu', large) > stageMemoryMb('cpu', small));
  const graph = { ...large, staticBytes: 50 * 1048576 };
  assert.ok(stageMemoryMb('publish', graph) > stageMemoryMb('semantic', graph));
});

test('large static stages can raise heap allowance without inflating semantic reservations', () => {
  const info = { bytes: 2 * 1048576, sourceBytes: 92 * 1048576 };
  const tuned = concurrencyConfig({ WHAT_THE_REPO_ANALYSIS_CPU_MEMORY_EXPANSION: '96' });
  assert.ok(stageMemoryMb('cpu', info, tuned.analysisCpuMemoryExpansion) > stageMemoryMb('cpu', info));
  assert.equal(stageMemoryMb('semantic', info, tuned.analysisCpuMemoryExpansion), stageMemoryMb('semantic', info));
  for (const value of ['0', '129', '1.5', 'NaN']) {
    assert.throws(() => concurrencyConfig({ WHAT_THE_REPO_ANALYSIS_CPU_MEMORY_EXPANSION: value }), /ANALYSIS_CPU_MEMORY_EXPANSION/);
  }
});

test('large publication estimates do not reject a checkpoint before bounded execution', () => {
  // A real 11,941-file checkpoint was rejected after all model work completed.
  const info = { bytes: 577078888, sourceBytes: 96806438, staticBytes: 500990953 };
  assert.equal(stageMemoryMb('publish', info, 80, Infinity, 10), 10816);
  assert.equal(stageMemoryMb('publish', info, 80, 8192, 10), 8192);
  assert.equal(stageMemoryMb('cpu', info, 80, 8192, 10), 8192);
  assert.equal(stageMemoryMb('fetch', null, 80, 8192), 1024);
  const small = { bytes: 1048576, sourceBytes: 1048576 };
  assert.equal(stageMemoryMb('publish', small, 80, 8192), stageMemoryMb('publish', small));
});

test('checkpoint expansion is independently configurable and excludes static caches during semantic work', () => {
  const tuned = concurrencyConfig({ WHAT_THE_REPO_ANALYSIS_CHECKPOINT_MEMORY_EXPANSION: '4' });
  const info = { bytes: 100 * 1048576, sourceBytes: 20 * 1048576, staticBytes: 200 * 1048576 };
  assert.equal(stageMemoryMb('semantic', info, 60, 8192, tuned.analysisCheckpointMemoryExpansion), 960);
  assert.equal(stageMemoryMb('publish', info, 60, 8192, tuned.analysisCheckpointMemoryExpansion), 1728);
  assert.equal(stageMemoryMb('cpu', info, 60, 8192, tuned.analysisCheckpointMemoryExpansion), 1984);
  for (const value of ['1', '17', '2.5', 'NaN']) {
    assert.throws(() => concurrencyConfig({ WHAT_THE_REPO_ANALYSIS_CHECKPOINT_MEMORY_EXPANSION: value }), /ANALYSIS_CHECKPOINT_MEMORY_EXPANSION/);
  }
});

test('fragmented fatal V8 diagnostics classify memory exhaustion without retrying it', () => {
  const detect = stageMemoryFailureDetector();
  assert.equal(detect('private diagnostic payload; ordinary heap usage\n'), false);
  assert.equal(detect('FATAL ERROR: Reached heap li'), false);
  assert.equal(detect(Buffer.from('mit Allocation failed - JavaScript heap out of memory\n')), true);
  assert.equal(detect(''), true);
  assert.equal(isRetryableAnalysisError('analysis_stage_memory_limit_exceeded'), false);
  assert.equal(isRetryableAnalysisError('analysis_stage_process_failed'), true);
  const bounded = stageMemoryFailureDetector();
  bounded('FATAL ERROR:' + 'x'.repeat(2048));
  assert.equal(bounded('heap out of memory'), false);
});

test('legacy inline checkpoints keep static caches when resumed into the lean semantic phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-stage-legacy-'));
  const store = new FileStore(root);
  try {
    await store.init();
    for (const binary of [true, false]) {
      const data = { checkpoint: { stage: 'semantic', parsed: [{ path: 'legacy.ts' }], lsp_results: [],
        previous_fact_graph: { nodes: ['prior'] } }, snapshot: { graph: {} } };
      const bytes = serialize(data);
      await writeFile(join(root, 'analysis-checkpoints', 'legacy.old.bin'), bytes);
      await writeFile(join(root, 'analysis-checkpoints', 'legacy.json'), JSON.stringify(binary ? {
        schema_version: 1, encoding: 'v8', payload_file: 'legacy.old.bin', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } : data));
      const light = await store.loadAnalysisCheckpoint('legacy', { omitStatic: true });
      assert.equal(light?.checkpoint.parsed, undefined);
      await store.saveAnalysisCheckpoint('legacy', { ...light!.checkpoint, stage: 'assembly' }, light!.snapshot);
      const full = await store.loadAnalysisCheckpoint('legacy');
      assert.deepEqual(full?.checkpoint.parsed, data.checkpoint.parsed);
      assert.deepEqual(full?.checkpoint.previous_fact_graph, data.checkpoint.previous_fact_graph);
      assert.ok((await store.analysisCheckpointInfo('legacy'))!.staticBytes > 0);
      await store.clearAnalysisCheckpoint('legacy');
    }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

function recoveryFixture() {
  const project = createProject('guest:recovery', 'https://github.com/example/recovery', 'Recovery');
  const job = { ...newAnalysisJob(project.project_id, 'recovery'), status: 'running' as const, lease_owner: 'supervisor' };
  const state = { checkpoint: 'source', job, onWait: async () => {} };
  const store = {
    loadProject: async () => project,
    analysisCheckpointInfo: async () => ({ stage: state.checkpoint, bytes: 0, sourceBytes: 0 }),
    loadJob: async () => state.job,
    updateProject: async () => state.onWait(),
  } as unknown as ProductStore;
  const config = { analysisMemoryMb: 2048, analysisCpuConcurrency: 2 } as ServerConfig;
  const signal = new AbortController();
  return { store, config, signal, job, state };
}

test('memory recovery continues from a committed checkpoint without repeating static work', async () => {
  const f = recoveryFixture();
  const stages: string[] = [];
  const execute: typeof executeStageProcess = async (_job, stage) => {
    stages.push(stage);
    if (stage === 'cpu') { f.state.checkpoint = 'semantic'; throw new Error('analysis_stage_memory_limit_exceeded'); }
    return null;
  };
  await isolatedStageExecutor(f.store, f.config, execute).run(f.job, f.signal.signal);
  assert.deepEqual(stages, ['cpu', 'semantic']);
  assert.equal(await permitStoreFor(f.store).change('resource-admission-v1', rows => rows.length), 0);
});

test('a larger memory retry waits with every old grant released and retains the owner identity', async () => {
  const f = recoveryFixture(), permits = permitStoreFor(f.store);
  const scheduler = new ResourceScheduler(permits);
  const allowances: number[] = [];
  let blocker: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
  let observedWait = false;
  f.state.onWait = async () => {
    if (observedWait) return;
    await permits.change('resource-admission-v1', rows => {
      assert.equal(rows.filter(row => row.state === 'running' && row.owner === 'guest:recovery').length, 0);
      assert.equal(rows.filter(row => row.state === 'waiting' && row.owner === 'guest:recovery').length, 1);
    });
    observedWait = true;
    await blocker!.release();
  };
  const execute: typeof executeStageProcess = async (_job, _stage, _config, memory) => {
    allowances.push(memory);
    if (allowances.length === 1) {
      blocker = await scheduler.acquire({ owner: 'other', task: 'other', demands: {
        'analysis:memory-mb': { units: 1024, limit: 2048 }, 'analysis:cpu': { units: 1, limit: 2 },
      } });
      throw new Error('analysis_stage_memory_limit_exceeded');
    }
    return null;
  };
  try {
    await isolatedStageExecutor(f.store, f.config, execute).run(f.job, f.signal.signal);
    assert.deepEqual(allowances, [768, 1152]); assert.equal(observedWait, true);
    assert.equal(await permits.change('resource-admission-v1', rows => rows.length), 0);
  } finally { await blocker?.release(); }
});

test('memory correction stops after one retry or at the pool ceiling; unrelated failures never retry', async () => {
  for (const [budget, error, expected] of [[2048, 'analysis_stage_memory_limit_exceeded', 2],
    [768, 'analysis_stage_memory_limit_exceeded', 1], [2048, 'analysis_stage_process_failed', 1]] as const) {
    const f = recoveryFixture(); f.config.analysisMemoryMb = budget;
    let attempts = 0;
    await assert.rejects(isolatedStageExecutor(f.store, f.config, async () => {
      attempts++; throw new Error(error);
    }).run(f.job, f.signal.signal), { message: error });
    assert.equal(attempts, expected);
    assert.equal(await permitStoreFor(f.store).change('resource-admission-v1', rows => rows.length), 0);
  }
});

test('cancellation and job lease changes cannot start a memory recovery', async () => {
  for (const cancelled of [true, false]) {
    const f = recoveryFixture(); let attempts = 0;
    const run = isolatedStageExecutor(f.store, f.config, async () => {
      attempts++;
      if (cancelled) f.signal.abort(new Error('analysis_cancelled'));
      else f.state.job = { ...f.job, lease_owner: 'replacement' };
      throw new Error('analysis_stage_memory_limit_exceeded');
    }).run(f.job, f.signal.signal);
    if (cancelled) await assert.rejects(run, /analysis_cancelled/); else await run;
    assert.equal(attempts, 1);
    assert.equal(await permitStoreFor(f.store).change('resource-admission-v1', rows => rows.length), 0);
  }
});

test('large stages keep 1 GiB outside the V8 heap while small stages keep the proportional reserve', () => {
  assert.equal(stageHeapCapMb(9216), 8192);
  assert.equal(stageHeapCapMb(4096), 3276);
  assert.equal(stageHeapCapMb(1024), 819);
  assert.equal(stageHeapCapMb(200), 256);
});

test('publication children get connections for the binding transaction and three directory lanes', () => {
  assert.equal(stageDatabasePoolMax('publish'), 5);
  for (const stage of ['fetch', 'cpu', 'semantic', 'overlay'] as const) assert.equal(stageDatabasePoolMax(stage), 2);
});
