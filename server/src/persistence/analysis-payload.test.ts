import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_PAYLOAD_CHUNK_SIZE,
  assembleAnalysisPayload,
  parseAnalysisPayloadEnvelope,
  prepareAnalysisPayload,
  prepareStoredAnalysisPayload,
} from "./analysis-payload.js";

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
    analysis_cache: { schema_version: "analysis-cache-v1", manifest: [], parsed_files: parsedFiles, lsp_results: [] },
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
