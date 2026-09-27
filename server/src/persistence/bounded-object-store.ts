import type { SnapshotObjectStore } from './snapshot-object-store.js';
import { ResourceScheduler } from '../scheduling/resources.js';

/** Bound aggregate object requests, including chunk/file fan-out across jobs. */
export function boundedObjectStore(store: SnapshotObjectStore, scheduler: ResourceScheduler, concurrency: number): SnapshotObjectStore {
  const run = async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const permit = await scheduler.acquire({ owner: 'object-storage', task: '',
      demands: { 'object-storage:requests': { units: 1, limit: concurrency } }, signal, waitMs: 120_000, maxOwnerWaiting: 512 });
    try { permit.signal.throwIfAborted(); const result = await task(); permit.signal.throwIfAborted(); return result; }
    finally { await permit.release(); }
  };
  return {
    kind: store.kind,
    put: (key, body, contentType) => run(() => store.put(key, body, contentType)),
    get: key => run(() => store.get(key)),
    ...(store.getRange ? { getRange: (key: string, offset: number, length: number) => run(() => store.getRange!(key, offset, length)) } : {}),
    delete: key => run(() => store.delete(key)),
    ...(store.purge ? { purge: (key: string) => run(() => store.purge!(key)) } : {}),
    ...(store.inventory ? { inventory: () => run(() => store.inventory!()) } : {}),
    ...(store.inventoryEntries ? { inventoryEntries: async function* (signal?: AbortSignal) {
      const iterator = store.inventoryEntries!(signal)[Symbol.asyncIterator]();
      let done = false;
      try {
        while (true) {
          // Release admission before yielding: a consumer may delete each item
          // through this same wrapper, even with a single available request.
          const next = await run(() => iterator.next(), signal);
          if (next.done) { done = true; return; }
          yield next.value;
        }
      } finally {
        if (!done && iterator.return) await run(() => iterator.return!());
      }
    } } : {}),
  };
}
