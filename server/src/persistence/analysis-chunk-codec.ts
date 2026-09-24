import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const MAX_COMPRESSED_CHUNK_DECODED_BYTES = 64 * 1024 * 1024;
export interface ChunkEncoding { encoding?: 'gzip-json-v1'; decoded_bytes?: number }

/** Keep JSON bytes exactly reversible; never discard provenance or alter facts.
 * Large indivisible records retain the existing raw representation.
 */
export async function encodeAnalysisChunk(body: Uint8Array): Promise<{ body: Uint8Array } & ChunkEncoding> {
  if (body.byteLength < 64 * 1024 || body.byteLength > MAX_COMPRESSED_CHUNK_DECODED_BYTES) return { body };
  const compressed = await compress(body, { level: 1 });
  if (compressed.byteLength >= body.byteLength * 0.9) return { body };
  return { body: compressed, encoding: 'gzip-json-v1', decoded_bytes: body.byteLength };
}

export function validChunkEncoding(value: { encoding?: unknown; decoded_bytes?: unknown }): boolean {
  return value.encoding === undefined ? value.decoded_bytes === undefined
    : value.encoding === 'gzip-json-v1' && Number.isSafeInteger(value.decoded_bytes)
      && Number(value.decoded_bytes) > 0 && Number(value.decoded_bytes) <= MAX_COMPRESSED_CHUNK_DECODED_BYTES;
}

export async function decodeAnalysisChunk(body: Uint8Array, encoding: ChunkEncoding): Promise<Uint8Array> {
  if (!validChunkEncoding(encoding)) throw new Error('analysis_payload_manifest_invalid');
  if (!encoding.encoding) return body;
  try {
    const decoded = await decompress(body, { maxOutputLength: encoding.decoded_bytes });
    if (decoded.byteLength !== encoding.decoded_bytes) throw new Error('length mismatch');
    return decoded;
  } catch {
    throw new Error('analysis_payload_chunk_invalid');
  }
}

export interface AnalysisPayloadWriteMetrics {
  encode_ms: number; compress_ms: number; hash_ms: number; put_ms: number;
  /** json_bytes counts the actual pre-compression representation, including dictionary encoding. */
  json_bytes: number; stored_bytes: number; chunks: number; wall_ms: number; dictionary_chunks: number;
}
export const newAnalysisWriteMetrics = (): AnalysisPayloadWriteMetrics => ({
  encode_ms: 0, compress_ms: 0, hash_ms: 0, put_ms: 0, json_bytes: 0, stored_bytes: 0, chunks: 0, wall_ms: 0, dictionary_chunks: 0,
});
export interface AnalysisPayloadReadMetrics {
  get_ms: number; decode_ms: number; visit_ms: number; wall_ms: number;
  stored_bytes: number; decoded_bytes: number; chunks: number; max_window_bytes: number;
}
export const newAnalysisReadMetrics = (): AnalysisPayloadReadMetrics => ({
  get_ms: 0, decode_ms: 0, visit_ms: 0, wall_ms: 0,
  stored_bytes: 0, decoded_bytes: 0, chunks: 0, max_window_bytes: 0,
});
