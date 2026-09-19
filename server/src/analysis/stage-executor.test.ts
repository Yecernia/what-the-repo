import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../persistence/file-store.js';
import { stageMemoryMb } from './stage-executor.js';
import { checkpointExecutionStage } from './stage-protocol.js';

test('semantic checkpoint loading excludes static caches and preserves them for publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-stage-checkpoint-'));
  const store = new FileStore(root);
  try {
    await store.init();
    const staticFields = { parsed: [{ path: 'a.ts' }], lsp_results: [], previous_fact_graph: { nodes: ['old'] } };
    const checkpoint = { stage: 'semantic', fetched: { manifest: [{ bytes: 25 }] }, ...staticFields };
    await store.saveAnalysisCheckpoint('project', checkpoint, { graph: { nodes: ['facts'] } });
    const info = await store.analysisCheckpointInfo('project');
    assert.equal(info?.stage, 'semantic'); assert.equal(info?.sourceBytes, 25);
    const light = await store.loadAnalysisCheckpoint('project', { omitStatic: true });
    assert.equal(light?.checkpoint.parsed, undefined);
    assert.deepEqual(light?.snapshot, { graph: { nodes: ['facts'] } });
    await store.saveAnalysisCheckpoint('project', { ...light!.checkpoint, stage: 'assembly' }, { graph: { nodes: ['enriched'] } });
    const full = await store.loadAnalysisCheckpoint('project');
    assert.deepEqual(full?.checkpoint.parsed, staticFields.parsed);
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
