import { encodeAnalysisChunk, decodeAnalysisChunk, validChunkEncoding, type ChunkEncoding, type AnalysisPayloadWriteMetrics, type AnalysisPayloadReadMetrics } from './analysis-chunk-codec.js';
import { factChunkBodies, decodeFactChunk, FACT_CHUNK_FORMAT, type FactChunk } from './fact-chunk-dictionary.js';
import {
  FACT_LINEAGE_SCHEMA, createStringInterner, decodeEdgeLineage, decodeNodeLineage, edgeLineageRows, factNodePath,
  nodeLineageRows, type EdgeLineageRow, type NodeLineageRow,
} from './fact-lineage.js';
import { forEachBounded } from "./bounded-tasks.js";
import {
  snapshotObjectDigest,
} from "./snapshot-object-store.js";
import type { EvidenceSnapshot } from "../domain/snapshot.js";

export type StaticFileFacts = NonNullable<EvidenceSnapshot["static_analysis"]>["files"][number];

/**
 * Large repositories can produce hundreds of thousands of graph relations and
 * thousands of parsed-file cache entries. Keeping those arrays in one JSON
 * string hits the V8 string-size limit before the object store is involved.
 */
export const CHUNKED_ANALYSIS_PAYLOAD_SCHEMA = "analysis-payload-chunks-v1" as const;
export const COMPRESSED_ANALYSIS_PAYLOAD_SCHEMA = 'analysis-payload-chunks-v2' as const;
export const ANALYSIS_PAYLOAD_CHUNK_SIZE = 2_048;
export const ANALYSIS_PAYLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export type AnalysisPayloadChunkPath =
  | "fact_graph.nodes"
  | "fact_graph.edges"
  | "analysis_cache.syntax_files"
  | "static_analysis.files"
  | "analysis_cache.manifest"
  | "analysis_cache.parsed_files"
  | "analysis_cache.lsp_results";

const CHUNK_PATHS: readonly AnalysisPayloadChunkPath[] = [
  "fact_graph.nodes",
  "fact_graph.edges",
  "analysis_cache.syntax_files",
  "static_analysis.files",
  "analysis_cache.manifest",
  "analysis_cache.parsed_files",
  "analysis_cache.lsp_results",
];

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CHUNKS = 100_000;

export interface AnalysisPayloadChunkDescriptor extends ChunkEncoding {
  format?: typeof FACT_CHUNK_FORMAT;
  path: AnalysisPayloadChunkPath;
  index: number;
  key: string;
  bytes: number;
  sha256: string;
  count: number;
  /** Exact file paths permit a bounded lookup without loading the graph/cache. */
  file_paths?: string[];
}

export type FactLineageChunkPath = 'fact_lineage.nodes' | 'fact_lineage.edges';
export const FACT_LINEAGE_CHUNK_ROWS = 16_384;

export interface FactLineageChunkDescriptor extends ChunkEncoding {
  path: FactLineageChunkPath;
  index: number;
  key: string;
  bytes: number;
  sha256: string;
  count: number;
}

export interface FactLineageManifest {
  schema_version: typeof FACT_LINEAGE_SCHEMA;
  node_count: number;
  edge_count: number;
  nodes: FactLineageChunkDescriptor[];
  edges: FactLineageChunkDescriptor[];
}

export interface ChunkedAnalysisPayloadEnvelope {
  schema_version: typeof CHUNKED_ANALYSIS_PAYLOAD_SCHEMA | typeof COMPRESSED_ANALYSIS_PAYLOAD_SCHEMA;
  payload: Record<string, unknown>;
  chunks: AnalysisPayloadChunkDescriptor[];
}

export interface PreparedAnalysisPayloadChunk {
  descriptor: AnalysisPayloadChunkDescriptor;
  body: Uint8Array;
}

export interface PreparedAnalysisPayload {
  value: unknown;
  envelope: ChunkedAnalysisPayloadEnvelope | null;
  chunks: PreparedAnalysisPayloadChunk[];
}

export interface StoredPreparedAnalysisPayload {
  value: unknown;
  envelope: ChunkedAnalysisPayloadEnvelope | null;
  chunks: AnalysisPayloadStoredChunk[];
}

/** Cache objects are immutable and become reachable only with the final snapshot. */
export interface PreparedAnalysisCache {
  publicKey: string;
  snapshotId: string;
  payload: StoredPreparedAnalysisPayload;
  metrics?: AnalysisPayloadWriteMetrics;
}

