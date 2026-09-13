import { nowIso } from "../domain/conversation.js";
import type { PiMemoryRepository } from "../agent/memory-store.js";
import type { PiSessionStore } from "../agent/session-store.js";
import type { ProductStore } from "../persistence/store.js";

export const GUEST_EMPTY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GUEST_PROJECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PUBLIC_SNAPSHOT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetentionSweepResult {
  checkedAt: string;
  softDeletedOwners: string[];
  deletedOwners: string[];
  purgedSnapshots: string[];
}

/**
 * Runs deterministic retention work. It never invokes a model and never deletes
 * a shared snapshot merely because one owner disappeared.
 */
export async function runRetentionSweep(input: {
  store: ProductStore;
  sessions: PiSessionStore;
  memories: PiMemoryRepository;
  now?: string;
}): Promise<RetentionSweepResult> {
  const checkedAt = input.now ?? nowIso();
  const softDeletedOwners: string[] = [];
  const deletedOwners: string[] = [];
  for (const candidate of await input.store.listGuestRetentionCandidates(checkedAt)) {
    if (candidate.action === "soft_delete") {
      const deletedAt = checkedAt;
      const purgeAfter = new Date(Date.parse(checkedAt) + GUEST_RECOVERY_WINDOW_MS).toISOString();
      if (await input.store.softDeleteGuestOwner(candidate.owner_id, deletedAt, purgeAfter)) {
        softDeletedOwners.push(candidate.owner_id);
      }
      continue;
    }
    // Memory and Pi sessions live behind separate repositories, so clear them
    // before removing the owner row and its project-owned records.
    await input.memories.clear(candidate.owner_id);
    await input.sessions.deleteOwner(candidate.owner_id);
    if (await input.store.deleteOwner(candidate.owner_id)) deletedOwners.push(candidate.owner_id);
  }

  const purgedSnapshots: string[] = [];
  // Capacity reclamation is a separate, administrator-confirmed operation.
  // Guest lifecycle and recovery windows continue regardless of disk pressure.
  return { checkedAt, softDeletedOwners, deletedOwners, purgedSnapshots };
}
