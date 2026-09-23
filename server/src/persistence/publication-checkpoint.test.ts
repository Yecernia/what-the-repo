import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { buildSnapshot } from '../analysis/graph.js';
import { buildFullPlan, takeCheckpointAnalysisCache } from '../analysis/incremental.js';
import { preparePublicationCache } from '../analysis/publication-snapshot.js';
import type { ParsedFile } from '../analysis/facts.js';
function fixture() {
  const parsed: ParsedFile[] = Array.from({ length: 200 }, (_, id) => ({ path: `src/${id}.ts`,
    language: 'typescript', digest: 'a'.repeat(64), bytes: 10, symbols: [], imports: [], calls: [], parseError: null }));
  const manifest = parsed.map(({ path, digest, bytes }) => ({ path, digest, bytes }));
  const snapshot = { snapshot_id: 'staged-test', fact_graph: { nodes: parsed.map(file => ({ id: file.path })), edges: [] } };
  const previous = buildSnapshot({ snapshotId: 'old', repository: 'test/staged', commitSha: 'b'.repeat(40), files: parsed, sourceRoot: '/unused' }).fact_graph;
  const checkpoint = { stage: 'assembly', fetched: { manifest }, parsed, syntax_files: parsed, lsp_results: [],
    plan: buildFullPlan(manifest), previous_fact_graph: previous };
  return { checkpoint, snapshot, previous };
}
async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'wtr-staged-checkpoint-'));
  const store = new FileStore(root); await store.init();
  return { root, store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('publication loads compiler records first and recovers both graphs after cache persistence', async () => {
  const env = await environment(); const value = fixture();
  try {
    await env.store.saveAnalysisCheckpoint('project', value.checkpoint, value.snapshot);
    const loaded = await env.store.loadAnalysisCheckpoint<typeof value.checkpoint>('project', { deferPublication: true });
    assert.ok(loaded?.loadPublication);
    assert.equal(loaded.snapshot, null);
    assert.equal(loaded.checkpoint.previous_fact_graph, undefined);
    assert.deepEqual(loaded.checkpoint.parsed, value.checkpoint.parsed);
    assert.strictEqual(loaded.checkpoint.parsed, loaded.checkpoint.syntax_files);
    const cache = await preparePublicationCache(takeCheckpointAnalysisCache(loaded.checkpoint), data =>
      env.store.preparePublicSnapshotAnalysisCache({ publicKey: 'a'.repeat(64), snapshotId: 'staged-test', cache: data }));
    assert.ok(cache.prepared);
    assert.equal(Object.hasOwn(loaded.checkpoint, 'parsed'), false);
    assert.equal(await env.store.loadPublicSnapshot('a'.repeat(64)), null);
    const graphs = await loaded.loadPublication();
    assert.deepEqual(graphs.snapshot, value.snapshot);
    assert.deepEqual(graphs.previousFactGraph, value.previous);
    assert.deepEqual(await loaded.loadPublication(), graphs, 'loader is repeatable, not a retained decoded result');
    assert.deepEqual((await env.store.loadAnalysisCheckpoint('project'))!.checkpoint, value.checkpoint);
  } finally { await env.close(); }
});

test('deferred reads use captured generation descriptors rather than following a changed pointer', async () => {
  const env = await environment(); const value = fixture();
  try {
    await env.store.saveAnalysisCheckpoint('project', value.checkpoint, value.snapshot);
    const pointerPath = join(env.root, 'analysis-checkpoints/project.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const loaded = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true });
    await writeFile(pointerPath, JSON.stringify({ ...pointer, payload_file: 'project.other.bin' }));
    assert.deepEqual((await loaded!.loadPublication!()).snapshot, value.snapshot);
    await writeFile(pointerPath, JSON.stringify(pointer));
    await env.store.saveAnalysisCheckpoint('project', value.checkpoint, { ...value.snapshot, snapshot_id: 'replacement' });
    await assert.rejects(loaded!.loadPublication!(), /analysis_checkpoint_payload_missing/);
    assert.equal(((await env.store.loadAnalysisCheckpoint('project'))!.snapshot as { snapshot_id: string }).snapshot_id, 'replacement');
  } finally { await env.close(); }
});

test('missing publication snapshots are errors, not requests to repeat analysis', async () => {
  const env = await environment();
  try {
    await env.store.saveAnalysisCheckpoint('project', fixture().checkpoint, null);
    const loaded = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true });
    await assert.rejects(loaded!.loadPublication!(), /analysis_checkpoint_snapshot_missing/);
  } finally { await env.close(); }
});

