import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_PAYLOAD_CHUNK_SIZE,
  ANALYSIS_PAYLOAD_CHUNK_BYTES,
  assembleAnalysisPayload,
  assembleIncrementalBasePayload,
  visitAnalysisFactGraph,
  parseAnalysisPayloadEnvelope,
  prepareAnalysisPayload,
  prepareStoredAnalysisPayload,
  mergePreparedAnalysisCache,
  readStaticFileFacts,
  readAnalysisFactRows,
  visitAnalysisFactLineage,
  analysisPayloadChunkKeys,
} from "./analysis-payload.js";
import { snapshotObjectDigest } from './snapshot-object-store.js';

test('incremental reads project old node paths and cache without hydrating edges or static files', async () => {
  const nodes = Array.from({ length: 2050 }, (_, index) => ({ id: `n${index}`,
    attributes: index === 0 ? {} : { path: `src/${index}.ts` },
    evidence: index === 0 ? [{ path: 'fallback.ts' }] : [], members: [] }));
  const edges = Array.from({ length: 2050 }, (_, index) => ({ id: `e${index}`, source: 'n0', target: 'n1' }));
  const value = { fact_graph: { nodes, edges }, analysis_cache: { manifest: [{ path: 'a.ts' }] },
    static_analysis: { files: Array.from({ length: 64 }, (_, index) => ({ path: `src/${index}.ts` })) } };
  const prepared = prepareAnalysisPayload(value, (path, index, sha) => `analysis-chunks/${path}-${index}-${sha}`);
  const bodies = new Map(prepared.chunks.map(chunk => [chunk.descriptor.key, chunk.body]));
  const reads: string[] = [];
  const load = async (key: string) => { reads.push(key); return bodies.get(key) ?? null; };
  const base = await assembleIncrementalBasePayload(prepared.value, load);
  assert.equal(base.fact_graph_available, true);
  assert.deepEqual(base.analysis_cache, value.analysis_cache);
  assert.equal(base.node_paths.length, nodes.length);
  assert.deepEqual(base.node_paths[0], { id: 'n0', path: 'fallback.ts' });
  assert.ok(reads.every(key => !key.includes('fact_graph.edges') && !key.includes('static_analysis.files')));
  reads.length = 0;
  const visited: string[] = [];
  const envelope = parseAnalysisPayloadEnvelope(prepared.value)!;
  const reordered = { ...envelope, chunks: [...envelope.chunks].sort((a, b) =>
    (a.path === 'fact_graph.edges' ? 0 : a.path === 'fact_graph.nodes' ? 1 : 2)
      - (b.path === 'fact_graph.edges' ? 0 : b.path === 'fact_graph.nodes' ? 1 : 2)
      || a.index - b.index) };
  await visitAnalysisFactGraph(reordered, load, {
    node: row => visited.push((row as { id: string }).id),
    edge: row => visited.push((row as { id: string }).id),
  });
  assert.equal(visited.filter(id => id.startsWith('n')).length, nodes.length);
  assert.equal(visited.filter(id => id.startsWith('e')).length, edges.length);
  assert.ok(visited.indexOf('e0') > visited.lastIndexOf('n2049'));
  assert.ok(reads.every(key => !key.includes('static_analysis.files')));
});

test('preuploaded compiler cache composes the same payload and rejects cross-snapshot binding', async () => {
  const bodies = new Map<string, Uint8Array>();
  const put = async (key: string, body: Uint8Array) => {
    bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  };
  const key = (path: string, index: number, sha: string) => `chunks/${path}-${index}-${sha}`;
  for (const count of [2, 2050]) {
    const cache = { parsed_files: Array.from({length:count},(_,i)=>({path:`${i}.ts`,digest:String(i)})) };
    const graph = { fact_graph: { nodes: Array.from({length:2050},(_,i)=>({id:String(i)})) } };
    const preparedCache = {publicKey:'public',snapshotId:'snapshot',payload:await prepareStoredAnalysisPayload({analysis_cache:cache},key,put)};
    const prepared = await prepareStoredAnalysisPayload(graph,key,put);
    const merged = mergePreparedAnalysisCache(prepared,preparedCache,'public','snapshot');
    const all = await prepareStoredAnalysisPayload({...graph,analysis_cache:cache},key,put);
    assert.deepEqual(merged.value,all.value);
    assert.deepEqual(await assembleAnalysisPayload(merged.value,async key=>bodies.get(key)??null),{...graph,analysis_cache:cache});
    assert.throws(()=>mergePreparedAnalysisCache(prepared,preparedCache,'other','snapshot'),/identity_mismatch/);
    assert.throws(()=>mergePreparedAnalysisCache(prepared,preparedCache,'public','other'),/identity_mismatch/);
  }
});

