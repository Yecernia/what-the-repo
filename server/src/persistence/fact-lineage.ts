/**
 * Compact per-fact history published beside a chunked fact graph.
 *
 * An incremental update needs only each previous fact's identity, revision,
 * first-seen snapshot, path, lifecycle and LSP origin. Full rows are required
 * only for facts that become tombstones. Rows keep the fact graph's order, so
 * a lineage ordinal also locates the complete row in the fact-graph chunks.
 */
export const FACT_LINEAGE_SCHEMA = 'fact-lineage-v1' as const;
export const FACT_LINEAGE_ACTIVE = 1;
export const FACT_LINEAGE_LSP = 2;

/** [id, revision_id, first_seen_snapshot_id, path, flags] */
export type NodeLineageRow = [string, string | null, string | null, string | null, number];
/** [id, revision_id, first_seen_snapshot_id, source, target, flags]; endpoints are node ordinals when present. */
export type EdgeLineageRow = [string, string | null, string | null, number | string, number | string, number];

type Row = Record<string, unknown>;
const object = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const optionalString = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** Same path rule as incremental planning and provenance. */
export function factNodePath(row: Row): string | null {
  const path = object(row.attributes)?.path;
  if (typeof path === 'string' && path) return path;
  const evidence = Array.isArray(row.evidence) ? object(row.evidence[0])?.path : undefined;
  if (typeof evidence === 'string' && evidence) return evidence;
  const member = Array.isArray(row.members) ? object(row.members[0])?.path : undefined;
  return typeof member === 'string' && member ? member : null;
}

function flags(row: Row): number {
  const active = row.lifecycle_status !== 'tombstoned' && row.lifecycle_status !== 'superseded';
  const lsp = Array.isArray(row.source_observations)
    && row.source_observations.some(observation => object(observation)?.extractor === 'lsp');
  return (active ? FACT_LINEAGE_ACTIVE : 0) | (lsp ? FACT_LINEAGE_LSP : 0);
}

function factRow(value: unknown): Row {
  const row = object(value);
  if (!row || typeof row.id !== 'string') throw new Error('analysis_fact_lineage_source_invalid');
  return row;
}

export function* nodeLineageRows(nodes: Iterable<unknown>): Generator<NodeLineageRow> {
  for (const value of nodes) {
    const row = factRow(value);
    yield [row.id as string, optionalString(row.revision_id), optionalString(row.first_seen_snapshot_id),
      factNodePath(row), flags(row)];
  }
}

export function* edgeLineageRows(edges: Iterable<unknown>, nodes: readonly unknown[]): Generator<EdgeLineageRow> {
  // Built only when the edge stream starts; strings are shared with the rows.
  const ordinals = new Map<string, number>();
  for (let index = 0; index < nodes.length; index++) {
    const id = object(nodes[index])?.id;
    if (typeof id === 'string' && !ordinals.has(id)) ordinals.set(id, index);
  }
  for (const value of edges) {
    const row = factRow(value);
    if (typeof row.source !== 'string' || typeof row.target !== 'string') throw new Error('analysis_fact_lineage_source_invalid');
    yield [row.id as string, optionalString(row.revision_id), optionalString(row.first_seen_snapshot_id),
      ordinals.get(row.source) ?? row.source, ordinals.get(row.target) ?? row.target, flags(row)];
  }
}

function validFlags(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= (FACT_LINEAGE_ACTIVE | FACT_LINEAGE_LSP);
}
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const endpoint = (value: unknown) => typeof value === 'string' || Number.isSafeInteger(value) && Number(value) >= 0;

/** Decoded rows come from integrity-checked chunks; shape is still validated. */
export function decodeNodeLineage(value: unknown, count: number, intern: (value: string | null) => string | null): NodeLineageRow[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('analysis_fact_lineage_invalid');
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 5 || typeof row[0] !== 'string' || !nullableString(row[1])
      || !nullableString(row[2]) || !nullableString(row[3]) || !validFlags(row[4])) throw new Error('analysis_fact_lineage_invalid');
    row[2] = intern(row[2]);
  }
  return value as NodeLineageRow[];
}

export function decodeEdgeLineage(value: unknown, count: number, intern: (value: string | null) => string | null): EdgeLineageRow[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('analysis_fact_lineage_invalid');
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== 'string' || !nullableString(row[1])
      || !nullableString(row[2]) || !endpoint(row[3]) || !endpoint(row[4]) || !validFlags(row[5])) {
      throw new Error('analysis_fact_lineage_invalid');
    }
    row[2] = intern(row[2]);
  }
  return value as EdgeLineageRow[];
}

/** First-seen IDs repeat for nearly every fact; keep one string per value. */
export function createStringInterner(): (value: string | null) => string | null {
  const values = new Map<string, string>();
  return value => {
    if (value === null) return null;
    const existing = values.get(value);
    if (existing !== undefined) return existing;
    values.set(value, value);
    return value;
  };
}