export function mergePreparedAnalysisCache(
  analysis: StoredPreparedAnalysisPayload, cache: PreparedAnalysisCache | undefined,
  publicKey: string, snapshotId: string,
): StoredPreparedAnalysisPayload {
  if (!cache) return analysis;
  if (cache.publicKey !== publicKey || cache.snapshotId !== snapshotId) throw new Error('prepared_analysis_cache_identity_mismatch');
  const extra = cache.payload;
  const cacheValue = record(extra.envelope?.payload ?? extra.value);
  const value = record(analysis.envelope?.payload ?? analysis.value);
  if (!value || !cacheValue || Object.keys(cacheValue).some(key => key !== 'analysis_cache')
    || 'analysis_cache' in value || extra.envelope?.chunks.some(chunk => !chunk.path.startsWith('analysis_cache.')))
    throw new Error('prepared_analysis_cache_invalid');
  const payload = { ...value, ...cacheValue };
  const chunks = [...(analysis.envelope?.chunks ?? []), ...(extra.envelope?.chunks ?? [])]
    .sort((a,b) => CHUNK_PATHS.indexOf(a.path) - CHUNK_PATHS.indexOf(b.path) || a.index - b.index);
  const envelope = chunks.length ? { schema_version: chunks.some(chunk => chunk.encoding || chunk.format) ? COMPRESSED_ANALYSIS_PAYLOAD_SCHEMA : CHUNKED_ANALYSIS_PAYLOAD_SCHEMA, payload, chunks } : null;
  return { value: envelope ?? payload, envelope, chunks: [...analysis.chunks, ...extra.chunks] };
}

