import { gzipSync, gunzipSync } from 'node:zlib';
import type { SnapshotQueryDirectory, SnapshotQueryDirectorySource } from '../domain/snapshot-query.js';
import { snapshotObjectDigest, type SnapshotObjectStore, type StoredObject } from './snapshot-object-store.js';
import { forEachBounded } from './bounded-tasks.js';

export const DIRECTORY_SECTIONS = ['nodes','edges','evidence','evidence_links','layers','value_points','memberships','projections','aggregates'] as const;
export type DirectorySection = (typeof DIRECTORY_SECTIONS)[number];
export interface DirectoryChunk extends StoredObject { start: number; count: number; }
export interface DirectoryObjectManifest { version: 1; sections: Record<DirectorySection, DirectoryChunk[]>; }
// A large single row is isolated; ordinary reads fetch at most 256 KiB per
// chunk before compression. The reader enforces a hard decompression limit.
const CHUNK_BYTES = 256 * 1024;
const MAX_ROW_BYTES = 32 * 1024 * 1024;

export async function writeDirectoryObjects(store: SnapshotObjectStore, directory: SnapshotQueryDirectorySource,
  generationId: string, checkpoint?: (manifest: DirectoryObjectManifest, planned?: DirectoryChunk) => Promise<void>): Promise<DirectoryObjectManifest> {
  const manifest: DirectoryObjectManifest = { version: 1, sections: Object.fromEntries(DIRECTORY_SECTIONS.map(name=>[name,[] as DirectoryChunk[]])) as DirectoryObjectManifest['sections'] };
  const pending = new Set<Promise<void>>();
  let failed = false, failure: unknown;
  try {
    for (const section of DIRECTORY_SECTIONS) {
      let rows: string[] = [], bytes = 2, start = 0;
      const flush = async () => {
        if (!rows.length) return;
        // Apply backpressure before compression: retain at most four compressed
        // bodies plus the current row builder, even when storage is slow.
        while (pending.size >= 4 && !failed) await Promise.race(pending);
        if (failed) throw failure;
        const body = gzipSync('[' + rows.join(',') + ']');
        const digest = snapshotObjectDigest(body);
        const key = `public-repository-snapshots/${directory.public_snapshot_key}/directory/${generationId}/${section}/${start}-${digest}.json.gz`;
        // Commit ownership before uploading. A failed or interrupted PUT may have
        // reached durable storage; cleanup must already know its exact key.
        const descriptor={key,bytes:body.byteLength,sha256:digest,start,count:rows.length};
        manifest.sections[section].push(descriptor);
        await checkpoint?.(manifest,descriptor);
        if (failed) throw failure;
        start += rows.length; rows = []; bytes = 2;
        const upload = (async () => {
          const stored = await store.put(key, body, 'application/gzip');
          if (stored.key !== key || stored.sha256 !== digest || stored.bytes !== body.byteLength) throw new Error('snapshot_directory_object_write_invalid');
        })().catch(error => {
          if (!failed) { failed = true; failure = error; }
        }).finally(() => { pending.delete(upload); });
        pending.add(upload);
      };
      for (const row of directory[section] ?? []) {
        if (section === 'evidence_links' && 'owner_kind' in row && (row.owner_kind === 'node' || row.owner_kind === 'edge')) continue;
        const encoded = JSON.stringify(row), size = Buffer.byteLength(encoded);
        if (size > MAX_ROW_BYTES) throw new Error('snapshot_directory_row_too_large');
        if (rows.length && (bytes + size + 1 > CHUNK_BYTES || rows.length >= 512)) await flush();
        rows.push(encoded); bytes += size + 1;
      }
      await flush();
    }
    await Promise.all(pending);
    if (failed) throw failure;
    await checkpoint?.(manifest);
    return manifest;
  } catch (error) {
    // Cleanup must never race an admitted PUT, including when serialization or
    // the durable intent checkpoint fails while earlier uploads are in flight.
    await Promise.all(pending);
    throw error;
  }
}

