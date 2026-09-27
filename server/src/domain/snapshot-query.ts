import { createHash } from "node:crypto";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotLayer,
  SnapshotNode,
  SnapshotValuePoint,
  SnapshotEntityKind,
  SnapshotOverlayKind,
  SnapshotProjectionKind,
  SnapshotProjection,
} from "./snapshot.js";
import { asEvidenceSnapshot } from "./snapshot.js";
import { estimateQueryTokens, scoreEdge, scoreNode } from "./query-relevance.js";

export type SnapshotQueryNodeKind = "component" | "fact";
export type SnapshotQueryEdgeKind = "semantic" | "fact";
export type SnapshotQueryOwnerKind = "node" | "edge" | "layer" | "value_point";

export interface SnapshotQueryNodeRow {
  public_snapshot_key: string;
  snapshot_id: string;
  node_key: string;
  node_id: string;
  node_kind: SnapshotQueryNodeKind;
  entity_kind: SnapshotEntityKind;
  parent_entity_id: string | null;
  depth: number;
  label: string;
  name: string;
  responsibility: string;
  path: string | null;
  language: string | null;
  layer_id: string | null;
  layer_name: string | null;
  certainty: string;
  lifecycle_status: string;
  payload: Record<string, unknown>;
}

export interface SnapshotQueryEdgeRow {
  public_snapshot_key: string;
  snapshot_id: string;
  edge_key: string;
  edge_id: string;
  edge_kind: SnapshotQueryEdgeKind;
  source_node_key: string;
  target_node_key: string;
  relation_kind: string;
  label: string;
  description: string;
  certainty: string;
  weight: number;
  lifecycle_status: string;
  payload: Record<string, unknown>;
}

export interface SnapshotQueryEvidenceRow {
  public_snapshot_key: string;
  snapshot_id: string;
  evidence_id: string;
  label: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  kind: string;
  source_id: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
}

export interface SnapshotQueryEvidenceLinkRow {
  public_snapshot_key: string;
  evidence_id: string;
  owner_kind: SnapshotQueryOwnerKind;
  owner_key: string;
  role: "evidence" | "member";
}

export interface SnapshotQueryLayerRow {
  public_snapshot_key: string;
  snapshot_id: string;
  layer_id: string;
  name: string;
  responsibility: string;
  certainty: string;
  payload: Record<string, unknown>;
}

export interface SnapshotQueryValuePointRow {
  public_snapshot_key: string;
  snapshot_id: string;
  value_point_id: string;
  kind: string;
  title: string;
  claim: string;
  certainty: string;
  connectivity: number;
  payload: Record<string, unknown>;
}

export interface SnapshotQueryMembershipRow {
  public_snapshot_key: string;
  snapshot_id: string;
  overlay_id: string;
  overlay_kind: SnapshotOverlayKind;
  entity_id: string;
  relation_id: string | null;
  role: "member" | "relation";
  payload: Record<string, unknown>;
}

export interface SnapshotQueryProjectionRow {
  public_snapshot_key: string;
  snapshot_id: string;
  projection_kind: SnapshotProjectionKind;
  projection_node_id: string;
  entity_id: string;
  parent_projection_node_id: string | null;
  depth: number;
  aggregate_member_entity_ids: string[];
  evidence_ids: string[];
  overlay_ids: string[];
  payload: Record<string, unknown>;
}

export interface SnapshotQueryAggregateRow {
  public_snapshot_key: string;
  snapshot_id: string;
  projection_kind: SnapshotProjectionKind;
  projection_edge_id: string;
  relation_id: string | null;
  source_projection_node_id: string;
  target_projection_node_id: string;
  source_entity_id: string;
  target_entity_id: string;
  aggregate_relation_ids: string[];
  evidence_ids: string[];
  overlay_ids: string[];
  payload: Record<string, unknown>;
}

export interface SnapshotQueryDirectory {
  public_snapshot_key: string;
  snapshot_id: string;
  nodes: SnapshotQueryNodeRow[];
  edges: SnapshotQueryEdgeRow[];
  evidence: SnapshotQueryEvidenceRow[];
  evidence_links: SnapshotQueryEvidenceLinkRow[];
  layers: SnapshotQueryLayerRow[];
  value_points: SnapshotQueryValuePointRow[];
  memberships: SnapshotQueryMembershipRow[];
  projections: SnapshotQueryProjectionRow[];
  aggregates: SnapshotQueryAggregateRow[];
  digest: string;
}

