import type { EvidenceSnapshot } from "./snapshot.js";

/** Keep high-cardinality analysis records out of every browser/Agent overview. */
export function snapshotPublicView(snapshot: EvidenceSnapshot): EvidenceSnapshot & Record<string, unknown> {
  const { fact_graph: _facts, source_root: _root, ...view } = snapshot;
  return {
    ...view,
    ...(view.static_analysis ? { static_analysis: {
      ...view.static_analysis, files: [], details_available: true,
    } } : {}),
    source_reports: view.source_reports?.map(report => {
      const { workspace_diagnostics: diagnostics, ...summary } = report;
      const coverage = summary.coverage as Record<string, unknown> | undefined;
      if (!coverage) return summary;
      const { targets: _targets, ...counts } = coverage;
      return { ...summary, coverage: counts,
        workspace_diagnostic_count: Array.isArray(diagnostics) ? diagnostics.length : 0 };
    }),
  };
}
