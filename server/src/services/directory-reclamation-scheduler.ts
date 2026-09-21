import type { Pool } from 'pg';
import { METRIC_NAMES, type RuntimeMetrics } from '../observability/metrics.js';
import { reclaimSnapshotDirectoryBatch, snapshotDirectoryReclamationBacklog } from '../persistence/directory-reclamation.js';

/** The elected maintenance process owns this loop; no analysis resource is acquired. */
export function createDirectoryReclamationTask(pool: Pool, metrics: RuntimeMetrics, dependencies: {
  batch?: () => ReturnType<typeof reclaimSnapshotDirectoryBatch>;
  backlog?: () => ReturnType<typeof snapshotDirectoryReclamationBacklog>;
  now?: () => number;
} = {}): () => Promise<void> {
  const batch = dependencies.batch ?? (() => reclaimSnapshotDirectoryBatch(pool));
  const backlog = dependencies.backlog ?? (() => snapshotDirectoryReclamationBacklog(pool));
  const now = dependencies.now ?? (() => performance.now());
  let nextWorkAt = 0, nextBacklogAt = 0;
  return async () => {
    if (now() < nextWorkAt) return;
    const started = now();
    try {
      const result = await batch();
      metrics.increment(METRIC_NAMES.directoryReclamationBatches, 1, { outcome: result.status });
      metrics.increment(METRIC_NAMES.directoryReclamationRows, result.deletedRows);
      metrics.observe(METRIC_NAMES.directoryReclamationDuration, now() - started);
      // Busy/empty/backoff states do not generate a high-frequency SQL poll.
      nextWorkAt = now() + (result.status === 'idle' ? 5_000
        : result.status === 'busy' || result.status === 'retry' ? 1_000 : 100);
    } catch {
      metrics.increment(METRIC_NAMES.directoryReclamationErrors, 1, { operation: 'batch' });
      nextWorkAt = now() + 5_000;
    }
    if (now() < nextBacklogAt) return;
    nextBacklogAt = now() + 10_000;
    try {
      const state = await backlog();
      metrics.setGauge(METRIC_NAMES.directoryReclamationPending, state.pending);
      metrics.setGauge(METRIC_NAMES.directoryReclamationFailed, state.failed);
      metrics.setGauge(METRIC_NAMES.directoryReclamationAge, state.oldestSeconds);
    } catch {
      metrics.increment(METRIC_NAMES.directoryReclamationErrors, 1, { operation: 'backlog' });
    }
  };
}