export interface SnapshotQueryInput {
  /** Internal callers can omit context metadata they never expose to the model/API. */
  include_metadata?: boolean;
  /** Internal projection used by Agent tools; full API queries remain complete. */
  include_payload?: boolean;
  evidence_per_owner?: { node: number; edge: number };
  text?: string;
  paths?: string[];
  languages?: string[];
  symbol_ids?: string[];
  component_ids?: string[];
  entity_ids?: string[];
  entity_kinds?: SnapshotEntityKind[];
  scope?: "self" | "subtree" | "ancestors" | "neighbors";
  depth?: number;
  projection?: SnapshotProjectionKind;
  personalized_entity_ids?: string[];
  evidence_budget_tokens?: number;
  relation_kinds?: string[];
  cursor?: string | null;
  limit?: number;
  expand_hops?: number;
}

export interface SnapshotQueryResult {
  public_snapshot_key: string;
  snapshot_id: string;
  nodes: SnapshotQueryNodeRow[];
  edges: SnapshotQueryEdgeRow[];
  evidence: SnapshotQueryEvidenceRow[];
  evidence_links: SnapshotQueryEvidenceLinkRow[];
  layers: SnapshotQueryLayerRow[];
  value_points: SnapshotQueryValuePointRow[];
  memberships?: SnapshotQueryMembershipRow[];
  projections?: SnapshotQueryProjectionRow[];
  aggregates?: SnapshotQueryAggregateRow[];
  estimated_tokens?: number;
  budget_tokens?: number | null;
  returned_evidence_count?: number;
  evidence_truncated?: boolean;
  truncation_reason?: "limit" | "token_budget" | "item_exceeds_budget" | null;
  next_cursor: string | null;
  truncated: boolean;
}

type QueryNodeItem = { key: string; row: SnapshotQueryNodeRow; kind: "node"; relevance: number };
type QueryEdgeItem = { key: string; row: SnapshotQueryEdgeRow; kind: "edge"; relevance: number };
export type QueryItem = QueryNodeItem | QueryEdgeItem;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result ? result : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function nodeKey(kind: SnapshotQueryNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function edgeKey(kind: SnapshotQueryEdgeKind, id: string): string {
  return `${kind}:${id}`;
}

function nodePath(node: SnapshotNode): string | null {
  const attributes = object(node.attributes);
  const direct = nullableText(attributes.path);
  if (direct) return direct;
  return node.members.find((item) => item.path)?.path ?? null;
}

function nodeLanguage(node: SnapshotNode): string | null {
  const attributes = object(node.attributes);
  const direct = nullableText(attributes.language);
  if (direct) return direct.toLowerCase();
  const path = nodePath(node);
  const extension = path?.split(".").pop();
  return extension ? extension.toLowerCase() : null;
}

function nodePayload(node: SnapshotNode): Record<string, unknown> {
  return {
    attributes: object(node.attributes),
    member_count: Number.isSafeInteger(node.member_count) ? Number(node.member_count) : node.members.length,
    evidence_count: node.evidence.length,
  };
}

function edgePayload(edge: SnapshotEdge): Record<string, unknown> {
  return { evidence_count: edge.evidence.length };
}

function nodeRow(
  publicKey: string,
  snapshotId: string,
  node: SnapshotNode,
  kind: SnapshotQueryNodeKind,
): SnapshotQueryNodeRow {
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    node_key: nodeKey(kind, node.id),
    node_id: node.id,
    node_kind: kind,
    entity_kind: node.entity_kind ?? (kind === "fact" ? "fact" : "component"),
    parent_entity_id: node.parent_entity_id ?? null,
    depth: Number.isSafeInteger(node.depth) ? Number(node.depth) : 0,
    label: node.label ?? node.name ?? node.id,
    name: node.name ?? node.label ?? node.id,
    responsibility: node.responsibility ?? "",
    path: nodePath(node),
    language: nodeLanguage(node),
    layer_id: node.architecture_layer_id ?? null,
    layer_name: node.architecture_layer_name ?? null,
    certainty: node.certainty ?? "unknown",
    lifecycle_status: node.lifecycle_status ?? "active",
    // The canonical snapshot remains the source of truth. This materialized
    // directory only keeps fields used by bounded search and API responses.
    payload: nodePayload(node),
  };
}