export interface AnalysisPayloadStoredChunk {
  key: string;
  bytes: number;
  sha256: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isChunkPath(value: unknown): value is AnalysisPayloadChunkPath {
  return typeof value === "string" && (CHUNK_PATHS as readonly string[]).includes(value);
}

function isSafeObjectKey(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized === value
    && !normalized.includes("\0")
    && !normalized.startsWith("/")
    && normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function pathParts(path: AnalysisPayloadChunkPath): { parent: "fact_graph" | "analysis_cache" | "static_analysis"; child: string } {
  const separator = path.indexOf(".");
  return {
    parent: path.slice(0, separator) as "fact_graph" | "analysis_cache" | "static_analysis",
    child: path.slice(separator + 1),
  };
}

function chunkKeyPart(path: AnalysisPayloadChunkPath | FactLineageChunkPath): string {
  return path.replace(".", "-");
}

function chunkSize(path: AnalysisPayloadChunkPath): number {
  return path === "static_analysis.files" ? 32 : ANALYSIS_PAYLOAD_CHUNK_SIZE;
}

function shouldChunk(values: unknown[], path: AnalysisPayloadChunkPath): boolean {
  if (!values.length) return false;
  if (path === "static_analysis.files" || values.length > chunkSize(path)) return true;
  let bytes = 3;
  for (let i = 0; i < values.length; i++) {
    bytes += Buffer.byteLength(JSON.stringify(values[i]) ?? "null", "utf8") + (i ? 1 : 0);
    if (bytes > ANALYSIS_PAYLOAD_CHUNK_BYTES) return true;
  }
  return false;
}

function indexedPaths(path: AnalysisPayloadChunkPath, items: unknown[]): { file_paths?: string[] } {
  return path === "static_analysis.files"
    ? { file_paths: items.map(item => String(record(item)?.path ?? "")) }
    : {};
}

function* chunkBodies(values: Iterable<unknown>, path: AnalysisPayloadChunkPath, maxRows = chunkSize(path)): Generator<{ items: unknown[]; body: Uint8Array }> {
  let items: unknown[] = [], parts: string[] = [], bytes = 3;
  // Keep strings until the bounded chunk is ready. Allocating a native Buffer
  // for each tiny graph relation causes excessive GC during million-row saves.
  const flush = () => ({ items, body: Buffer.from('[' + parts.join(',') + ']\n', 'utf8') });
  for (const value of values) {
    // One unusually large record remains indivisible. Ordinary chunks are
    // bounded by bytes as well as count; 2,048 parsed files can be hundreds of MB.
    const body = JSON.stringify(value) ?? 'null', length = Buffer.byteLength(body, 'utf8');
    if (items.length && (items.length >= maxRows || bytes + length + 1 > ANALYSIS_PAYLOAD_CHUNK_BYTES)) {
      yield flush(); items = []; parts = []; bytes = 3;
    }
    if (items.length) bytes++;
    items.push(value); parts.push(body); bytes += length;
  }
  if (items.length) yield flush();
}

function chunkArray(
  values: unknown[],
  path: AnalysisPayloadChunkPath,
  keyForChunk: (path: AnalysisPayloadChunkPath, index: number, sha256: string) => string,
): PreparedAnalysisPayloadChunk[] {
  const chunks: PreparedAnalysisPayloadChunk[] = [];
  let index = 0;
  for (const { items, body } of chunkBodies(values, path)) {
    const sha256 = snapshotObjectDigest(body);
    const key = keyForChunk(path, index, sha256);
    if (!isSafeObjectKey(key)) throw new Error("analysis_payload_chunk_key_invalid");
    chunks.push({
      descriptor: {
        path,
        index,
        key,
        bytes: body.byteLength,
        sha256,
        count: items.length,
        ...indexedPaths(path, items),
      },
      body,
    });
    index++;
  }
  return chunks;
}

/**
 * Prepare only the known high-cardinality arrays for independent storage.
 * Small analyses keep their historical single-object representation.
 */
export function prepareAnalysisPayload(
  value: unknown,
  keyForChunk: (path: AnalysisPayloadChunkPath, index: number, sha256: string) => string,
): PreparedAnalysisPayload {
  const root = record(value);
  if (!root) return { value, envelope: null, chunks: [] };

  const payload: Record<string, unknown> = { ...root };
  const chunks: PreparedAnalysisPayloadChunk[] = [];
  for (const path of CHUNK_PATHS) {
    const { parent, child } = pathParts(path);
    const parentValue = record(payload[parent]);
    const values = parentValue?.[child];
    if (!Array.isArray(values) || !shouldChunk(values, path)) continue;
    payload[parent] = { ...parentValue };
    delete (payload[parent] as Record<string, unknown>)[child];
    chunks.push(...chunkArray(values, path, keyForChunk));
  }
  if (!chunks.length) return { value, envelope: null, chunks: [] };

  const envelope: ChunkedAnalysisPayloadEnvelope = {
    schema_version: CHUNKED_ANALYSIS_PAYLOAD_SCHEMA,
    payload,
    chunks: chunks.map((item) => item.descriptor),
  };
  return { value: envelope, envelope, chunks };
}

function parseDescriptor(value: unknown): AnalysisPayloadChunkDescriptor {
  const row = record(value);
  if (!row
    || !validChunkEncoding(row)
    || (row.format !== undefined && (row.format !== FACT_CHUNK_FORMAT || !["fact_graph.nodes","fact_graph.edges"].includes(String(row.path))))
    || !isChunkPath(row.path)
    || !Number.isSafeInteger(row.index)
    || Number(row.index) < 0
    || typeof row.key !== "string"
    || !isSafeObjectKey(row.key)
    || !Number.isSafeInteger(row.bytes)
    || Number(row.bytes) < 0
    || typeof row.sha256 !== "string"
    || !SHA256.test(row.sha256)
    || !Number.isSafeInteger(row.count)
    || Number(row.count) < 0) {
    throw new Error("analysis_payload_manifest_invalid");
  }
  if (row.file_paths !== undefined && (row.path !== "static_analysis.files"
    || !Array.isArray(row.file_paths) || row.file_paths.length !== row.count
    || row.file_paths.some(path => typeof path !== "string" || !isSafeObjectKey(path)))) {
    throw new Error("analysis_payload_manifest_invalid");
  }
  return {
    ...(row.format ? { format: FACT_CHUNK_FORMAT } : {}),
    ...(row.encoding ? { encoding: row.encoding as 'gzip-json-v1', decoded_bytes: Number(row.decoded_bytes) } : {}),
    path: row.path,
    index: Number(row.index),
    key: row.key,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    count: Number(row.count),
    ...(row.file_paths === undefined ? {} : { file_paths: row.file_paths as string[] }),
  };
}

/** Return null for a historical, unchunked analysis object. */
export function parseAnalysisPayloadEnvelope(value: unknown): ChunkedAnalysisPayloadEnvelope | null {
  const row = record(value);
  if (!row || (row.schema_version !== CHUNKED_ANALYSIS_PAYLOAD_SCHEMA && row.schema_version !== COMPRESSED_ANALYSIS_PAYLOAD_SCHEMA)) return null;
  const payload = record(row.payload);
  if (!payload || !Array.isArray(row.chunks) || row.chunks.length > MAX_CHUNKS) {
    throw new Error("analysis_payload_manifest_invalid");
  }
  const descriptors = row.chunks.map(parseDescriptor);
  if (row.schema_version === CHUNKED_ANALYSIS_PAYLOAD_SCHEMA && descriptors.some(chunk => chunk.encoding || chunk.format)) throw new Error("analysis_payload_manifest_invalid");
  const seen = new Set<string>();
  const nextIndex = new Map<AnalysisPayloadChunkPath, number>();
  for (const descriptor of descriptors) {
    const identity = `${descriptor.path}:${descriptor.index}`;
    if (seen.has(identity)) throw new Error("analysis_payload_manifest_invalid");
    seen.add(identity);
    const expected = nextIndex.get(descriptor.path) ?? 0;
    if (descriptor.index !== expected) throw new Error("analysis_payload_manifest_invalid");
    nextIndex.set(descriptor.path, expected + 1);
  }
  return {
    schema_version: row.schema_version as ChunkedAnalysisPayloadEnvelope["schema_version"],
    payload,
    chunks: descriptors,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[], concurrency: number, operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  await forEachBounded(values, concurrency, async (value, index) => {
    result[index] = await operation(value);
  });
  return result;
}

export async function putAnalysisPayloadChunks(
  chunks: PreparedAnalysisPayloadChunk[],
  put: (key: string, body: Uint8Array) => Promise<AnalysisPayloadStoredChunk>,
  concurrency = 8,
): Promise<AnalysisPayloadStoredChunk[]> {
  return mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const stored = await put(chunk.descriptor.key, chunk.body);
    if (stored.key !== chunk.descriptor.key
      || stored.bytes !== chunk.descriptor.bytes
      || stored.sha256 !== chunk.descriptor.sha256) {
      throw new Error("analysis_payload_chunk_write_mismatch");
    }
    return stored;
  });
}

/**
 * Serialize and persist large arrays with bounded concurrency. Unlike the
 * legacy two-step helper, this never retains every serialized chunk body at
 * once, which keeps publication memory proportional to a few chunks instead
 * of the complete fact graph.
 */
export async function prepareStoredAnalysisPayload(
  value: unknown,
  keyForChunk: (path: AnalysisPayloadChunkPath | FactLineageChunkPath, index: number, sha256: string) => string,
  put: (key: string, body: Uint8Array) => Promise<AnalysisPayloadStoredChunk>,
  concurrency = 4,
  options: { compression?: boolean; factDictionary?: boolean; factLineage?: boolean; metrics?: AnalysisPayloadWriteMetrics } = {},
): Promise<StoredPreparedAnalysisPayload> {
  const prepareAt = performance.now();
  try {
  const root = record(value);
  if (!root) return { value, envelope: null, chunks: [] };

  const payload: Record<string, unknown> = { ...root };
  // Lineage always describes the graph written by this call, never a copy.
  delete payload.fact_lineage;
  const arrays: Array<{
    path: AnalysisPayloadChunkPath;
    values: unknown[];
  }> = [];
  for (const path of CHUNK_PATHS) {
    const { parent, child } = pathParts(path);
    const parentValue = record(payload[parent]);
    const values = parentValue?.[child];
    if (!Array.isArray(values) || !shouldChunk(values, path)) continue;
    payload[parent] = { ...parentValue };
    delete (payload[parent] as Record<string, unknown>)[child];
    arrays.push({ path, values });
  }
  if (!arrays.length) return { value, envelope: null, chunks: [] };
  const graph = record(root.fact_graph);
  const lineage = options.factLineage !== false && Array.isArray(graph?.nodes) && Array.isArray(graph?.edges)
    && arrays.some(item => item.path === 'fact_graph.nodes' || item.path === 'fact_graph.edges')
    ? { nodes: graph!.nodes as unknown[], edges: graph!.edges as unknown[] } : null;

  function* tasks(): Generator<{ path: AnalysisPayloadChunkPath | FactLineageChunkPath; index: number; items: unknown[]; body: Uint8Array; format?: FactChunk['format'] }> {
    for (const { path, values } of arrays) {
      let index = 0;
      const dictionary = options.factDictionary ?? (options.compression !== false && values.slice(0, 64).some(value => {
        const ids = record(record(value)?.incremental_provenance)?.affected_by_stable_ids;
        return Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && ids.every(id => typeof id === 'string');
      }));
      const iterator: Generator<FactChunk> = dictionary && (path === 'fact_graph.nodes' || path === 'fact_graph.edges')
        ? factChunkBodies(values, chunkSize(path), ANALYSIS_PAYLOAD_CHUNK_BYTES) : chunkBodies(values, path);
      for (;;) {
        const started = performance.now(); const next = iterator.next();
        if (options.metrics) options.metrics.encode_ms += performance.now() - started;
        if (next.done) break;
        yield { path, index: index++, ...next.value };
      }
    }
    if (!lineage) return;
    const streams = [
      ['fact_lineage.nodes', nodeLineageRows(lineage.nodes)],
      ['fact_lineage.edges', edgeLineageRows(lineage.edges, lineage.nodes)],
    ] as const;
    for (const [path, rows] of streams) {
      let index = 0;
      const iterator = chunkBodies(rows, 'fact_graph.nodes', FACT_LINEAGE_CHUNK_ROWS);
      for (;;) {
        const started = performance.now(); const next = iterator.next();
        if (options.metrics) options.metrics.encode_ms += performance.now() - started;
        if (next.done) break;
        yield { path, index: index++, ...next.value };
      }
    }
  }
  const prepared: Array<{ descriptor: AnalysisPayloadChunkDescriptor | FactLineageChunkDescriptor; stored: AnalysisPayloadStoredChunk }> = [];
  await forEachBounded(tasks(), concurrency, async (task, position) => {
    if (position >= MAX_CHUNKS) throw new Error("analysis_payload_chunk_limit_exceeded");
    const { items } = task;
    const compressionStarted = performance.now();
    const encoded = options.compression === false ? { body: task.body } : await encodeAnalysisChunk(task.body);
    const body = encoded.body;
    if (options.metrics) {
      options.metrics.compress_ms += performance.now() - compressionStarted;
      options.metrics.json_bytes += task.body.byteLength;
      options.metrics.stored_bytes += body.byteLength;
      options.metrics.chunks++;
      if (task.format) options.metrics.dictionary_chunks++;
    }
    const hashStarted = performance.now();
    const sha256 = snapshotObjectDigest(body);
    if (options.metrics) options.metrics.hash_ms += performance.now() - hashStarted;
    const key = keyForChunk(task.path, task.index, sha256);
    if (!isSafeObjectKey(key)) throw new Error("analysis_payload_chunk_key_invalid");
    const descriptor: AnalysisPayloadChunkDescriptor | FactLineageChunkDescriptor = {
      ...(encoded.encoding ? { encoding: encoded.encoding, decoded_bytes: encoded.decoded_bytes } : {}),
      ...(task.format ? { format: task.format } : {}),
      path: task.path,
      index: task.index,
      key,
      bytes: body.byteLength,
      sha256,
      count: items.length,
      ...(isChunkPath(task.path) ? indexedPaths(task.path, items) : {}),
    } as AnalysisPayloadChunkDescriptor | FactLineageChunkDescriptor;
    const putStarted = performance.now();
    const stored = await put(key, body);
    if (options.metrics) options.metrics.put_ms += performance.now() - putStarted;
    if (stored.key !== key || stored.bytes !== descriptor.bytes || stored.sha256 !== descriptor.sha256) {
      throw new Error("analysis_payload_chunk_write_mismatch");
    }
    prepared[position] = { descriptor, stored };
  });
  const graphChunks = prepared.map(item => item.descriptor).filter((item): item is AnalysisPayloadChunkDescriptor => isChunkPath(item.path));
  if (lineage) {
    // Kept outside `chunks` so older readers ignore it; purge still sees its keys.
    const lineageChunks = prepared.map(item => item.descriptor).filter((item): item is FactLineageChunkDescriptor => !isChunkPath(item.path));
    payload.fact_lineage = {
      schema_version: FACT_LINEAGE_SCHEMA,
      node_count: lineage.nodes.length,
      edge_count: lineage.edges.length,
      nodes: lineageChunks.filter(item => item.path === 'fact_lineage.nodes'),
      edges: lineageChunks.filter(item => item.path === 'fact_lineage.edges'),
    } satisfies FactLineageManifest;
  }
  const envelope: ChunkedAnalysisPayloadEnvelope = {
    schema_version: graphChunks.some(item => item.encoding || item.format) ? COMPRESSED_ANALYSIS_PAYLOAD_SCHEMA : CHUNKED_ANALYSIS_PAYLOAD_SCHEMA,
    payload,
    chunks: graphChunks,
  };
  return {
    value: envelope,
    envelope,
    chunks: prepared.map((item) => item.stored),
  };
  } finally { if (options.metrics) options.metrics.wall_ms += performance.now() - prepareAt; }
}

async function verifiedChunkBody(body: Uint8Array | null, descriptor: ChunkEncoding & { bytes: number; sha256: string }): Promise<Uint8Array> {
  if (!body) throw new Error("analysis_payload_chunk_missing");
  if (body.byteLength !== descriptor.bytes || snapshotObjectDigest(body) !== descriptor.sha256) {
    throw new Error("analysis_payload_chunk_integrity_mismatch");
  }
  return decodeAnalysisChunk(body, descriptor);
}

/** Reassemble a chunked object while validating every descriptor and body. */
export async function assembleAnalysisPayload(
  value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>,
  concurrency = 8,
): Promise<unknown> {
  const envelope = parseAnalysisPayloadEnvelope(value);
  if (!envelope) return value;
  const loaded = await mapWithConcurrency(envelope.chunks, concurrency, async (descriptor) => {
    let parsed: unknown;
    try {
      parsed = decodeFactChunk(JSON.parse(Buffer.from(await verifiedChunkBody(await loadChunk(descriptor.key), descriptor)).toString("utf8")), descriptor.format, descriptor.count);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("analysis_payload_chunk_")) throw error;
      throw new Error("analysis_payload_chunk_invalid");
    }
    if (!Array.isArray(parsed) || parsed.length !== descriptor.count) {
      throw new Error("analysis_payload_chunk_invalid");
    }
    return { descriptor, items: parsed };
  });

