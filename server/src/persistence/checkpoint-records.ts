import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { projectCheckpointHeader } from './checkpoint-projection.js';

export interface CheckpointDescriptor { bytes: number; sha256: string }
type ArrayPart = { path: Array<string | number>; values: unknown[] };
const MAGIC = Buffer.from('WTRCP2\n');

/** Keep compiler caches and graph arrays out of a single repository-sized buffer. */
export async function writeCheckpointRecords(path: string, value: unknown): Promise<CheckpointDescriptor> {
  const arrays: ArrayPart[] = [], seen = new WeakMap<object, unknown>();
  const split = (value: unknown, path: Array<string | number>): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value) && value.length >= 128) {
      const placeholder: unknown[] = []; seen.set(value, placeholder);
      arrays.push({ path, values: value }); return placeholder;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Object.keys(value)) Object.defineProperty(copy, key, {
      value: split((value as Record<string, unknown>)[key], [...path, Array.isArray(value) ? Number(key) : key]),
      enumerable: true, writable: true, configurable: true,
    });
    return copy;
  };
  const root = split(value, []);
  const file = await open(path, 'wx');
  const hash = createHash('sha256'); let bytes = 0, pendingBytes = 0;
  let pending: Buffer[] = [];
  const flush = async () => {
    while (pending.length) {
      const { bytesWritten } = await file.writev(pending);
      if (!bytesWritten) throw new Error('analysis_checkpoint_write_failed');
      let used = bytesWritten;
      while (pending.length && used >= pending[0]!.length) used -= pending.shift()!.length;
      if (used) pending[0] = pending[0]!.subarray(used);
    }
    pendingBytes = 0;
  };
  const append = (buffer: Buffer) => { hash.update(buffer); bytes += buffer.length; pendingBytes += buffer.length; pending.push(buffer); };
  const frame = async (value: unknown) => {
    const body = serialize(value), length = Buffer.allocUnsafe(4); length.writeUInt32LE(body.length);
    append(length); append(body);
    if (pendingBytes >= 4 * 1024 * 1024 || pending.length >= 256) await flush();
  };
  try {
    append(MAGIC);
    await frame({ root, arrays: arrays.map(part => ({ path: part.path, length: part.values.length })) });
    for (const part of arrays) for (const item of part.values) await frame(item);
    await flush(); await file.close();
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await file.close().catch(() => undefined); await rm(path, { force: true }).catch(() => undefined); throw error;
  }
}

export interface CheckpointReadOptions {
  /** Decode only these root fields; all framed bytes are still checksummed. */
  includeRootFields?: readonly string[];
  signal?: AbortSignal;
}

export async function readCheckpointRecords(path: string, expected: CheckpointDescriptor,
  options: CheckpointReadOptions = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error('analysis_checkpoint_payload_invalid');
  }
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal: options.signal });
  const iterator = stream[Symbol.asyncIterator]();
  const hash = createHash('sha256'); let bytes = 0, consumed = 0, buffer: Buffer = Buffer.alloc(0), offset = 0;
  const next = async () => {
    options.signal?.throwIfAborted();
    const chunk = await iterator.next();
    if (chunk.done) return false;
    buffer = chunk.value as Buffer; offset = 0; bytes += buffer.length; hash.update(buffer); return true;
  };
  const take = async (length: number): Promise<Buffer> => {
    if (!Number.isSafeInteger(length) || length < 0 || consumed + length > expected.bytes) throw new Error('analysis_checkpoint_payload_invalid');
    consumed += length;
    if (buffer.length - offset >= length) { const value = buffer.subarray(offset, offset + length); offset += length; return value; }
    const value = Buffer.allocUnsafe(length); let written = 0;
    while (written < length) {
      if (offset === buffer.length && !await next()) throw new Error('analysis_checkpoint_payload_invalid');
      const count = Math.min(length - written, buffer.length - offset);
      buffer.copy(value, written, offset, offset + count); offset += count; written += count;
    }
    return value;
  };
  const skip = async (length: number): Promise<void> => {
    if (!Number.isSafeInteger(length) || length <= 0 || consumed + length > expected.bytes) throw new Error('analysis_checkpoint_payload_invalid');
    consumed += length;
    while (length > 0) {
      if (offset === buffer.length && !await next()) throw new Error('analysis_checkpoint_payload_invalid');
      const count = Math.min(length, buffer.length - offset);
      offset += count; length -= count;
    }
  };
  const frame = async () => deserialize(await take((await take(4)).readUInt32LE()));
  let value: unknown, failure: unknown;
  try {
    try {
      if (!(await take(MAGIC.length)).equals(MAGIC)) throw new Error('analysis_checkpoint_payload_invalid');
      const header = await frame() as { root?: unknown; arrays?: Array<{ path: Array<string | number>; length: number }> };
      if (!header || !Array.isArray(header.arrays)) throw new Error('analysis_checkpoint_payload_invalid');
      const projection = projectCheckpointHeader(header.root, header.arrays, expected.bytes, options.includeRootFields);
      value = projection.value;
      for (const part of projection.arrays) {
        for (let index = 0; index < part.length; index++) {
          if (part.retained) part.target.push(await frame());
          else await skip((await take(4)).readUInt32LE());
        }
      }
      if (consumed !== expected.bytes) throw new Error('analysis_checkpoint_payload_invalid');
    } catch (error) { failure = error; }
    options.signal?.throwIfAborted();
    if ((failure as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw failure;
    // Validate the entire immutable file before exposing even partially decoded data.
    while (await next()) { /* checksum the unread tail after a malformed frame */ }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('analysis_checkpoint_integrity_mismatch');
    if (failure) throw new Error('analysis_checkpoint_payload_invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('analysis_checkpoint_payload_missing');
    throw error;
  } finally { stream.destroy(); }
}