function edgeRow(
  publicKey: string,
  snapshotId: string,
  edge: SnapshotEdge,
  kind: SnapshotQueryEdgeKind,
): SnapshotQueryEdgeRow {
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    edge_key: edgeKey(kind, edge.id),
    edge_id: edge.id,
    edge_kind: kind,
    source_node_key: nodeKey(kind === "fact" ? "fact" : "component", edge.source),
    target_node_key: nodeKey(kind === "fact" ? "fact" : "component", edge.target),
    relation_kind: edge.relation_kind ?? "unknown",
    label: edge.label ?? edge.relation_kind ?? edge.id,
    description: edge.description ?? "",
    certainty: edge.certainty ?? "unknown",
    weight: Number.isFinite(edge.weight) ? edge.weight : 1,
    lifecycle_status: edge.lifecycle_status ?? "active",
    payload: edgePayload(edge),
  };
}

function evidenceRow(
  publicKey: string,
  snapshotId: string,
  evidence: SnapshotEvidence,
): SnapshotQueryEvidenceRow {
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    evidence_id: evidence.stable_id,
    label: evidence.label ?? evidence.stable_id,
    path: evidence.path ?? "",
    start_line: numberOrNull(evidence.start_line),
    end_line: numberOrNull(evidence.end_line),
    kind: evidence.kind ?? "unknown",
    source_id: nullableText(evidence.source_id),
    target_id: nullableText(evidence.target_id),
    payload: {},
  };
}

function layerRow(publicKey: string, snapshotId: string, layer: SnapshotLayer): SnapshotQueryLayerRow {
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    layer_id: layer.id,
    name: layer.name ?? layer.id,
    responsibility: layer.responsibility ?? "",
    certainty: layer.certainty ?? "unknown",
    payload: without(layer as unknown as Record<string, unknown>, ["evidence"]),
  };
}

function valuePointRow(publicKey: string, snapshotId: string, point: SnapshotValuePoint): SnapshotQueryValuePointRow {
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    value_point_id: point.stable_id,
    kind: point.kind ?? "unknown",
    title: point.title ?? point.stable_id,
    claim: point.claim ?? "",
    certainty: point.certainty ?? "unknown",
    connectivity: Number.isFinite(point.connectivity) ? point.connectivity : 0,
    payload: without(point as unknown as Record<string, unknown>, ["evidence"]),
  };
}


function graphNodes(value: unknown): SnapshotNode[] {
  return Array.isArray(value) ? value.filter((item): item is SnapshotNode => Boolean(item && typeof item === "object")) : [];
}

function graphEdges(value: unknown): SnapshotEdge[] {
  return Array.isArray(value) ? value.filter((item): item is SnapshotEdge => Boolean(item && typeof item === "object")) : [];
}

export interface SnapshotQueryRows<T> extends Iterable<T> { readonly length: number }
export type SnapshotQueryDirectorySource = Omit<SnapshotQueryDirectory, 'nodes' | 'edges' | 'evidence' | 'evidence_links'> & {
  nodes: SnapshotQueryRows<SnapshotQueryNodeRow>;
  edges: SnapshotQueryRows<SnapshotQueryEdgeRow>;
  evidence: SnapshotQueryRows<SnapshotQueryEvidenceRow>;
  evidence_links: SnapshotQueryRows<SnapshotQueryEvidenceLinkRow>;
};

function projectedRows<T, R>(sections: Array<{ values: T[]; project: (value: T) => R }>): SnapshotQueryRows<R> {
  return {
    length: sections.reduce((sum, section) => sum + section.values.length, 0),
    *[Symbol.iterator]() { for (const section of sections) for (const value of section.values) yield section.project(value); },
  };
}