  const arrays = new Map<AnalysisPayloadChunkPath, unknown[]>();
  for (const item of loaded) {
    const target = arrays.get(item.descriptor.path) ?? [];
    target.push(...item.items);
    arrays.set(item.descriptor.path, target);
  }
  const result: Record<string, unknown> = { ...envelope.payload };
  // Lineage is an update index, not part of the published analysis shape.
  delete result.fact_lineage;
  for (const [path, items] of arrays) {
    const { parent, child } = pathParts(path);
    const parentValue = record(result[parent]);
    result[parent] = { ...(parentValue ?? {}), [child]: items };
  }
  return result;
}

/** Load only the previous compiler cache and fact graph needed for an update.
 * The publication view and per-file static facts can dwarf these inputs and
 * must not be resident while the new source is compiled.
 */
export async function assembleIncrementalBasePayload(
  value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>,
): Promise<{ analysis_cache: unknown; node_paths: Array<{ id: string; path: string | null }>; fact_graph_available: boolean }> {
  const envelope = parseAnalysisPayloadEnvelope(value);
  const root = record(envelope?.payload ?? value);
  if (!root) throw new Error("public_snapshot_payload_missing");
  const cache = { ...(record(root.analysis_cache) ?? {}) };
  const nodes: Array<{ id: string; path: string | null }> = [];
  const appendNodes = (items: unknown[]) => {
    for (const item of items) {
      const node = record(item);
      if (!node || typeof node.id !== "string") throw new Error("analysis_payload_chunk_invalid");
      nodes.push({ id: node.id, path: factNodePath(node) });
    }
  };
  const inlineNodes = record(root.fact_graph)?.nodes;
  const inlineEdges = record(root.fact_graph)?.edges;
  const factGraphAvailable = (Array.isArray(inlineNodes)
    || envelope?.chunks.some(chunk => chunk.path === "fact_graph.nodes") === true)
    && (Array.isArray(inlineEdges)
      || envelope?.chunks.some(chunk => chunk.path === "fact_graph.edges") === true);
  // Paths come from the compact lineage when published; full node rows otherwise.
  const lineage = envelope ? parseFactLineageManifest(envelope.payload) : null;
  if (Array.isArray(inlineNodes) && !lineage) appendNodes(inlineNodes);
  if (!envelope) return { analysis_cache: cache, node_paths: nodes, fact_graph_available: factGraphAvailable };
  if (lineage) {
    assertLineageMatchesGraph(lineage, envelope, root);
    await streamChunks(lineage.nodes, loadChunk, {}, (json, descriptor) =>
      decodeNodeLineage(json, descriptor.count, value => value), items => {
      for (const row of items as NodeLineageRow[]) nodes.push({ id: row[0], path: row[3] });
    });
  }
  for (const descriptor of envelope.chunks) {
    if ((lineage || descriptor.path !== "fact_graph.nodes") && !descriptor.path.startsWith("analysis_cache.")) continue;
    let items: unknown;
    try {
      items = decodeFactChunk(JSON.parse(Buffer.from(await verifiedChunkBody(await loadChunk(descriptor.key), descriptor)).toString("utf8")), descriptor.format, descriptor.count);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("analysis_payload_chunk_")) throw error;
      throw new Error("analysis_payload_chunk_invalid");
    }
    if (!Array.isArray(items) || items.length !== descriptor.count) throw new Error("analysis_payload_chunk_invalid");
    if (descriptor.path === "fact_graph.nodes") appendNodes(items);
    else {
      const { child } = pathParts(descriptor.path);
      const rows = Array.isArray(cache[child]) ? cache[child] as unknown[] : [];
      rows.push(...items);
      cache[child] = rows;
    }
  }
  return { analysis_cache: cache, node_paths: nodes, fact_graph_available: factGraphAvailable };
}