test('stored chunks bound UTF-8 bytes, preserve order and allow one indivisible large record', async () => {
  const values = Array.from({length:ANALYSIS_PAYLOAD_CHUNK_SIZE+1},(_,i)=>({id:i,text:'中'.repeat(1500)}));
  values[23]!.text='x'.repeat(ANALYSIS_PAYLOAD_CHUNK_BYTES+1);
  const original={analysis_cache:{parsed_files:values}};
  const bodies=new Map<string,Uint8Array>();let active=0,peak=0;
  const prepared=await prepareStoredAnalysisPayload(original,(path,i,sha)=>`chunks/${path}-${i}-${sha}.json`,async(key,body)=>{
    active++;peak=Math.max(peak,active);
    const decoded=JSON.parse(Buffer.from(body).toString());
    assert.ok(body.byteLength<=ANALYSIS_PAYLOAD_CHUNK_BYTES || decoded.length===1);
    bodies.set(key,body);await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {key,bytes:body.byteLength,sha256:key.slice(-69,-5)};
  },2,{compression:false});
  assert.ok(peak<=2);assert.ok(prepared.chunks.length>2);
  assert.deepEqual(await assembleAnalysisPayload(prepared.value,async key=>bodies.get(key)??null),original);
  const sync=prepareAnalysisPayload(original,(path,i,sha)=>`chunks/${path}-${i}-${sha}.json`);
  assert.deepEqual(sync.value,prepared.value);
  for(const chunk of sync.chunks)assert.deepEqual(chunk.body,bodies.get(chunk.descriptor.key));
});

test("large analysis arrays are chunked and reassembled with ordering", async () => {
  const nodes = Array.from({ length: ANALYSIS_PAYLOAD_CHUNK_SIZE + 17 }, (_, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`,
  }));
  const edges = Array.from({ length: ANALYSIS_PAYLOAD_CHUNK_SIZE * 2 + 3 }, (_, index) => ({
    id: `edge-${index}`,
    source: `node-${index % nodes.length}`,
    target: `node-${(index + 1) % nodes.length}`,
  }));
  const parsedFiles = Array.from({ length: ANALYSIS_PAYLOAD_CHUNK_SIZE + 1 }, (_, index) => ({
    path: `file-${index}.ts`,
    bytes: index,
    digest: `${index}`,
    symbols: [],
    imports: [],
    calls: [],
    parseError: null,
  }));
  const original = {
    snapshot_id: "snap:chunked",
    fact_graph: { nodes, edges },
    analysis_cache: { schema_version: "analysis-cache-v3-project-facts", manifest: [], syntax_files: parsedFiles, parsed_files: parsedFiles, lsp_results: [] },
    static_analysis: { schema_version: "project-facts-v1", files: parsedFiles.map(file => ({ path: file.path, calls: [], diagnostics: [] })) },
    semantic_graph: { nodes: [{ id: "component-1" }] },
  };
  const bodies = new Map<string, Uint8Array>();
  const prepared = prepareAnalysisPayload(original, (path, index, sha256) => {
    const key = `analysis-chunks/${path.replace(".", "-")}-${index}-${sha256}.json`;
    return key;
  });
  assert.ok(prepared.envelope);
  assert.ok(prepared.chunks.length >= 4);
  assert.equal((prepared.value as { fact_graph?: { nodes?: unknown[] } }).fact_graph?.nodes, undefined);
  for (const chunk of prepared.chunks) bodies.set(chunk.descriptor.key, chunk.body);

  const envelope = parseAnalysisPayloadEnvelope(prepared.value);
  assert.ok(envelope);
  const restored = await assembleAnalysisPayload(prepared.value, async (key) => bodies.get(key) ?? null);
  assert.deepEqual(restored, original);

  const first = prepared.chunks[0]!;
  const changed = Buffer.from(first.body);
  changed[0] = changed[0] === 91 ? 93 : 91;
  bodies.set(first.descriptor.key, changed);
  await assert.rejects(
    assembleAnalysisPayload(prepared.value, async (key) => bodies.get(key) ?? null),
    /analysis_payload_chunk_integrity_mismatch/,
  );
});

test("static file lookup loads one indexed block and verifies its digest", async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/${index}.ts`, calls: [{ status: "unresolved" }] }));
  const value = { static_analysis: { files }, fact_graph: { nodes: Array(3000).fill({ id: "unused" }) } };
  const prepared = prepareAnalysisPayload(value, (path, index, digest) => `analysis-chunks/${path}-${index}-${digest}.json`);
  const bodies = new Map(prepared.chunks.map(chunk => [chunk.descriptor.key, chunk.body]));
  const reads: string[] = [];
  const load = async (key: string) => { reads.push(key); return bodies.get(key) ?? null; };
  assert.deepEqual(await readStaticFileFacts(prepared.value, load, "src/99.ts"), files[99]);
  assert.equal(reads.length, 1);
  assert.match(reads[0]!, /static_analysis.files/);
  assert.equal(await readStaticFileFacts(prepared.value, load, "unknown.ts"), null);
  assert.equal(reads.length, 1);
  bodies.set(reads[0]!, Buffer.from("[]"));
  await assert.rejects(readStaticFileFacts(prepared.value, load, "src/99.ts"), /integrity_mismatch/);
});