/** Publication generates database rows on demand instead of retaining a second graph. */
export function streamSnapshotQueryDirectory(
  publicKey: string,
  snapshotId: string,
  viewValue: unknown,
  analysisValue: unknown,
): SnapshotQueryDirectorySource {
  const view = asEvidenceSnapshot(viewValue);
  if (!view) throw new Error("snapshot_query_view_invalid");
  const analysis = object(analysisValue);
  const factGraph = object(analysis.fact_graph);
  const semanticNodes = graphNodes(view.graph.nodes);
  const semanticEdges = graphEdges(view.graph.edges);
  const factNodes = graphNodes(factGraph.nodes);
  const factEdges = graphEdges(factGraph.edges);
  const nodes = projectedRows([
    { values: semanticNodes, project: node => nodeRow(publicKey, snapshotId, node, "component") },
    { values: factNodes, project: node => nodeRow(publicKey, snapshotId, node, "fact") },
  ]);
  const edges = projectedRows([
    { values: semanticEdges, project: edge => edgeRow(publicKey, snapshotId, edge, "semantic") },
    { values: factEdges, project: edge => edgeRow(publicKey, snapshotId, edge, "fact") },
  ]);
  const evidenceMap = new Map<string, SnapshotEvidence>();
  const layers = (view.graph.layers ?? []).map(layer => layerRow(publicKey, snapshotId, layer));
  const valuePoints = (view.value_points ?? []).map(point => valuePointRow(publicKey, snapshotId, point));
  type Owner = { kind: SnapshotQueryOwnerKind; key: string; values: SnapshotEvidence[]; role: 'evidence' | 'member' };
  function* owners(): Generator<Owner> {
    for (const [rows, kind] of [[semanticNodes, 'component'], [factNodes, 'fact']] as const) {
      for (const node of rows) {
        yield { kind: 'node', key: nodeKey(kind, node.id), values: node.evidence, role: 'evidence' };
        yield { kind: 'node', key: nodeKey(kind, node.id), values: node.members, role: 'member' };
      }
    }
    for (const [rows, kind] of [[semanticEdges, 'semantic'], [factEdges, 'fact']] as const) {
      for (const edge of rows) yield { kind: 'edge', key: edgeKey(kind, edge.id), values: edge.evidence, role: 'evidence' };
    }
    for (const layer of view!.graph.layers ?? []) yield { kind: 'layer', key: layer.id, values: layer.evidence, role: 'evidence' };
    for (const point of view!.value_points ?? []) yield { kind: 'value_point', key: point.stable_id, values: point.evidence, role: 'evidence' };
  }
  for (const owner of owners()) for (const item of owner.values ?? []) {
    if (item?.stable_id && !evidenceMap.has(item.stable_id)) evidenceMap.set(item.stable_id, item);
  }
  function* links(): Generator<SnapshotQueryEvidenceLinkRow> {
    const seen = new Set<string>();
    for (const owner of owners()) for (const item of owner.values ?? []) {
      if (!item?.stable_id) continue;
      const identity = JSON.stringify([item.stable_id, owner.kind, owner.key, owner.role]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      yield { public_snapshot_key: publicKey, evidence_id: item.stable_id, owner_kind: owner.kind, owner_key: owner.key, role: owner.role };
    }
  }
  let linkCount = 0;
  for (const _link of links()) linkCount++;
  const evidenceLinks: SnapshotQueryRows<SnapshotQueryEvidenceLinkRow> = { length: linkCount, [Symbol.iterator]: links };
  const evidenceIds = [...evidenceMap.keys()].sort((a, b) => a.localeCompare(b));
  const evidence: SnapshotQueryRows<SnapshotQueryEvidenceRow> = {
    length: evidenceIds.length,
    *[Symbol.iterator]() { for (const id of evidenceIds) yield evidenceRow(publicKey, snapshotId, evidenceMap.get(id)!); },
  };
  const memberships = (view.graph.overlays ?? []).flatMap((overlay) => [
    ...overlay.member_entity_ids.map((entityId) => ({
      public_snapshot_key: publicKey,
      snapshot_id: snapshotId,
      overlay_id: overlay.id,
      overlay_kind: overlay.kind,
      entity_id: entityId,
      relation_id: null,
      role: "member" as const,
      payload: { name: overlay.name, responsibility: overlay.responsibility },
    })),
    ...overlay.relation_ids.map((relationId) => ({
      public_snapshot_key: publicKey,
      snapshot_id: snapshotId,
      overlay_id: overlay.id,
      overlay_kind: overlay.kind,
      entity_id: "",
      relation_id: relationId,
      role: "relation" as const,
      payload: { name: overlay.name, responsibility: overlay.responsibility },
    })),
  ]);
  const projections = (Object.values(view.graph.projections ?? {}) as SnapshotProjection[]).flatMap((projection) =>
    projection.nodes.map((node) => ({
      public_snapshot_key: publicKey,
      snapshot_id: snapshotId,
      projection_kind: projection.kind,
      projection_node_id: node.projection_node_id,
      entity_id: node.entity_id,
      parent_projection_node_id: node.parent_projection_node_id,
      depth: node.depth,
      aggregate_member_entity_ids: node.aggregate_member_entity_ids,
      evidence_ids: node.evidence_ids,
      overlay_ids: node.overlay_ids ?? [],
      payload: {},
    })),
  );
  const aggregates = (Object.values(view.graph.projections ?? {}) as SnapshotProjection[]).flatMap((projection) => {
    const projectionNodes = new Map(projection.nodes.map((node) => [node.projection_node_id, node]));
    return projection.edges.map((edge) => {
      const source = projectionNodes.get(edge.source_projection_node_id);
      const target = projectionNodes.get(edge.target_projection_node_id);
      return {
        public_snapshot_key: publicKey,
        snapshot_id: snapshotId,
        projection_kind: projection.kind,
        projection_edge_id: edge.projection_edge_id,
        relation_id: edge.relation_id,
        source_projection_node_id: edge.source_projection_node_id,
        target_projection_node_id: edge.target_projection_node_id,
        source_entity_id: source?.entity_id ?? "",
        target_entity_id: target?.entity_id ?? "",
        aggregate_relation_ids: edge.aggregate_relation_ids,
        evidence_ids: edge.evidence_ids,
        overlay_ids: edge.overlay_ids ?? [],
        payload: {},
      };
    });
  });
  // Hash exactly the same JSON representation without creating a repository-
  // sized string or retaining every section's sort keys at once.
  const digest = createHash('sha256').update('{');
  let firstField = true;
  const hashRows = (name: string, source: Iterable<unknown>) => {
    const rows = Array.from(source);
    digest.update((firstField ? '' : ',') + JSON.stringify(name) + ':[');
    firstField = false;
    rows.sort();
    for (let i = 0; i < rows.length; i++) {
      if (i) digest.update(',');
      digest.update(JSON.stringify(rows[i]));
    }
    digest.update(']');
  };
  hashRows('nodes', projectedRows([
    { values: semanticNodes, project: node => [nodeKey('component', node.id), node.lifecycle_status ?? 'active'] },
    { values: factNodes, project: node => [nodeKey('fact', node.id), node.lifecycle_status ?? 'active'] },
  ]));
  hashRows('edges', projectedRows([
    { values: semanticEdges, project: edge => [edgeKey('semantic', edge.id), nodeKey('component', edge.source), nodeKey('component', edge.target), edge.lifecycle_status ?? 'active'] },
    { values: factEdges, project: edge => [edgeKey('fact', edge.id), nodeKey('fact', edge.source), nodeKey('fact', edge.target), edge.lifecycle_status ?? 'active'] },
  ]));
  hashRows('evidence', evidenceMap.keys());
  hashRows('layers', layers.map(row => row.layer_id));
  hashRows('valuePoints', valuePoints.map(row => row.value_point_id));
  hashRows('memberships', memberships.map(row => [row.overlay_id, row.entity_id, row.relation_id, row.role]));
  hashRows('projections', projections.map(row => [row.projection_kind, row.projection_node_id, row.entity_id, row.overlay_ids]));
  hashRows('aggregates', aggregates.map(row => [row.projection_kind, row.projection_edge_id, row.overlay_ids]));
  return {
    public_snapshot_key: publicKey,
    snapshot_id: snapshotId,
    nodes,
    edges,
    evidence,
    evidence_links: evidenceLinks,
    layers,
    value_points: valuePoints,
    memberships,
    projections,
    aggregates,
    digest: digest.update('}').digest('hex'),
  };
}

/** Materialize only for in-memory querying; database publication uses the row source. */
export function buildSnapshotQueryDirectory(
  publicKey: string, snapshotId: string, view: unknown, analysis: unknown,
): SnapshotQueryDirectory {
  const source = streamSnapshotQueryDirectory(publicKey, snapshotId, view, analysis);
  return { ...source, nodes: Array.from(source.nodes), edges: Array.from(source.edges),
    evidence: Array.from(source.evidence), evidence_links: Array.from(source.evidence_links) };
}

export function cursorKey(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.startsWith("k:") ? decoded.slice(2) : null;
  } catch {
    return null;
  }
}