export interface AnalysisFactGraphVisitor {
  node: (value: unknown) => void;
  edge: (value: unknown) => void;
  metrics?: AnalysisPayloadReadMetrics;
  signal?: AbortSignal;
  /** Per-read prefetch, still subject to the shared object-store admission limit. */
  prefetchConcurrency?: number;
}

type StreamedDescriptor = ChunkEncoding & { key: string; bytes: number; sha256: string; count: number };

/** Fetch a bounded window concurrently, then decode and apply one chunk at a
 * time so several fully expanded arrays are never resident together. */
async function streamChunks<D extends StreamedDescriptor>(
  descriptors: readonly D[],
  loadChunk: (key: string) => Promise<Uint8Array | null>,
  options: { metrics?: AnalysisPayloadReadMetrics; signal?: AbortSignal; prefetchConcurrency?: number },
  decode: (json: unknown, descriptor: D) => unknown[],
  apply: (items: unknown[], descriptor: D) => void,
): Promise<void> {
  const { metrics, signal } = options;
  const concurrency = Number.isSafeInteger(options.prefetchConcurrency)
    ? Math.max(1, Math.min(4, options.prefetchConcurrency!)) : 4;
  for (let offset = 0; offset < descriptors.length;) {
    const window: D[] = []; let bytes = 0;
    while (offset < descriptors.length && window.length < concurrency) {
      const descriptor = descriptors[offset]!;
      const size = descriptor.decoded_bytes ?? descriptor.bytes;
      if (window.length && bytes + size > 16 * 1024 * 1024) break;
      window.push(descriptor); bytes += size; offset++;
    }
    if (metrics) metrics.max_window_bytes = Math.max(metrics.max_window_bytes, bytes);
    const loaded: Array<Uint8Array | null> = await mapWithConcurrency(window, concurrency, async descriptor => {
      signal?.throwIfAborted();
      const getAt = performance.now(); const body = await loadChunk(descriptor.key);
      if (metrics) metrics.get_ms += performance.now() - getAt;
      signal?.throwIfAborted();
      return body;
    });
    for (let index = 0; index < loaded.length; index++) {
      const body = loaded[index]!, descriptor = window[index]!; loaded[index] = null;
      signal?.throwIfAborted();
      const decodeAt = performance.now(); let items: unknown[];
      try {
        const decoded = await verifiedChunkBody(body, descriptor);
        items = decode(JSON.parse((Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded)).toString('utf8')), descriptor);
      } catch (error) {
        if (error instanceof Error && (error.message.startsWith('analysis_payload_chunk_') || error.message.startsWith('analysis_fact_lineage_'))) throw error;
        throw new Error('analysis_payload_chunk_invalid');
      }
      if (!Array.isArray(items) || items.length !== descriptor.count) throw new Error('analysis_payload_chunk_invalid');
      if (metrics) {
        metrics.decode_ms += performance.now() - decodeAt;
        metrics.stored_bytes += descriptor.bytes;
        metrics.decoded_bytes += descriptor.decoded_bytes ?? descriptor.bytes;
        metrics.chunks++;
      }
      const at = performance.now();
      apply(items, descriptor);
      if (metrics) metrics.visit_ms += performance.now() - at;
    }
  }
}