test("historical unchunked analysis values remain unchanged", async () => {
  const value = { snapshot_id: "snap:legacy", fact_graph: { nodes: [], edges: [] } };
  const prepared = prepareAnalysisPayload(value, () => "analysis-chunks/unexpected.json");
  assert.equal(prepared.envelope, null);
  assert.strictEqual(prepared.value, value);
  assert.deepEqual(await assembleAnalysisPayload(value, async () => null), value);
  assert.equal(parseAnalysisPayloadEnvelope(value), null);
});

test("stored preparation writes bounded chunks and returns only descriptors", async () => {
  const original = {
    snapshot_id: "snap:stored-chunks",
    fact_graph: {
      nodes: Array.from({ length: ANALYSIS_PAYLOAD_CHUNK_SIZE + 1 }, (_, index) => ({ id: `node-${index}` })),
      edges: [],
    },
  };
  const bodies = new Map<string, Uint8Array>();
  const prepared = await prepareStoredAnalysisPayload(
    original,
    (path, index, sha256) => `analysis-chunks/${path.replace(".", "-")}-${index}-${sha256}.json`,
    async (key, body) => {
      bodies.set(key, Buffer.from(body));
      return { key, bytes: body.byteLength, sha256: key.slice(-69, -5) };
    },
    2,
  );
  assert.ok(prepared.envelope);
  // Two graph chunks plus one compact lineage chunk; all stored objects are tracked.
  assert.equal(prepared.envelope.chunks.length, 2);
  assert.equal(prepared.chunks.length, 3);
  assert.equal("body" in prepared.chunks[0]!, false);
  const restored = await assembleAnalysisPayload(prepared.value, async (key) => bodies.get(key) ?? null);
  assert.deepEqual(restored, original);
});

test('byte limits also chunk arrays below the record-count threshold', async () => {
  const original = { analysis_cache: { parsed_files: [
    { path: 'one.ts', text: 'x'.repeat(ANALYSIS_PAYLOAD_CHUNK_BYTES / 2) },
    { path: 'two.ts', text: '中'.repeat(ANALYSIS_PAYLOAD_CHUNK_BYTES / 6 | 0) },
  ] } };
  const bodies = new Map<string, Uint8Array>();
  const key = (path: string, index: number, sha: string) => `chunks/${path}-${index}-${sha}.json`;
  const result = await prepareStoredAnalysisPayload(original, key, async (key, body) => {
    bodies.set(key, body);
    assert.ok(body.byteLength <= ANALYSIS_PAYLOAD_CHUNK_BYTES);
    return { key, bytes: body.byteLength, sha256: key.slice(-69, -5) };
  }, 2, {compression:false});
  assert.equal(result.chunks.length, 2);
  assert.deepEqual(result.value, prepareAnalysisPayload(original, key).value);
  assert.deepEqual(await assembleAnalysisPayload(result.value, async key => bodies.get(key) ?? null), original);
});

