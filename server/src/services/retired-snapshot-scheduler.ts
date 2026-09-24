import type { PublicSnapshotMetadata } from '../domain/lifecycle.js';

export interface RetiredSnapshotCleanupPort {
  listPurgeablePublicSnapshots(now: string): Promise<PublicSnapshotMetadata[]>;
  purgePublicSnapshotPayload(publicKey: string, purgedAt: string): Promise<boolean>;
  deleteRetiredSnapshotObjectsBatch(limit: number): Promise<{
    deleted: number; failed: number; pending: number;
  }>;
}

/** A small elected batch; object failures remain in the durable retry ledger. */
export function createRetiredSnapshotCleanupTask(
  store: RetiredSnapshotCleanupPort,
  now: () => number = Date.now,
): () => Promise<{ staged: number; deleted: number; failed: number; pending: number }> {
  return async () => {
    const startedAt = now();
    const checkedAt = new Date(startedAt).toISOString();
    let staged = 0;
    const candidates = (await store.listPurgeablePublicSnapshots(checkedAt)).slice(0, 2);
    for (const candidate of candidates) {
      if (now() - startedAt > 5_000) break;
      if (await store.purgePublicSnapshotPayload(candidate.public_snapshot_key, checkedAt)) staged++;
    }
    // Retries objects whose deletion failed or was interrupted earlier.
    const batch = await store.deleteRetiredSnapshotObjectsBatch(256);
    return { staged, ...batch };
  };
}