const decodeGraphChunk = (json: unknown, descriptor: AnalysisPayloadChunkDescriptor) =>
  decodeFactChunk(json, descriptor.format, descriptor.count);

/** Read only a bounded window; finish nodes before considering edge tombstones. */
export async function visitAnalysisFactGraph(value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>, visitor: AnalysisFactGraphVisitor): Promise<void> {
  const started = performance.now(), metrics = visitor.metrics;
  const envelope = parseAnalysisPayloadEnvelope(value);
  const graph = record(record(envelope?.payload ?? value)?.fact_graph);
  try {
    for (const path of ['fact_graph.nodes', 'fact_graph.edges'] as const) {
      visitor.signal?.throwIfAborted();
      const visit = path === 'fact_graph.nodes' ? visitor.node : visitor.edge;
      const inline = graph?.[path === 'fact_graph.nodes' ? 'nodes' : 'edges'];
      if (Array.isArray(inline)) for (const item of inline) visit(item);
      await streamChunks(envelope?.chunks.filter(chunk => chunk.path === path) ?? [], loadChunk, visitor,
        decodeGraphChunk, items => { for (const item of items) visit(item); });
    }
  } finally { if (metrics) metrics.wall_ms += performance.now() - started; }
}

function parseLineageDescriptors(value: unknown, path: FactLineageChunkPath, total: unknown): FactLineageChunkDescriptor[] {
  if (!Array.isArray(value) || value.length > MAX_CHUNKS || !Number.isSafeInteger(total) || Number(total) < 0) {
    throw new Error('analysis_fact_lineage_invalid');
  }
  let count = 0;
  const descriptors = value.map((item, index): FactLineageChunkDescriptor => {
    const row = record(item);
    if (!row || row.path !== path || row.index !== index || !validChunkEncoding(row)
      || typeof row.key !== 'string' || !isSafeObjectKey(row.key)
      || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0
      || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
      || !Number.isSafeInteger(row.count) || Number(row.count) < 0) throw new Error('analysis_fact_lineage_invalid');
    count += Number(row.count);
    return {
      ...(row.encoding ? { encoding: row.encoding as 'gzip-json-v1', decoded_bytes: Number(row.decoded_bytes) } : {}),
      path, index, key: row.key, bytes: Number(row.bytes), sha256: row.sha256, count: Number(row.count),
    };
  });
  if (count !== total) throw new Error('analysis_fact_lineage_invalid');
  return descriptors;
}