test('stored graphs publish compact lineage used for node paths, purge keys and ordinal row reads', async () => {
  const nodes = Array.from({ length: 5000 }, (_, index) => ({ id: `n${index}`, revision_id: `r${index}`,
    first_seen_snapshot_id: 'snap:first', lifecycle_status: index === 7 ? 'tombstoned' : 'active',
    source_observations: index === 9 ? [{ extractor: 'lsp' }] : [],
    attributes: index === 0 ? {} : { path: `src/${index}.ts` },
    evidence: index === 0 ? [{ path: 'fallback.ts' }] : [], members: [] }));
  const edges = Array.from({ length: 4100 }, (_, index) => ({ id: `e${index}`, revision_id: `er${index}`,
    source: `n${index}`, target: index === 3 ? 'outside' : `n${index + 1}`, lifecycle_status: 'active' }));
  const value = { fact_graph: { nodes, edges }, analysis_cache: { manifest: [{ path: 'a.ts' }] } };
  const bodies = new Map<string, Uint8Array>();
  const put = async (key: string, body: Uint8Array) => {
    bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  };
  const key = (path: string, index: number, sha: string) => `analysis-chunks/${path}-${index}-${sha}`;
  const withLineage = await prepareStoredAnalysisPayload(value, key, put);
  const legacy = await prepareStoredAnalysisPayload(value, key, put, 4, { factLineage: false });
  const reads: string[] = [];
  const load = async (name: string) => { reads.push(name); return bodies.get(name) ?? null; };

  const base = await assembleIncrementalBasePayload(withLineage.value, load);
  assert.deepEqual(base.node_paths, (await assembleIncrementalBasePayload(legacy.value, load)).node_paths);
  reads.length = 0;
  await assembleIncrementalBasePayload(withLineage.value, load);
  assert.equal(reads.some(name => name.includes('fact_graph')), false);

  const nodeRows: unknown[] = [], edgeRows: unknown[] = [];
  assert.equal(await visitAnalysisFactLineage(withLineage.value, load, {
    node: (row, ordinal) => { assert.equal(ordinal, nodeRows.length); nodeRows.push(row); },
    edge: (row, ordinal) => { assert.equal(ordinal, edgeRows.length); edgeRows.push(row); },
  }), true);
  assert.deepEqual(nodeRows[0], ['n0', 'r0', 'snap:first', 'fallback.ts', 1]);
  assert.deepEqual(nodeRows[7], ['n7', 'r7', 'snap:first', 'src/7.ts', 0]);
  assert.deepEqual(nodeRows[9], ['n9', 'r9', 'snap:first', 'src/9.ts', 3]);
  assert.deepEqual(edgeRows[3], ['e3', 'er3', null, 3, 'outside', 1]);
  assert.equal(await visitAnalysisFactLineage(legacy.value, load, { node: () => {}, edge: () => {} }), false);

  reads.length = 0;
  const rows = await readAnalysisFactRows(withLineage.value, load, { nodes: [4999], edges: [0] });
  assert.deepEqual(rows.nodes.get(4999), nodes[4999]);
  assert.deepEqual(rows.edges.get(0), edges[0]);
  assert.equal(reads.filter(name => name.includes('fact_graph.nodes')).length, 1);

  const lineageKeys = analysisPayloadChunkKeys(withLineage.value).filter(name => name.includes('fact_lineage'));
  assert.ok(lineageKeys.length >= 2);
  assert.ok(withLineage.chunks.some(chunk => chunk.key === lineageKeys[0]));
  const assembled = await assembleAnalysisPayload(withLineage.value, load) as Record<string, unknown>;
  assert.equal('fact_lineage' in assembled, false);
  assert.deepEqual(assembled, await assembleAnalysisPayload(legacy.value, load));
  // Older readers see only the established graph descriptors.
  assert.equal(parseAnalysisPayloadEnvelope(withLineage.value)!.chunks.some(chunk => String(chunk.path).startsWith('fact_lineage')), false);
});

test('lineage whose row count differs from the published graph is rejected', async () => {
  const nodes = Array.from({ length: 2100 }, (_, index) => ({ id: `n${index}`, attributes: { path: 'a.ts' }, evidence: [], members: [] }));
  const bodies = new Map<string, Uint8Array>();
  const prepared = await prepareStoredAnalysisPayload({ fact_graph: { nodes, edges: [] } },
    (path, index, sha) => `c/${path}-${index}-${sha}`, async (key, body) => {
      bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
    });
  const envelope = structuredClone(prepared.value) as { payload: { fact_lineage: { node_count: number; nodes: Array<{ count: number }> } } };
  envelope.payload.fact_lineage.node_count -= 1;
  envelope.payload.fact_lineage.nodes[0]!.count -= 1;
  await assert.rejects(visitAnalysisFactLineage(envelope, async key => bodies.get(key) ?? null,
    { node: () => {}, edge: () => {} }), /analysis_fact_lineage_invalid/);
});