export function parseDirectoryManifest(value: unknown, expected?: { publicKey: string; directoryId: string }): DirectoryObjectManifest {
  const manifest = value as DirectoryObjectManifest;
  if (manifest?.version !== 1 || !manifest.sections) throw new Error('snapshot_directory_reanalysis_required');
  let namespace = expected ? `public-repository-snapshots/${expected.publicKey}/directory/${expected.directoryId}/` : undefined;
  for (const section of DIRECTORY_SECTIONS) {
    const chunks = manifest.sections[section];
    if (!Array.isArray(chunks)) throw new Error('snapshot_directory_manifest_invalid');
    let start = 0;
    for (const chunk of chunks) {
      if (!chunk || chunk.start !== start || !Number.isSafeInteger(chunk.count) || chunk.count <= 0
        || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || !/^[a-f0-9]{64}$/.test(chunk.sha256)
        || typeof chunk.key !== 'string') throw new Error('snapshot_directory_manifest_invalid');
      const key = /^(public-repository-snapshots\/[a-f0-9]{64}\/directory\/[1-9][0-9]*\/)([a-z_]+)\/(0|[1-9][0-9]*)-([a-f0-9]{64})\.json\.gz$/.exec(chunk.key);
      if (!key || (namespace !== undefined && key[1] !== namespace) || key[2] !== section
        || key[3] !== String(chunk.start) || key[4] !== chunk.sha256
        || !Number.isSafeInteger(start + chunk.count)) throw new Error('snapshot_directory_manifest_invalid');
      namespace ??= key[1];
      start += chunk.count;
    }
  }
  return manifest;
}

/** Loads each covering object once per request, never a complete snapshot. */
export async function readDirectoryRows<K extends DirectorySection>(store: SnapshotObjectStore, manifest: DirectoryObjectManifest,
  section: K, ordinals?: readonly number[]): Promise<SnapshotQueryDirectory[K]> {
  const chunks = manifest.sections[section];
  const load = async (chunk: DirectoryChunk): Promise<unknown[]> => {
    const body=await store.get(chunk.key);
    if(!body || body.byteLength!==chunk.bytes || snapshotObjectDigest(body)!==chunk.sha256) throw new Error('snapshot_directory_object_corrupt');
    const decoded=JSON.parse(gunzipSync(body,{maxOutputLength:MAX_ROW_BYTES+2}).toString('utf8')) as unknown[];
    if(!Array.isArray(decoded)||decoded.length!==chunk.count) throw new Error('snapshot_directory_object_corrupt');
    return decoded;
  };
  if (ordinals === undefined) {
    // Full metadata reads need the rows, not additional per-row ordinal arrays
    // and maps. Write directly into the result while at most four chunks decode.
    const rows: unknown[] = [];
    await forEachBounded(chunks, 4, async chunk => {
      const decoded = await load(chunk);
      for (let index = 0; index < decoded.length; index++) rows[chunk.start + index] = decoded[index];
    });
    return rows as SnapshotQueryDirectory[K];
  }
  const selected = new Map<DirectoryChunk, number[]>();
  for (const ordinal of ordinals) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('snapshot_directory_locator_invalid');
    let low = 0, high = chunks.length - 1;
    while (low <= high) { const mid = (low+high)>>>1; if (chunks[mid]!.start <= ordinal) low=mid+1; else high=mid-1; }
    const chunk = chunks[high];
    if (!chunk || ordinal >= chunk.start+chunk.count) throw new Error('snapshot_directory_locator_invalid');
    const members=selected.get(chunk)??[];members.push(ordinal);selected.set(chunk,members);
  }
  const rows = new Map<number, unknown>();
  await forEachBounded(selected, 4, async ([chunk, members]) => {
    const decoded = await load(chunk);
    for(const ordinal of members)rows.set(ordinal,decoded[ordinal-chunk.start]);
  });
  return ordinals.map(ordinal=>rows.get(ordinal)) as SnapshotQueryDirectory[K];
}
