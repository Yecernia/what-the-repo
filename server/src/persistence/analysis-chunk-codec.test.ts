import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotObjectDigest } from './snapshot-object-store.js';
import { prepareStoredAnalysisPayload, assembleAnalysisPayload, assembleIncrementalBasePayload,
  visitAnalysisFactGraph, readStaticFileFacts, parseAnalysisPayloadEnvelope } from './analysis-payload.js';
import { newAnalysisWriteMetrics, newAnalysisReadMetrics, decodeAnalysisChunk, encodeAnalysisChunk,
  MAX_COMPRESSED_CHUNK_DECODED_BYTES } from './analysis-chunk-codec.js';

const key = (path: string, index: number, sha: string) => `chunks/${path}-${index}-${sha}.json`;
test('compressed chunks preserve all provenance, tombstones, source paths and independent row values', async () => {
  const provenance = { change_kind: 'reused', cache_hit: true, cache_key: 'cache',
    affected_by_stable_ids: Array.from({ length: 32 }, (_, i) => `fact:${i}:` + 'abcdef'.repeat(8)),
    reused_from_snapshot_id: 'previous', recompute_reason: 'unchanged_file_outside_affected_closure' };
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `node:${i}`, attributes: { path: `src/${i}.ts` },
    lifecycle_status: i % 17 ? 'active' : 'tombstoned', tombstoned_at_snapshot_id: i % 17 ? null : 'current',
    evidence: [{ path: `src/${i}.ts` }], members: [], incremental_provenance: { ...provenance } }));
  const original = { snapshot_id: 'current', fact_graph: { nodes,
    edges: nodes.map((n, i) => ({ id: `edge:${i}`, source: n.id, target: 'node:0', incremental_provenance: provenance })) },
    analysis_cache: { manifest: [{ path: 'a.ts' }] },
    static_analysis: { files: [{ path: 'a.ts', detail: '保留源码事实'.repeat(20000) }] } };
  const bodies = new Map<string, Uint8Array>(); const metrics = newAnalysisWriteMetrics();
  const stored = await prepareStoredAnalysisPayload(original, key, async (key, body) => {
    bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  }, 2, { metrics });
  assert.ok(metrics.stored_bytes < metrics.json_bytes / 3);
  const load = async (key: string) => bodies.get(key) ?? null;
  assert.deepEqual(await assembleAnalysisPayload(stored.value, load), original);
  const base = await assembleIncrementalBasePayload(stored.value, load);
  assert.deepEqual(base.analysis_cache, original.analysis_cache);
  assert.equal(base.node_paths.length, nodes.length);
  assert.deepEqual(await readStaticFileFacts(stored.value, load, 'a.ts'), original.static_analysis.files[0]);
  const restored = await assembleAnalysisPayload(stored.value, load) as typeof original;
  restored.fact_graph.nodes[0]!.incremental_provenance.affected_by_stable_ids[0] = 'changed';
  assert.notEqual(restored.fact_graph.nodes[1]!.incremental_provenance.affected_by_stable_ids[0], 'changed');
  const order: string[] = []; const reads = newAnalysisReadMetrics(); let active = 0, peak = 0;
  await visitAnalysisFactGraph(stored.value, async key => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, key.includes('-0-') ? 8 : 1));
    active--; return load(key);
  }, { node: n => order.push((n as {id:string}).id), edge: e => order.push((e as {id:string}).id), metrics: reads });
  assert.deepEqual(order, [...original.fact_graph.nodes, ...original.fact_graph.edges].map(n => n.id));
  assert.ok(peak <= 4 && peak > 1); assert.ok(reads.max_window_bytes <= 16 * 1024 * 1024);
  const envelope = parseAnalysisPayloadEnvelope(stored.value)!;
  const descriptor = envelope.chunks.find(row => row.encoding)!;
  assert.ok(descriptor);
  const bad = structuredClone(envelope); bad.chunks.find(c => c.key === descriptor.key)!.decoded_bytes = 1;
  await assert.rejects(assembleAnalysisPayload(bad, load), /analysis_payload_chunk_invalid/);
  const oversized = structuredClone(envelope);
  oversized.chunks[0]!.decoded_bytes = MAX_COMPRESSED_CHUNK_DECODED_BYTES + 1;
  assert.throws(() => parseAnalysisPayloadEnvelope(oversized), /manifest_invalid/);
  bodies.set(descriptor.key, Buffer.from('corrupt'));
  await assert.rejects(assembleAnalysisPayload(stored.value, load), /integrity_mismatch/);
});
test('encoding is reversible, bounded, and never inferred from magic bytes', async () => {
  const original = Buffer.from('x'.repeat(100000));
  const encoded = await encodeAnalysisChunk(original);
  assert.equal(encoded.encoding, 'gzip-json-v1');
  assert.deepEqual(Buffer.from(await decodeAnalysisChunk(encoded.body, encoded)), original);
  assert.strictEqual(await decodeAnalysisChunk(original, {}), original);
  await assert.rejects(decodeAnalysisChunk(Buffer.from('invalid'), { encoding: 'gzip-json-v1', decoded_bytes: 10 }), /chunk_invalid/);
  await assert.rejects(decodeAnalysisChunk(encoded.body, { encoding: 'gzip-json-v1', decoded_bytes: 99999 }), /chunk_invalid/);
});

test('history prefetch drains in-flight reads and stops visitors after cancellation', async () => {
  const controller = new AbortController(); let active = 0, visited = 0;
  const value = { fact_graph: { nodes: Array.from({ length: 10000 }, (_, i) => ({ id: `${i}` })), edges: [] } };
  const bodies = new Map<string, Uint8Array>();
  const stored = await prepareStoredAnalysisPayload(value, key, async (key, body) => {
    bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  });
  await assert.rejects(visitAnalysisFactGraph(stored.value, async key => {
    active++; await new Promise(resolve => setTimeout(resolve, 5)); active--;
    controller.abort(new Error('test_cancel')); return bodies.get(key)!;
  }, { node: () => visited++, edge: () => visited++, signal: controller.signal }), /test_cancel/);
  assert.equal(active, 0); assert.equal(visited, 0);
});
