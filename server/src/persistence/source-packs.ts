import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { snapshotObjectDigest, verifySourceSnapshotObject,
  type SnapshotObjectStore, type SourceSnapshotManifestFile, type StoredObject } from './snapshot-object-store.js';

// Match the acquisition file limit. Bound raw input per pack, not process RSS:
// compression and concatenation can temporarily retain multiple copies.
export const SOURCE_PACK_BYTES = 4 * 1024 * 1024;
export const SOURCE_PACK_FILES = 1024;
const compress = promisify(gzip), decompress = promisify(gunzip);
type SourceFile = { path: string; absolute: string; bytes: number };

async function mapBounded<T, R>(values: T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0, failed = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await operation(values[index], index); }
      catch (error) { failed = true; throw error; }
    }
  });
  const completed = await Promise.allSettled(workers);
  const failure = completed.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}

export async function packSourceFiles(
  input: { objectStore: SnapshotObjectStore; publicKey: string; concurrency?: number; signal?: AbortSignal },
  files: SourceFile[],
): Promise<{ descriptors: SourceSnapshotManifestFile[]; packs: StoredObject[] }> {
  const concurrency = input.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('source_snapshot_concurrency_invalid');
  const groups: SourceFile[][] = [];
  let group: SourceFile[] = [], bytes = 0;
  for (const file of files) {
    input.signal?.throwIfAborted();
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > SOURCE_PACK_BYTES) throw new Error('source_snapshot_file_too_large');
    if (group.length && (bytes + file.bytes > SOURCE_PACK_BYTES || group.length >= SOURCE_PACK_FILES)) {
      groups.push(group); group = []; bytes = 0;
    }
    group.push(file); bytes += file.bytes;
  }
  if (group.length) groups.push(group);
  const packed = await mapBounded(groups, concurrency, async (entries, ordinal) => {
    input.signal?.throwIfAborted();
    const contents = await mapBounded(entries, 8, async file => {
      input.signal?.throwIfAborted();
      const body = await readFile(file.absolute);
      if (body.byteLength !== file.bytes) throw new Error('source_snapshot_changed_during_upload');
      input.signal?.throwIfAborted();
      // Tiny files usually grow with gzip framing; avoid unnecessary CPU and bytes.
      const zipped = body.byteLength >= 128 ? await compress(body, { level: 3 }) : body;
      const compressed = zipped.byteLength < body.byteLength;
      return { path: file.path, bytes: body.byteLength, sha256: snapshotObjectDigest(body),
        encoding: compressed ? 'gzip' as const : 'identity' as const, body: compressed ? zipped : body };
    });
    input.signal?.throwIfAborted();
    const body = Buffer.concat(contents.map(file => file.body));
    const sha256 = snapshotObjectDigest(body);
    const key = `public-repository-snapshots/${input.publicKey}/source-packs/${ordinal}-${sha256}.bin`;
    const stored = await input.objectStore.put(key, body, 'application/octet-stream');
    input.signal?.throwIfAborted();
    if (stored.key !== key || stored.bytes !== body.byteLength || stored.sha256 !== sha256) throw new Error('source_snapshot_object_write_mismatch');
    let offset = 0;
    const descriptors = contents.map(file => {
      const descriptor = { path: file.path, key, bytes: file.bytes, sha256: file.sha256,
        offset, stored_bytes: file.body.byteLength, encoding: file.encoding };
      offset += file.body.byteLength;
      return descriptor;
    });
    return { stored, descriptors };
  });
  return { descriptors: packed.flatMap(pack => pack.descriptors), packs: packed.map(pack => pack.stored) };
}

/** Range-capable stores transfer only one independently encoded file, not its pack. */
export async function readSourceSnapshotFile(store: SnapshotObjectStore, file: SourceSnapshotManifestFile): Promise<Uint8Array> {
  if (file.offset === undefined) return verifySourceSnapshotObject(await store.get(file.key), file);
  const offset = file.offset, length = file.stored_bytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || !Number.isSafeInteger(offset + length) || offset + length > SOURCE_PACK_BYTES
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > SOURCE_PACK_BYTES
    || (file.encoding !== 'identity' && file.encoding !== 'gzip')) throw new Error('source_snapshot_manifest_invalid');
  let encoded: Uint8Array | null;
  if (length === 0) encoded = new Uint8Array();
  else if (store.getRange) encoded = await store.getRange(file.key, offset, length);
  else {
    // Custom/test adapters may lack ranges. Production local/COS adapters have them.
    const body = await store.get(file.key);
    encoded = body ? body.subarray(offset, offset + length) : null;
  }
  if (!encoded) throw new Error('source_snapshot_object_missing');
  if (encoded.byteLength !== length) throw new Error('source_snapshot_object_integrity_mismatch');
  let body: Uint8Array;
  try { body = file.encoding === 'gzip' ? await decompress(encoded, { maxOutputLength: Math.max(1, file.bytes) }) : encoded; }
  catch { throw new Error('source_snapshot_object_integrity_mismatch'); }
  return verifySourceSnapshotObject(body, file);
}