export function encodeSnapshotQueryCursor(key: string): string {
  return Buffer.from(`k:${key}`, "utf8").toString("base64url");
}

/** Literal, case-insensitive human text search; machine IDs use explicit ID
 * filters. Arbitrary payload JSON is deliberately not a searchable document. */
export function nodeSearchText(row: SnapshotQueryNodeRow): string {
  return [row.name,row.label,row.responsibility,row.path].filter(Boolean).join(' ').toLowerCase();
}
export function edgeSearchText(row: SnapshotQueryEdgeRow): string {
  return [row.relation_kind,row.label,row.description].filter(Boolean).join(' ').toLowerCase();
}
export function nodeMatches(row: SnapshotQueryNodeRow, input: SnapshotQueryInput): boolean {
  const textValue = input.text?.trim().toLowerCase() ?? "";
  const paths = input.paths ?? [];
  const languages = (input.languages ?? []).map((item) => item.toLowerCase());
  const ids = new Set([...(input.component_ids ?? []), ...(input.entity_ids ?? [])]);
  const symbolIds = new Set(input.symbol_ids ?? []);
  const searchable = nodeSearchText(row);
  const exactEntityFilter = !ids.size || !input.scope || input.scope === "self";
  return (!textValue || searchable.includes(textValue))
    && (!paths.length || paths.some((path) => (row.path ?? "").includes(path)))
    && (!languages.length || (row.language !== null && languages.includes(row.language.toLowerCase())))
    && (!symbolIds.size || symbolIds.has(row.node_id) || symbolIds.has(row.node_key))
    && (!ids.size || !exactEntityFilter || ids.has(row.node_id) || ids.has(row.node_key))
    && (!(input.entity_kinds?.length) || input.entity_kinds.includes(row.entity_kind));
}

