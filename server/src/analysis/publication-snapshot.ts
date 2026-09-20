import type { BuiltSnapshot } from './graph.js';
import type { ParsedFile } from './facts.js';
import { applyIncrementalProvenance, incrementalSummary, type IncrementalPlan } from './incremental.js';
import { extractSnapshotLanguageOverlay, snapshotMatchesDisplayLanguage, stripOwnedSnapshotLanguage } from '../domain/snapshot-language.js';
import { assertValidEvidenceSnapshot } from '../domain/snapshot-validation.js';
import { snapshotPublicView } from '../domain/snapshot-public-view.js';

/** The caller transfers ownership of current fact rows; previous snapshots stay immutable. */
export function preparePublicationSnapshot(input: {
  snapshot: BuiltSnapshot;
  previousFactGraph: BuiltSnapshot['fact_graph'] | null;
  plan?: IncrementalPlan;
  currentParsedFiles: ParsedFile[];
  displayLanguage: string;
  provenanceApplied?: boolean;
}) {
  if (!input.provenanceApplied && !input.plan) throw new Error("analysis_publication_plan_missing");
  const timings: Record<string, number> = {};
  const measure = <T>(phase: string, operation: () => T): T => {
    const start = performance.now();
    const result = operation();
    timings[`preparation_${phase}_ms`] = performance.now() - start;
    const memory = process.memoryUsage();
    timings[`preparation_${phase}_rss_bytes`] = memory.rss;
    timings[`preparation_${phase}_heap_bytes`] = memory.heapUsed;
    timings[`preparation_${phase}_external_bytes`] = memory.external;
    return result;
  };
  const localized = measure('provenance', () => input.provenanceApplied ? input.snapshot : applyIncrementalProvenance({
    snapshot: input.snapshot, previousFactGraph: input.previousFactGraph,
    plan: input.plan!, currentParsedFiles: input.currentParsedFiles, takeOwnership: true,
  }));
  const languageOverlay = measure('overlay', () => extractSnapshotLanguageOverlay(localized, input.displayLanguage));
  const overlayStatus = snapshotMatchesDisplayLanguage(localized, input.displayLanguage) ? 'ready' as const : 'degraded' as const;
  const base = measure('strip', () => stripOwnedSnapshotLanguage(localized));
  const validated = measure('validation', () => assertValidEvidenceSnapshot(base));
  const view = measure('view', () => snapshotPublicView(validated));
  return {
    view, languageOverlay, overlayStatus, timings,
    analysis: {
      snapshot_id: localized.snapshot_id,
      fact_graph: validated.fact_graph,
      semantic_graph: view.graph,
      value_points: view.value_points,
      languages: view.languages,
      source_reports: validated.source_reports,
      static_analysis: validated.static_analysis,
      incremental: input.plan ? incrementalSummary(input.plan) : undefined,
      active_fact_fingerprint: localized.active_fact_fingerprint,
    },
  };
}
