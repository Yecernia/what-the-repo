import type { EvidenceSnapshot, SnapshotEdge, SnapshotLayer, SnapshotNode } from './snapshot.js';

export const WORKSPACE_SNAPSHOT_VIEW = 'workspace-v1' as const;
export type WorkspaceDetailKind = 'component' | 'relation' | 'layer';

/** A browser overview is derived from the loaded language view, never written to storage. */
export function workspaceSnapshot(snapshot: EvidenceSnapshot) {
  const graph = snapshot.graph;
  const oneEvidence = <T extends { evidence: unknown[] }>(row: T) => ({
    ...row,
    evidence: row.evidence.slice(0, 1),
    evidence_total: row.evidence.length,
    detail_available: true as const,
  });
  const oneId = <T extends { evidence_ids: string[] }>(row: T) => ({
    ...row,
    evidence_ids: row.evidence_ids.slice(0, 1),
    evidence_total: row.evidence_ids.length,
  });
  return {
    view: WORKSPACE_SNAPSHOT_VIEW,
    snapshot_id: snapshot.snapshot_id,
    display_language: snapshot.display_language,
    language_overlay_status: snapshot.language_overlay_status,
    summary: snapshot.summary,
    graph: {
      schema_version: graph.schema_version,
      semantic_mode: graph.semantic_mode,
      semantic_coverage: graph.semantic_coverage,
      hierarchy: graph.hierarchy,
      nodes: graph.nodes.map(node => {
        const { source_observations: _observations, incremental_provenance: _provenance,
          lifecycle_status: _lifecycle, tombstoned_at_snapshot_id: _tombstoned,
          first_seen_snapshot_id: _first, last_seen_snapshot_id: _last,
          superseded_by: _superseded, revision_id: _revision, ...visible } = node;
        return {
          ...oneEvidence(visible),
          members: node.members.slice(0, 1),
          members_total: node.members.length,
        };
      }),
      edges: graph.edges.map(edge => {
        const { source_observations: _observations, incremental_provenance: _provenance,
          lifecycle_status: _lifecycle, tombstoned_at_snapshot_id: _tombstoned,
          first_seen_snapshot_id: _first, last_seen_snapshot_id: _last,
          superseded_by: _superseded, revision_id: _revision, ...visible } = edge;
        return oneEvidence(visible);
      }),
      layers: graph.layers.map(oneEvidence),
      unassigned_component_ids: graph.unassigned_component_ids,
      overlays: graph.overlays?.map(oneId),
      projections: graph.projections?.human ? {
        human: {
          ...graph.projections.human,
          nodes: graph.projections.human.nodes.map(oneId),
          edges: graph.projections.human.edges.map(oneId),
        },
      } : undefined,
    },
    value_points: snapshot.value_points,
    languages: snapshot.languages,
    learning_plan: snapshot.learning_plan,
  };
}

export function workspaceSnapshotDetail(snapshot: EvidenceSnapshot, kind: WorkspaceDetailKind, id: string):
  SnapshotNode | SnapshotEdge | SnapshotLayer | null {
  const rows = kind === 'component' ? snapshot.graph.nodes
    : kind === 'relation' ? snapshot.graph.edges : snapshot.graph.layers;
  return rows.find(row => row.id === id) ?? null;
}