function scopedNodeKeys(directory: SnapshotQueryDirectory, input: SnapshotQueryInput): Set<string> | null {
  const ids = new Set([...(input.entity_ids ?? []), ...(input.component_ids ?? [])]);
  if (!ids.size || !input.scope || input.scope === "self") return ids.size ? new Set(
    directory.nodes.filter((row) => ids.has(row.node_id) || ids.has(row.node_key)).map((row) => row.node_key),
  ) : null;
  const byId = new Map(directory.nodes.map((row) => [row.node_id, row]));
  const result = new Set<string>();
  if (input.scope === "neighbors") {
    for (const edge of directory.edges) {
      if (ids.has(edge.source_node_key) || ids.has(edge.target_node_key)
        || ids.has(edge.source_node_key.replace(/^[^:]+:/, ""))
        || ids.has(edge.target_node_key.replace(/^[^:]+:/, ""))) {
        result.add(edge.source_node_key);
        result.add(edge.target_node_key);
      }
    }
    return result;
  }
  for (const row of directory.nodes) {
    let current: SnapshotQueryNodeRow | undefined = row;
    const visited = new Set<string>();
    while (current && !visited.has(current.node_id)) {
      visited.add(current.node_id);
      if (ids.has(current.node_id) || ids.has(current.node_key)) {
        if (input.scope === "ancestors") result.add(row.node_key);
        else result.add(row.node_key);
        break;
      }
      if (!current.parent_entity_id) break;
      current = byId.get(current.parent_entity_id);
    }
  }
  if (input.scope === "ancestors") {
    result.clear();
    for (const id of ids) {
      let current = byId.get(id) ?? directory.nodes.find((row) => row.node_key === id);
      const visited = new Set<string>();
      while (current && !visited.has(current.node_key)) {
        visited.add(current.node_key);
        result.add(current.node_key);
        current = current.parent_entity_id ? byId.get(current.parent_entity_id) : undefined;
      }
    }
  }
  return result;
}

export function edgeMatches(row: SnapshotQueryEdgeRow, input: SnapshotQueryInput): boolean {
  const textValue = input.text?.trim().toLowerCase() ?? "";
  const kinds = new Set(input.relation_kinds ?? []);
  const searchable = edgeSearchText(row);
  return (!textValue || searchable.includes(textValue))
    && (!kinds.size || kinds.has(row.relation_kind));
}

/** Structural filters scope edges to incident selected nodes, including empty matches.
 * Text-only and relation-only queries remain graph-wide. Explicit expansion may
 * traverse outside the seed filters, as before. */
export function hasNodeScope(input: SnapshotQueryInput): boolean {
  return Boolean(input.entity_ids?.length || input.component_ids?.length || input.paths?.length
    || input.languages?.length || input.symbol_ids?.length || input.entity_kinds?.length
    || input.depth !== undefined || input.projection);
}

