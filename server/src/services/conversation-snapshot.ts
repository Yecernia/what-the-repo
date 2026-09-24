import { asEvidenceSnapshot } from '../domain/snapshot.js';
import type { Project } from '../domain/conversation.js';
import type { ConversationSummary } from '../domain/conversation-summary.js';
import type { ProductStore } from '../persistence/store.js';
import { serviceError } from './errors.js';

export async function loadConversationSnapshot(store: ProductStore, projectId: string, canonical: boolean,
  pinned?: { publicSnapshotKey: string; snapshotId: string } | null) {
  // A turn pinned to a retired version reads that version's published view.
  const snapshot = pinned
    ? asEvidenceSnapshot((await store.loadPublicSnapshotView(pinned.publicSnapshotKey))?.view)
    : asEvidenceSnapshot(await store.loadSnapshot(projectId));
  // Published repositories use the indexed evidence directory and per-file source readers.
  // Full analysis objects also include compiler caches and must not be loaded per chat turn.
  if (snapshot && !canonical) {
    const analysis = await store.loadAnalysisResult<{ fact_graph?: { nodes?: unknown[]; edges?: unknown[] } }>(projectId);
    if (Array.isArray(analysis?.fact_graph?.nodes) && Array.isArray(analysis.fact_graph.edges)) {
      snapshot.fact_graph = analysis.fact_graph as NonNullable<typeof snapshot.fact_graph>;
    }
  }
  return snapshot;
}

/** One reader per turn. Concurrent callers share both success and failure. */
export function createConversationSnapshotReader(store: ProductStore, input: {
  projectId: string;
  ownerId: string;
  snapshotId: string | null;
  publicSnapshotKey: string | null;
  signal?: AbortSignal;
}) {
  let promise: ReturnType<typeof loadConversationSnapshot> | undefined;
  return () => {
    promise ??= (async () => {
      input.signal?.throwIfAborted();
      const current = await store.loadProject(input.projectId, input.ownerId);
      if (!current) throw serviceError('not_found', '项目不存在', 404);
      // The turn reads the version it captured, whether or not it is still current.
      const pinned = input.publicSnapshotKey && input.snapshotId
        && (current.analysis.snapshot_id !== input.snapshotId
          || current.analysis.canonical_snapshot_key !== input.publicSnapshotKey)
        ? { publicSnapshotKey: input.publicSnapshotKey, snapshotId: input.snapshotId } : null;
      const snapshot = await loadConversationSnapshot(store, input.projectId, Boolean(input.publicSnapshotKey), pinned);
      if (snapshot && input.snapshotId && snapshot.snapshot_id !== input.snapshotId) {
        throw serviceError('snapshot_changed', '项目快照已更新，请刷新后重试。', 409);
      }
      return snapshot;
    })();
    return promise;
  };
}


/** Independent per-turn bounded summary reader; canonical stores avoid the full graph. */
export function createConversationSummaryReader(store: ProductStore, input: {
  project: Project;
  snapshotId: string | null;
  assertSnapshotBinding: () => Promise<void>;
}) {
  let promise: Promise<ConversationSummary | null> | undefined;
  return () => {
    promise ??= (async () => {
      await input.assertSnapshotBinding();
      const summary = await store.loadConversationSummary(input.project);
      if (summary && summary.snapshot_id !== input.snapshotId) {
        throw serviceError('snapshot_changed', '项目快照已更新，请刷新后重试。', 409);
      }
      await input.assertSnapshotBinding();
      return summary;
    })();
    return promise;
  };
}