test('both phases reject corrupted files, cross-project descriptors and cancellation', async () => {
  const env = await environment(); const value = fixture();
  try {
    await env.store.saveAnalysisCheckpoint('project', value.checkpoint, value.snapshot);
    const pointerPath = join(env.root, 'analysis-checkpoints/project.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const loaded = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true });
    for (const file of [pointer.payload_file, pointer.static_payload.file]) {
      const path = join(env.root, 'analysis-checkpoints', file);
      const original = await readFile(path), damaged = Buffer.from(original);
      damaged[damaged.length - 1]! ^= 1; await writeFile(path, damaged);
      await assert.rejects(loaded!.loadPublication!(), /integrity_mismatch/);
      await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /integrity_mismatch/);
      await writeFile(path, original);
    }
    await writeFile(pointerPath, JSON.stringify({ ...pointer, static_payload: { ...pointer.static_payload, file: 'other.bin' } }));
    await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /payload_invalid/);
    await writeFile(pointerPath, JSON.stringify(pointer));
    const controller = new AbortController();
    const cancellable = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true, signal: controller.signal });
    const reason = new Error('cancel-staged-publication'); controller.abort(reason);
    await assert.rejects(cancellable!.loadPublication!(), error => error === reason);
    await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true, omitStatic: true }), /read_options_invalid/);
  } finally { await env.close(); }
});

test('malformed binary pointers are not treated as missing checkpoints', async () => {
  const env = await environment();
  try {
    const pointerPath = join(env.root, 'analysis-checkpoints/project.json');
    for (const pointer of [
      { schema_version: 1, encoding: 'v8-records', payload_file: '../outside.bin', bytes: 4, sha256: 'a'.repeat(64) },
      { schema_version: 1, encoding: 'v8-records', payload_file: 'project.data.bin', bytes: 4, sha256: 'invalid' },
    ]) {
      await writeFile(pointerPath, JSON.stringify(pointer));
      await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /payload_invalid/);
      await assert.rejects(env.store.loadAnalysisCheckpoint('project'), /payload_invalid/);
    }
  } finally { await env.close(); }
});

test('unprovenanced assembly rejects absent or incomplete compiler data instead of dropping the cache', async () => {
  const env = await environment(); const value = fixture();
  try {
    await env.store.saveAnalysisCheckpoint('project', value.checkpoint, value.snapshot);
    const pointerPath = join(env.root, 'analysis-checkpoints/project.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const { static_payload: _static, ...withoutStatic } = pointer;
    await writeFile(pointerPath, JSON.stringify(withoutStatic));
    await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /analysis_checkpoint_static_missing/);
    await writeFile(pointerPath, JSON.stringify(pointer));
    for (const field of ['parsed', 'lsp_results'] as const) {
      const incomplete = { ...value.checkpoint, [field]: undefined };
      await env.store.saveAnalysisCheckpoint('project', incomplete, value.snapshot);
      await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /analysis_checkpoint_static_invalid/);
    }
  } finally { await env.close(); }
});

test('incremental publication requires its previous graph while provenanced snapshots can stand alone', async () => {
  const env = await environment(); const value = fixture();
  try {
    const checkpoint = { ...value.checkpoint, previous_fact_graph: null,
      plan: { ...value.checkpoint.plan, mode: 'incremental' as const, parentSnapshotId: 'old' } };
    await env.store.saveAnalysisCheckpoint('project', checkpoint, value.snapshot);
    const loaded = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true });
    await assert.rejects(loaded!.loadPublication!(), /analysis_checkpoint_previous_graph_missing/);
    const keyed = { ...checkpoint, from_public_key: 'a'.repeat(64) };
    await env.store.saveAnalysisCheckpoint('project', keyed, value.snapshot);
    const keyedLoad = await env.store.loadAnalysisCheckpoint('project', { deferPublication: true });
    assert.equal(keyedLoad?.checkpoint.from_public_key, keyed.from_public_key);
    assert.deepEqual(await keyedLoad!.loadPublication!(), { snapshot: value.snapshot, previousFactGraph: null });
    await env.store.saveAnalysisCheckpoint('project', { ...keyed, from_public_key: 'invalid' }, value.snapshot);
    await assert.rejects(env.store.loadAnalysisCheckpoint('project', { deferPublication: true }), /payload_invalid/);
    await env.store.saveAnalysisCheckpoint('standalone', { stage: 'assembly', provenance_applied: true }, value.snapshot);
    const standalone = await env.store.loadAnalysisCheckpoint('standalone', { deferPublication: true });
    assert.deepEqual(await standalone!.loadPublication!(), { snapshot: value.snapshot, previousFactGraph: null });
  } finally { await env.close(); }
});
