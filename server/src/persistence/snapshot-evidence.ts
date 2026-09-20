import type { SnapshotEvidence } from '../domain/snapshot.js';
import type { SnapshotQueryEvidenceRow } from '../domain/snapshot-query.js';

export interface SnapshotEvidenceRequest {
  publicKey: string;
  snapshotId: string;
  evidenceIds: string[];
}

/** Exact lookups are for a small set of already selected references, never a graph export. */
export function boundedEvidenceIds(ids: string[]): string[] {
  if (ids.length > 20 || ids.some(id => !id || id.length > 2048)) {
    throw new Error('snapshot_evidence_request_invalid');
  }
  return [...new Set(ids)];
}

export function snapshotEvidence(row: SnapshotQueryEvidenceRow): SnapshotEvidence {
  return {
    stable_id: row.evidence_id, label: row.label, path: row.path,
    start_line: row.start_line, end_line: row.end_line, kind: row.kind,
    source_id: row.source_id ?? undefined, target_id: row.target_id ?? undefined,
  };
}
