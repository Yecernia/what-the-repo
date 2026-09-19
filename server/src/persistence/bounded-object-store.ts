import type { SnapshotObjectStore } from './snapshot-object-store.js';
import { ResourceScheduler } from '../scheduling/resources.js';

/** Bound aggregate object requests, including chunk/file fan-out across jobs. */
export function boundedObjectStore(store: SnapshotObjectStore, scheduler: ResourceScheduler, concurrency: number): SnapshotObjectStore {
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    const permit = await scheduler.acquire({ owner: 'object-storage', task: '',
      demands: { 'object-storage:requests': { units: 1, limit: concurrency } }, waitMs: 120_000, maxOwnerWaiting: 512 });
    try { permit.signal.throwIfAborted(); const result = await task(); permit.signal.throwIfAborted(); return result; }
    finally { await permit.release(); }
  };
  return {
    kind: store.kind,
    put: (key, body, contentType) => run(() => store.put(key, body, contentType)),
    get: key => run(() => store.get(key)),
    delete: key => run(() => store.delete(key)),
    ...(store.purge ? { purge: (key: string) => run(() => store.purge!(key)) } : {}),
    ...(store.inventory ? { inventory: () => run(() => store.inventory!()) } : {}),
  };
}