/** Null for snapshots published before lineage; malformed lineage is fatal. */
export function parseFactLineageManifest(payload: Record<string, unknown> | null | undefined): FactLineageManifest | null {
  const value = payload?.fact_lineage;
  if (value === undefined) return null;
  const row = record(value);
  if (!row || row.schema_version !== FACT_LINEAGE_SCHEMA) throw new Error('analysis_fact_lineage_invalid');
  return {
    schema_version: FACT_LINEAGE_SCHEMA,
    node_count: Number(row.node_count),
    edge_count: Number(row.edge_count),
    nodes: parseLineageDescriptors(row.nodes, 'fact_lineage.nodes', row.node_count),
    edges: parseLineageDescriptors(row.edges, 'fact_lineage.edges', row.edge_count),
  };
}

function graphRowCount(envelope: ChunkedAnalysisPayloadEnvelope, root: Record<string, unknown>, path: 'fact_graph.nodes' | 'fact_graph.edges'): number {
  const inline = record(root.fact_graph)?.[path === 'fact_graph.nodes' ? 'nodes' : 'edges'];
  return (Array.isArray(inline) ? inline.length : 0)
    + envelope.chunks.filter(chunk => chunk.path === path).reduce((sum, chunk) => sum + chunk.count, 0);
}

function assertLineageMatchesGraph(lineage: FactLineageManifest, envelope: ChunkedAnalysisPayloadEnvelope, root: Record<string, unknown>): void {
  if (lineage.node_count !== graphRowCount(envelope, root, 'fact_graph.nodes')
    || lineage.edge_count !== graphRowCount(envelope, root, 'fact_graph.edges')) {
    throw new Error('analysis_fact_lineage_invalid');
  }
}

export interface AnalysisFactLineageVisitor {
  node: (row: NodeLineageRow, ordinal: number) => void;
  edge: (row: EdgeLineageRow, ordinal: number) => void;
  metrics?: AnalysisPayloadReadMetrics;
  signal?: AbortSignal;
}

/** Visit compact lineage in fact-graph order. Returns false when the snapshot
 * predates lineage, so the caller can fall back to a full graph scan. */
