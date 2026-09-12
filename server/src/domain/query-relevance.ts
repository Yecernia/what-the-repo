import type { SnapshotQueryEdgeRow, SnapshotQueryNodeRow, SnapshotQueryInput } from "./snapshot-query.js";

export interface RelevanceScore {
  score: number;
  matched_terms: number;
  evidence_count: number;
}

function terms(value: string | undefined): string[] {
  return [...new Set((value ?? "").toLowerCase().split(/[^a-z0-9_:\-\u3400-\u9fff]+/u).filter((item) => item.length > 1))];
}

function hits(text: string, queryTerms: string[]): number {
  return queryTerms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}

export function scoreNode(row: SnapshotQueryNodeRow, input: SnapshotQueryInput): RelevanceScore {
  const queryTerms = terms(input.text);
  const content = [row.node_id, row.name, row.label, row.responsibility, row.path ?? "", JSON.stringify(row.payload)].join(" ").toLowerCase();
  const matched = hits(content, queryTerms);
  const personalized = input.personalized_entity_ids?.includes(row.node_id) ? 1.5 : 0;
  const depth = Number.isFinite(row.depth) ? row.depth : 0;
  const depthBoost = Math.max(0, 1 - depth * 0.02);
  const kindBoost = row.entity_kind === "component" ? 0.1 : 0;
  return {
    score: matched * 10 + personalized + depthBoost + kindBoost,
    matched_terms: matched,
    evidence_count: Number(row.payload.member_count ?? 0),
  };
}

export function scoreEdge(row: SnapshotQueryEdgeRow, input: SnapshotQueryInput): RelevanceScore {
  const queryTerms = terms(input.text);
  const content = [row.edge_id, row.relation_kind, row.label, row.description, row.source_node_key, row.target_node_key].join(" ").toLowerCase();
  const matched = hits(content, queryTerms);
  return {
    score: matched * 10 + row.weight,
    matched_terms: matched,
    evidence_count: Number(row.payload.evidence_count ?? 0),
  };
}

export function estimateQueryTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}
