import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../persistence/file-store.js';
import { stageMemoryMb, stageMemoryFailureDetector } from './stage-executor.js';
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
  assert.ok(stageMemoryMb('publish', large) > stageMemoryMb('semantic', large));
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
  assert.equal(stageMemoryMb('publish', info), 10816);
  assert.equal(stageMemoryMb('publish', info, 80, 8192), 8192);
  assert.equal(stageMemoryMb('cpu', info, 80, 8192), 8192);
  assert.equal(stageMemoryMb('fetch', null, 80, 8192), 1024);
  const small = { bytes: 1048576, sourceBytes: 1048576 };
  assert.equal(stageMemoryMb('publish', small, 80, 8192), stageMemoryMb('publish', small));
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