export async function visitAnalysisFactLineage(value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>, visitor: AnalysisFactLineageVisitor): Promise<boolean> {
  const envelope = parseAnalysisPayloadEnvelope(value);
  if (!envelope) return false;
  const lineage = parseFactLineageManifest(envelope.payload);
  if (!lineage) return false;
  assertLineageMatchesGraph(lineage, envelope, envelope.payload);
  const started = performance.now(), intern = createStringInterner();
  try {
    let ordinal = 0;
    await streamChunks(lineage.nodes, loadChunk, visitor, (json, descriptor) => decodeNodeLineage(json, descriptor.count, intern),
      items => { for (const row of items as NodeLineageRow[]) visitor.node(row, ordinal++); });
    ordinal = 0;
    await streamChunks(lineage.edges, loadChunk, visitor, (json, descriptor) => decodeEdgeLineage(json, descriptor.count, intern),
      items => {
        for (const row of items as EdgeLineageRow[]) {
          if (typeof row[3] === 'number' && row[3] >= lineage.node_count
            || typeof row[4] === 'number' && row[4] >= lineage.node_count) throw new Error('analysis_fact_lineage_invalid');
          visitor.edge(row, ordinal++);
        }
      });
    return true;
  } finally { if (visitor.metrics) visitor.metrics.wall_ms += performance.now() - started; }
}

/** Load complete fact rows by graph ordinal, fetching only the covering chunks. */
export async function readAnalysisFactRows(value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>,
  request: { nodes: readonly number[]; edges: readonly number[] },
  options: { metrics?: AnalysisPayloadReadMetrics; signal?: AbortSignal } = {},
): Promise<{ nodes: Map<number, unknown>; edges: Map<number, unknown> }> {
  const envelope = parseAnalysisPayloadEnvelope(value);
  const graph = record(record(envelope?.payload ?? value)?.fact_graph);
  const result = { nodes: new Map<number, unknown>(), edges: new Map<number, unknown>() };
  for (const [kind, path] of [['nodes', 'fact_graph.nodes'], ['edges', 'fact_graph.edges']] as const) {
    const wanted = new Set(request[kind]);
    if (!wanted.size) continue;
    const inline = graph?.[kind];
    let start = 0;
    if (Array.isArray(inline)) {
      for (const ordinal of wanted) if (ordinal < inline.length) result[kind].set(ordinal, inline[ordinal]);
      start = inline.length;
    }
    const selected: Array<AnalysisPayloadChunkDescriptor & { start: number }> = [];
    for (const descriptor of envelope?.chunks.filter(chunk => chunk.path === path) ?? []) {
      const end = start + descriptor.count;
      for (const ordinal of wanted) {
        if (ordinal >= start && ordinal < end) { selected.push({ ...descriptor, start }); break; }
      }
      start = end;
    }
    await streamChunks(selected, loadChunk, options, decodeGraphChunk, (items, descriptor) => {
      for (let index = 0; index < items.length; index++) {
        if (wanted.has(descriptor.start + index)) result[kind].set(descriptor.start + index, items[index]);
      }
    });
    if (result[kind].size !== wanted.size) throw new Error('analysis_fact_lineage_invalid');
  }
  return result;
}

export function analysisPayloadChunkKeys(value: unknown): string[] {
  const envelope = parseAnalysisPayloadEnvelope(value);
  if (!envelope) return [];
  const lineage = parseFactLineageManifest(envelope.payload);
  return [...envelope.chunks, ...(lineage?.nodes ?? []), ...(lineage?.edges ?? [])].map((chunk) => chunk.key);
}

/** Read just the indexed static-fact block; never hydrate graph or cache arrays. */
export async function readStaticFileFacts(
  value: unknown,
  loadChunk: (key: string) => Promise<Uint8Array | null>,
  path: string,
): Promise<StaticFileFacts | null> {
  if (!isSafeObjectKey(path)) throw new Error("static_file_path_invalid");
  const envelope = parseAnalysisPayloadEnvelope(value);
  const inline = record(record(envelope?.payload ?? value)?.static_analysis)?.files;
  if (Array.isArray(inline)) return inline.find(file => record(file)?.path === path) ?? null;
  const descriptor = envelope?.chunks.find(chunk => chunk.path === "static_analysis.files" && chunk.file_paths?.includes(path));
  if (!descriptor) return null;
  const items: unknown = decodeFactChunk(JSON.parse(Buffer.from(await verifiedChunkBody(await loadChunk(descriptor.key), descriptor)).toString("utf8")), descriptor.format, descriptor.count);
  if (!Array.isArray(items) || items.length !== descriptor.count
    || items.some((item, index) => record(item)?.path !== descriptor.file_paths?.[index])) {
    throw new Error("analysis_payload_chunk_invalid");
  }
  return items.find(file => record(file)?.path === path) as StaticFileFacts ?? null;
}

export function defaultAnalysisChunkKey(
  prefix: string,
  path: AnalysisPayloadChunkPath | FactLineageChunkPath,
  index: number,
  sha256: string,
): string {
  const cleanPrefix = prefix.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (cleanPrefix && !isSafeObjectKey(cleanPrefix)) throw new Error("analysis_payload_prefix_invalid");
  const suffix = `analysis-chunks/${chunkKeyPart(path)}-${index}-${sha256}.json`;
  return cleanPrefix ? `${cleanPrefix}/${suffix}` : suffix;
}