export function selectSnapshotQueryCandidates(
  directory: SnapshotQueryDirectory,
  input: SnapshotQueryInput,
): { nodes: SnapshotQueryNodeRow[]; edges: SnapshotQueryEdgeRow[] } {
  let nodes = directory.nodes.filter((row) => nodeMatches(row, input));
  const scoped = scopedNodeKeys(directory, input);
  if (scoped) nodes = nodes.filter((row) => scoped.has(row.node_key));
  if (input.entity_kinds?.length) {
    const kinds = new Set(input.entity_kinds);
    nodes = nodes.filter((row) => kinds.has(row.entity_kind));
  }
  if (input.depth !== undefined) {
    const depth = Math.max(0, Math.min(100, Math.floor(input.depth)));
    nodes = nodes.filter((row) => row.depth <= depth);
  }
  if (input.projection) {
    const projected = new Set((directory.projections ?? [])
      .filter((row) => row.projection_kind === input.projection)
      .map((row) => row.entity_id));
    nodes = nodes.filter((row) => projected.has(row.node_id));
  }
  let edges = directory.edges.filter((row) => edgeMatches(row, input));
  const matchedNodeKeys = new Set(nodes.map((row) => row.node_key));
  if (hasNodeScope(input)) {
    edges = edges.filter((edge) => matchedNodeKeys.has(edge.source_node_key) || matchedNodeKeys.has(edge.target_node_key));
  }
  const expand = Math.max(0, Math.min(2, Math.floor(input.expand_hops ?? 0)));
  for (let hop = 0; hop < expand; hop += 1) {
    const frontier = new Set(matchedNodeKeys);
    for (const edge of directory.edges) {
      if (!frontier.has(edge.source_node_key) && !frontier.has(edge.target_node_key)) continue;
      matchedNodeKeys.add(edge.source_node_key);
      matchedNodeKeys.add(edge.target_node_key);
    }
    nodes = directory.nodes.filter((row) => matchedNodeKeys.has(row.node_key));
    edges = directory.edges.filter((row) => matchedNodeKeys.has(row.source_node_key) || matchedNodeKeys.has(row.target_node_key));
  }
  return { nodes, edges };
}

export function rankSnapshotQueryCandidates(nodes: SnapshotQueryNodeRow[], edges: SnapshotQueryEdgeRow[], input: SnapshotQueryInput): QueryItem[] {
  const candidates: QueryItem[] = [
    ...nodes.map((row) => ({ key: `0:${row.node_key}`, row, kind: "node" as const, relevance: scoreNode(row, input).score })),
    ...edges.map((row) => ({ key: `1:${row.edge_key}`, row, kind: "edge" as const, relevance: scoreEdge(row, input).score })),
  ];
  return candidates.sort((left, right) => {
      if (input.scope === "subtree" || input.scope === "ancestors") {
        const leftDepth = left.kind === "node" ? left.row.depth : Number.MAX_SAFE_INTEGER;
        const rightDepth = right.kind === "node" ? right.row.depth : Number.MAX_SAFE_INTEGER;
        if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      }
      return right.relevance - left.relevance || Buffer.compare(Buffer.from(left.key), Buffer.from(right.key));
    });
}

