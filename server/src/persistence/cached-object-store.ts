import { createHash } from 'node:crypto';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

export interface SnapshotObjectCacheOptions {
  maxBytes: number;
  maxEntryBytes: number;
  maxEntries?: number;
  maxInFlight?: number;
}

export interface CachedSnapshotObjectStore extends SnapshotObjectStore {
  /** Evict a reclaimed namespace; this does not delete durable objects. */
  invalidatePrefix(prefix: string): void;
  cacheStats(): { bytes: number; entries: number; inFlight: number };
}

type Entry = { key: string; body: Uint8Array };
type Flight = { key: string; result: Promise<Uint8Array | null> };

/** Only canonical content-addressed snapshot objects may outlive a read. */
function objectDigest(key: string): string | undefined {
  if (key.length > 2048 || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) return;
  return /^public-repository-snapshots\/.+\/(?:[^/]+-)?([a-f0-9]{64})\.(?:json(?:\.gz)?|bin)$/.exec(key)?.[1];
}

function assertRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0
    || !Number.isSafeInteger(offset + length)) throw new Error('snapshot_object_range_invalid');
}

/**
 * Disposable, process-local cache. Durable metadata/leases still decide whether a
 * snapshot can be read. Place outside the request limiter so hits need no permit.
 * Both metadata maps have explicit caps, including empty and oversized objects.
 */
export function cachedObjectStore(store: SnapshotObjectStore, options: SnapshotObjectCacheOptions): CachedSnapshotObjectStore {
  const { maxBytes, maxEntryBytes, maxEntries = 1024, maxInFlight = 128 } = options;
  for (const value of [maxBytes, maxEntryBytes, maxEntries, maxInFlight]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('snapshot_object_cache_limit_invalid');
  }
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  let bytes = 0;
  // A single generation token avoids retaining a version record per deleted key.
  let generation = {};

  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (entry) { bytes -= entry.body.byteLength; entries.delete(id); }
  };
  const invalidate = (matches: (key: string) => boolean): void => {
    generation = {};
    for (const [id, entry] of entries) if (matches(entry.key)) remove(id);
    for (const [id, flight] of flights) if (matches(flight.key)) flights.delete(id);
  };
  const touch = (id: string): Uint8Array | undefined => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); entries.set(id, entry);
    return entry.body;
  };
  const remember = (id: string, key: string, body: Uint8Array): void => {
    if (!maxEntries || !maxBytes || body.byteLength > Math.min(maxBytes, maxEntryBytes)) return;
    remove(id);
    while (entries.size >= maxEntries || bytes + body.byteLength > maxBytes) remove(entries.keys().next().value!);
    // Buffer.slice() aliases its input; Uint8Array.from() always owns its bytes.
    entries.set(id, { key, body: Uint8Array.from(body) });
    bytes += body.byteLength;
  };
  const copy = (body: Uint8Array | null): Uint8Array | null => body === null ? null : Uint8Array.from(body);
  const read = async (key: string, range?: { offset: number; length: number }): Promise<Uint8Array | null> => {
    const digest = objectDigest(key);
    const eligible = Boolean(digest && maxBytes && maxEntries && maxEntryBytes);
    const fullId = JSON.stringify([key]);
    const id = range ? JSON.stringify([key, range.offset, range.length]) : fullId;
    const load = async (): Promise<Uint8Array | null> => {
      if (!range) return store.get(key);
      if (store.getRange) {
        const body = await store.getRange(key, range.offset, range.length);
        if (body !== null && body.byteLength !== range.length) throw new Error('snapshot_object_range_invalid');
        return body;
      }
      const body = await store.get(key);
      if (body === null) return null;
      if (range.offset + range.length > body.byteLength) throw new Error('snapshot_object_range_invalid');
      return body.subarray(range.offset, range.offset + range.length);
    };
    if (!eligible) return copy(await load());
    const full = touch(fullId);
    if (full) {
      if (range && range.offset + range.length > full.byteLength) throw new Error('snapshot_object_range_invalid');
      return copy(range ? full.subarray(range.offset, range.offset + range.length) : full);
    }
    const hit = range ? touch(id) : undefined;
    if (hit) return copy(hit);
    const existing = flights.get(id);
    if (existing) return copy(await existing.result);
    // Overflow bypasses the cache entirely rather than growing another queue.
    if (flights.size >= maxInFlight) return copy(await load());
    const started = generation;
    const flight: Flight = { key, result: Promise.resolve(null) };
    flight.result = Promise.resolve().then(load).then(body => {
      if (body !== null && started === generation && body.byteLength <= maxEntryBytes
        && (range || createHash('sha256').update(body).digest('hex') === digest)) remember(id, key, body);
      return copy(body);
    }).finally(() => { if (flights.get(id) === flight) flights.delete(id); });
    flights.set(id, flight);
    return copy(await flight.result);
  };
  const mutate = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    // Match aliases accepted by the local/COS adapters when invalidating.
    const canonical = key.replaceAll('\\', '/').replace(/^\/+/, '');
    const matches = (candidate: string) => candidate === canonical;
    invalidate(matches);
    try { return await action(); } finally { invalidate(matches); }
  };

  return {
    kind: store.kind,
    get: key => read(key),
    getRange: (key, offset, length) => {
      try { assertRange(offset, length); } catch (error) { return Promise.reject(error); }
      return read(key, { offset, length });
    },
    put: (key, body, contentType) => mutate(key, () => store.put(key, body, contentType)),
    delete: key => mutate(key, () => store.delete(key)),
    ...(store.purge ? { purge: (key: string) => mutate(key, () => store.purge!(key)) } : {}),
    ...(store.inventory ? { inventory: () => store.inventory!() } : {}),
    ...(store.inventoryEntries ? { inventoryEntries: (signal?: AbortSignal) => store.inventoryEntries!(signal) } : {}),
    invalidatePrefix: prefix => {
      const canonical = prefix.replaceAll('\\', '/').replace(/^\/+/, '');
      invalidate(key => key.startsWith(canonical));
    },
    cacheStats: () => ({ bytes, entries: entries.size, inFlight: flights.size }),
  };
}
