import { asEvidenceSnapshot } from '../domain/snapshot.js';
import type { ProductStore } from '../persistence/store.js';

export async function loadConversationSnapshot(store: ProductStore, projectId: string, canonical: boolean) {
  const snapshot = asEvidenceSnapshot(await store.loadSnapshot(projectId));
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