export function pageSnapshotQueryCandidates(directory: SnapshotQueryDirectory, input: SnapshotQueryInput, combined: QueryItem[]): SnapshotQueryResult {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const after = cursorKey(input.cursor);
  const afterIndex = after ? combined.findIndex((item) => item.key === after) : -1;
  let filtered = afterIndex >= 0 ? combined.slice(afterIndex + 1) : combined;
  if (input.include_payload === false) filtered = filtered.map(item => ({...item,row:{...item.row,payload:{}}} as QueryItem));
  if (input.evidence_per_owner) directory = boundQueryEvidence(directory,filtered.slice(0,limit),input.evidence_per_owner);
  const budget = input.evidence_budget_tokens !== undefined
    ? Math.max(256, Math.floor(input.evidence_budget_tokens))
    : null;
  const page: QueryItem[] = [];
  let budgetStopped = false;
  let oversizedItem = false;
  const estimateItems = (items: QueryItem[]): number => {
    const itemNodes = items.filter((item): item is QueryNodeItem => item.kind === "node").map((item) => item.row);
    const itemEdges = items.filter((item): item is QueryEdgeItem => item.kind === "edge").map((item) => item.row);
    const owners = new Set([
      ...itemNodes.map((row) => `node:${row.node_key}`),
      ...itemEdges.map((row) => `edge:${row.edge_key}`),
    ]);
    const itemEvidenceIds = new Set(directory.evidence_links
      .filter((link) => owners.has(`${link.owner_kind}:${link.owner_key}`))
      .map((link) => link.evidence_id));
    return estimateQueryTokens({
      nodes: itemNodes,
      edges: itemEdges,
      evidence: directory.evidence.filter((row) => itemEvidenceIds.has(row.evidence_id)),
    });
  };
  for (const item of filtered) {
    if (page.length >= limit) break;
    if (budget !== null) {
      const estimate = estimateItems([...page, item]);
      if (estimate > budget && page.length > 0) {
        budgetStopped = true;
        break;
      }
      if (estimate > budget) oversizedItem = true;
    }
    page.push(item);
  }
  const pageNodes = page.filter((item): item is QueryNodeItem => item.kind === "node").map((item) => item.row);
  const pageEdges = page.filter((item): item is QueryEdgeItem => item.kind === "edge").map((item) => item.row);
  const ownerKeys = new Set([
    ...pageNodes.map((row) => `node:${row.node_key}`),
    ...pageEdges.map((row) => `edge:${row.edge_key}`),
  ]);
  const evidenceIds = new Set(directory.evidence_links.filter((link) => ownerKeys.has(`${link.owner_kind}:${link.owner_key}`)).map((link) => link.evidence_id));
  const returnedEvidence = directory.evidence.filter((row) => evidenceIds.has(row.evidence_id));
  const hasMore = filtered.length > page.length;
  const truncationReason = hasMore
    ? budgetStopped
      ? oversizedItem ? "item_exceeds_budget" : "token_budget"
      : "limit"
    : oversizedItem ? "item_exceeds_budget" : null;
  return {
    public_snapshot_key: directory.public_snapshot_key,
    snapshot_id: directory.snapshot_id,
    nodes: pageNodes,
    edges: pageEdges,
    evidence: returnedEvidence,
    evidence_links: directory.evidence_links.filter((row) => evidenceIds.has(row.evidence_id)),
    layers: input.include_metadata === false ? [] : directory.layers,
    value_points: input.include_metadata === false ? [] : directory.value_points,
    memberships: input.include_metadata === false ? [] : directory.memberships ?? [],
    projections: input.include_metadata === false ? [] : directory.projections ?? [],
    aggregates: input.include_metadata === false ? [] : directory.aggregates ?? [],
    next_cursor: hasMore && page.length ? encodeSnapshotQueryCursor(page[page.length - 1]!.key) : null,
    truncated: hasMore,
    estimated_tokens: estimateQueryTokens({ nodes: pageNodes, edges: pageEdges, evidence: returnedEvidence }),
    budget_tokens: budget,
    returned_evidence_count: returnedEvidence.length,
    ...(input.evidence_per_owner ? {evidence_truncated:Boolean((directory as SnapshotQueryDirectory & {evidence_truncated?:boolean}).evidence_truncated)} : {}),
    truncation_reason: truncationReason,
  };
}

export function querySnapshotQueryDirectory(directory: SnapshotQueryDirectory, input: SnapshotQueryInput): SnapshotQueryResult {
  const { nodes, edges } = selectSnapshotQueryCandidates(directory, input);
  return pageSnapshotQueryCandidates(directory, input, rankSnapshotQueryCandidates(nodes, edges, input));
}

/** Match the Agent's visible evidence allowance before payload hydration. */
export function boundQueryEvidence(directory: SnapshotQueryDirectory, items: QueryItem[],
  limits: { node: number; edge: number }): SnapshotQueryDirectory & { evidence_truncated: boolean } {
  const links: SnapshotQueryEvidenceLinkRow[] = [];
  let truncated = Boolean((directory as { evidence_truncated?: boolean }).evidence_truncated);
  for (const item of items) {
    const ownerKey = item.kind === 'node' ? (item.row as SnapshotQueryNodeRow).node_key : (item.row as SnapshotQueryEdgeRow).edge_key;
    const candidates = directory.evidence_links.filter(link => link.owner_kind === item.kind && link.owner_key === ownerKey);
    const ids = [...new Set(candidates.map(link => link.evidence_id))].sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)));
    const count = Math.max(0,Math.min(100,Math.floor(limits[item.kind])));
    truncated ||= ids.length > count;
    const selected = new Set(ids.slice(0,count));
    links.push(...candidates.filter(link => selected.has(link.evidence_id)));
  }
  const ids = new Set(links.map(link => link.evidence_id));
  return {...directory,evidence_links:links,evidence:directory.evidence.filter(row=>ids.has(row.evidence_id)),evidence_truncated:truncated};
}
