import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_PAYLOAD_CHUNK_SIZE,
  ANALYSIS_PAYLOAD_CHUNK_BYTES,
  assembleAnalysisPayload,
  parseAnalysisPayloadEnvelope,
  prepareAnalysisPayload,
  prepareStoredAnalysisPayload,
  readStaticFileFacts,
} from "./analysis-payload.js";

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
  },2);
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
  assert.equal(prepared.chunks.length, 2);
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
  }, 2);
  assert.equal(result.chunks.length, 2);
  assert.deepEqual(result.value, prepareAnalysisPayload(original, key).value);
  assert.deepEqual(await assembleAnalysisPayload(result.value, async key => bodies.get(key) ?? null), original);
});
