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

export interface AnalysisPayloadChunkDescriptor {
  path: AnalysisPayloadChunkPath;
  index: number;
  key: string;
  bytes: number;
  sha256: string;
  count: number;
  /** Exact file paths permit a bounded lookup without loading the graph/cache. */
  file_paths?: string[];
}

export interface ChunkedAnalysisPayloadEnvelope {
  schema_version: typeof CHUNKED_ANALYSIS_PAYLOAD_SCHEMA;
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
  const envelope = chunks.length ? { schema_version: CHUNKED_ANALYSIS_PAYLOAD_SCHEMA, payload, chunks } : null;
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

function chunkKeyPart(path: AnalysisPayloadChunkPath): string {
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

function* chunkBodies(values: unknown[], path: AnalysisPayloadChunkPath): Generator<{ items: unknown[]; body: Uint8Array }> {
  let items: unknown[] = [], parts: string[] = [], bytes = 3;
  // Keep strings until the bounded chunk is ready. Allocating a native Buffer
  // for each tiny graph relation causes excessive GC during million-row saves.
  const flush = () => ({ items, body: Buffer.from('[' + parts.join(',') + ']\n', 'utf8') });
  for (const value of values) {
    // One unusually large record remains indivisible. Ordinary chunks are
    // bounded by bytes as well as count; 2,048 parsed files can be hundreds of MB.
    const body = JSON.stringify(value) ?? 'null', length = Buffer.byteLength(body, 'utf8');
    if (items.length && (items.length >= chunkSize(path) || bytes + length + 1 > ANALYSIS_PAYLOAD_CHUNK_BYTES)) {
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
  if (!row || row.schema_version !== CHUNKED_ANALYSIS_PAYLOAD_SCHEMA) return null;
  const payload = record(row.payload);
  if (!payload || !Array.isArray(row.chunks) || row.chunks.length > MAX_CHUNKS) {
    throw new Error("analysis_payload_manifest_invalid");
  }
  const descriptors = row.chunks.map(parseDescriptor);
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
    schema_version: CHUNKED_ANALYSIS_PAYLOAD_SCHEMA,
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
  keyForChunk: (path: AnalysisPayloadChunkPath, index: number, sha256: string) => string,
  put: (key: string, body: Uint8Array) => Promise<AnalysisPayloadStoredChunk>,
  concurrency = 4,
): Promise<StoredPreparedAnalysisPayload> {
  const root = record(value);
  if (!root) return { value, envelope: null, chunks: [] };

  const payload: Record<string, unknown> = { ...root };
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

  function* tasks() {
    for (const { path, values } of arrays) {
      let index = 0;
      for (const chunk of chunkBodies(values, path)) yield { path, index: index++, ...chunk };
    }
  }
  const prepared: Array<{ descriptor: AnalysisPayloadChunkDescriptor; stored: AnalysisPayloadStoredChunk }> = [];
  await forEachBounded(tasks(), concurrency, async (task, position) => {
    if (position >= MAX_CHUNKS) throw new Error("analysis_payload_chunk_limit_exceeded");
    const { items, body } = task;
    const sha256 = snapshotObjectDigest(body);
    const key = keyForChunk(task.path, task.index, sha256);
    if (!isSafeObjectKey(key)) throw new Error("analysis_payload_chunk_key_invalid");
    const descriptor: AnalysisPayloadChunkDescriptor = {
      path: task.path,
      index: task.index,
      key,
      bytes: body.byteLength,
      sha256,
      count: items.length,
      ...indexedPaths(task.path, items),
    };
    const stored = await put(key, body);
    if (stored.key !== key || stored.bytes !== descriptor.bytes || stored.sha256 !== descriptor.sha256) {
      throw new Error("analysis_payload_chunk_write_mismatch");
    }
    prepared[position] = { descriptor, stored };
  });
  const envelope: ChunkedAnalysisPayloadEnvelope = {
    schema_version: CHUNKED_ANALYSIS_PAYLOAD_SCHEMA,
    payload,
    chunks: prepared.map((item) => item.descriptor),
  };
  return {
    value: envelope,
    envelope,
    chunks: prepared.map((item) => item.stored),
  };
}

function verifiedChunkBody(body: Uint8Array | null, descriptor: AnalysisPayloadChunkDescriptor): Uint8Array {
  if (!body) throw new Error("analysis_payload_chunk_missing");
  if (body.byteLength !== descriptor.bytes || snapshotObjectDigest(body) !== descriptor.sha256) {
    throw new Error("analysis_payload_chunk_integrity_mismatch");
  }
  return body;
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
      parsed = JSON.parse(Buffer.from(verifiedChunkBody(await loadChunk(descriptor.key), descriptor)).toString("utf8"));
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
  for (const [path, items] of arrays) {
    const { parent, child } = pathParts(path);
    const parentValue = record(result[parent]);
    result[parent] = { ...(parentValue ?? {}), [child]: items };
  }
  return result;
}

export function analysisPayloadChunkKeys(value: unknown): string[] {
  return parseAnalysisPayloadEnvelope(value)?.chunks.map((chunk) => chunk.key) ?? [];
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
  const items: unknown = JSON.parse(Buffer.from(verifiedChunkBody(await loadChunk(descriptor.key), descriptor)).toString("utf8"));
  if (!Array.isArray(items) || items.length !== descriptor.count
    || items.some((item, index) => record(item)?.path !== descriptor.file_paths?.[index])) {
    throw new Error("analysis_payload_chunk_invalid");
  }
  return items.find(file => record(file)?.path === path) as StaticFileFacts ?? null;
}

export function defaultAnalysisChunkKey(
  prefix: string,
  path: AnalysisPayloadChunkPath,
  index: number,
  sha256: string,
): string {
  const cleanPrefix = prefix.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (cleanPrefix && !isSafeObjectKey(cleanPrefix)) throw new Error("analysis_payload_prefix_invalid");
  const suffix = `analysis-chunks/${chunkKeyPart(path)}-${index}-${sha256}.json`;
  return cleanPrefix ? `${cleanPrefix}/${suffix}` : suffix;
}
