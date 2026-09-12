import type { Snapshot } from './types';

// Snapshot language variants share snapshot_id. Keep each variant separately.
// Keep the hot path in memory and use
// IndexedDB only to survive a page reload; localStorage is too small for real
// repositories and is synchronous on the main thread.
const memoryCache = new Map<string, Snapshot>();
const DB_NAME = 'what-the-repo-web-cache-v1';
const STORE_NAME = 'snapshots';
const MAX_MEMORY_ENTRIES = 8;
const MAX_DISK_ENTRIES = 6;

interface StoredSnapshot {
  cacheKey: string;
  projectId: string;
  snapshot: Snapshot;
  savedAt: number;
}

function rememberInMemory(projectId: string, snapshot: Snapshot): void {
  const key = cacheKey(projectId, snapshot.display_language);
  memoryCache.delete(key);
  memoryCache.set(key, snapshot);
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function cacheKey(projectId: string, language = 'zh-CN'): string {
  return `${projectId}:${language}`;
}

export function getMemorySnapshot(projectId: string, snapshotId?: string | null, language = 'zh-CN'): Snapshot | null {
  const snapshot = memoryCache.get(cacheKey(projectId, language)) ?? null;
  if (!snapshot || (snapshotId && snapshot.snapshot_id !== snapshotId)) return null;
  // Refresh LRU order without cloning the large payload.
  rememberInMemory(projectId, snapshot);
  return snapshot;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      // Discard the old cache: it did not identify the stored language.
      if (request.result.objectStoreNames.contains(STORE_NAME)) request.result.deleteObjectStore(STORE_NAME);
      request.result.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
function database(): Promise<IDBDatabase | null> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

export async function readCachedSnapshot(
  projectId: string,
  snapshotId?: string | null,
  language = 'zh-CN',
): Promise<Snapshot | null> {
  const hot = getMemorySnapshot(projectId, snapshotId, language);
  if (hot) return hot;
  const db = await database();
  if (!db) return null;
  return new Promise(resolve => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(cacheKey(projectId, language));
    request.onsuccess = () => {
      const stored = request.result as StoredSnapshot | undefined;
      const snapshot = stored?.snapshot;
      if (!snapshot || (snapshotId && snapshot.snapshot_id !== snapshotId)) {
        resolve(null);
        return;
      }
      rememberInMemory(projectId, snapshot);
      resolve(snapshot);
    };
    request.onerror = () => resolve(null);
  });
}

export function writeSnapshotCache(projectId: string, snapshot: Snapshot): void {
  rememberInMemory(projectId, snapshot);
  void database().then(db => {
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ cacheKey: cacheKey(projectId, snapshot.display_language), projectId, snapshot, savedAt: Date.now() } satisfies StoredSnapshot);
    transaction.oncomplete = () => {
      const cleanup = db.transaction(STORE_NAME, 'readwrite');
      const store = cleanup.objectStore(STORE_NAME);
      const keysRequest = store.getAll();
      keysRequest.onsuccess = () => {
        const entries = (keysRequest.result as StoredSnapshot[])
          .sort((a, b) => b.savedAt - a.savedAt);
        for (const entry of entries.slice(MAX_DISK_ENTRIES)) store.delete(entry.cacheKey);
      };
    };
  }).catch(() => undefined);
}

export function removeSnapshotCache(projectId: string): void {
  for (const key of memoryCache.keys()) if (key.startsWith(`${projectId}:`)) memoryCache.delete(key);
  void database().then(db => {
    if (!db) return;
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    for (const language of ['zh-CN', 'en']) store.delete(cacheKey(projectId, language));
  }).catch(() => undefined);
}

/** Test and logout helper; product code normally evicts entries per project. */
export function clearSnapshotCache(): void {
  memoryCache.clear();
  void database().then(db => {
    if (!db) return;
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
  }).catch(() => undefined);
}
