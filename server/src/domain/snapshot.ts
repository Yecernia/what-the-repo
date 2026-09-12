/**
 * Product-facing evidence snapshot types.
 *
 * The analyzer may add internal fields, but tools and the Web contract use this
 * narrow shape so a model never receives an unbounded database object.
 */
export interface SnapshotEvidence {
  stable_id: string;
  label: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  kind: string;
  source_id?: string;
  target_id?: string;
  source_label?: string | null;
  target_label?: string | null;
}

export const EVIDENCE_GRAPH_SCHEMA_VERSION = "evidence-graph-v2" as const;

export type SnapshotEntityKind =
  | "repository"
  | "system"
  | "subsystem"
  | "domain"
  | "module"
  | "component"
  | "fact";

export type SnapshotOverlayKind = "community" | "architecture_layer" | "process" | "runtime";
export type SnapshotProjectionKind = "human" | "agent";

export interface SnapshotMainHierarchy {
  root_entity_ids: string[];
  max_depth: number;
}

export interface SnapshotOverlay {
  id: string;
  kind: SnapshotOverlayKind;
  name: string;
  responsibility: string;
  member_entity_ids: string[];
  relation_ids: string[];
  evidence_ids: string[];
  certainty: string;
  attributes?: Record<string, unknown>;
}

export interface SnapshotProjectionNode {
  projection_node_id: string;
  entity_id: string;
  parent_projection_node_id: string | null;
  depth: number;
  aggregate_member_entity_ids: string[];
  evidence_ids: string[];
  /** Typed overlay IDs that explain why this projected entity is visible. */
  overlay_ids?: string[];
}

export interface SnapshotProjectionEdge {
  projection_edge_id: string;
  relation_id: string | null;
  source_projection_node_id: string;
  target_projection_node_id: string;
  aggregate_relation_ids: string[];
  evidence_ids: string[];
  /** Typed overlay IDs that explain the projected relation. */
  overlay_ids?: string[];
}

export interface SnapshotProjection {
  kind: SnapshotProjectionKind;
  snapshot_id: string;
  nodes: SnapshotProjectionNode[];
  edges: SnapshotProjectionEdge[];
  truncated: boolean;
  next_cursor: string | null;
  partial?: boolean;
  omitted_entity_count?: number;
  omitted_relation_count?: number;
}

export interface SnapshotNode {
  id: string;
  entity_kind?: SnapshotEntityKind;
  parent_entity_id?: string | null;
  depth?: number;
  label: string;
  name: string;
  responsibility: string;
  grouping_rationale?: string;
  architecture_layer_id: string | null;
  architecture_layer_name: string | null;
  architecture_layer_candidates?: Array<{ id: string; name: string }>;
  architecture_layer_rationale?: string | null;
  architecture_layer_certainty?: string;
  members: SnapshotEvidence[];
  member_count: number;
  evidence: SnapshotEvidence[];
  certainty: string;
  review_status: string;
  source_report_ids?: string[];
  fan_in: number;
  fan_out: number;
  attributes?: Record<string, unknown>;
  source_observations?: Array<Record<string, unknown>>;
  lifecycle_status?: "active" | "tombstoned" | "superseded";
  tombstoned_at_snapshot_id?: string | null;
  first_seen_snapshot_id?: string | null;
  last_seen_snapshot_id?: string | null;
  superseded_by?: string | null;
  revision_id?: string;
  incremental_provenance?: Record<string, unknown> | null;
}

export interface SnapshotEdge {
  id: string;
  source: string;
  target: string;
  relation_kind: string;
  label: string;
  description: string;
  certainty: string;
  evidence: SnapshotEvidence[];
  weight: number;
  source_observations?: Array<Record<string, unknown>>;
  lifecycle_status?: "active" | "tombstoned" | "superseded";
  tombstoned_at_snapshot_id?: string | null;
  first_seen_snapshot_id?: string | null;
  last_seen_snapshot_id?: string | null;
  superseded_by?: string | null;
  revision_id?: string;
  incremental_provenance?: Record<string, unknown> | null;
}

export interface SnapshotLayer {
  id: string;
  name: string;
  responsibility: string;
  component_ids: string[];
  evidence: SnapshotEvidence[];
  certainty: string;
  source_report_ids?: string[];
}

export interface SnapshotValuePoint {
  stable_id: string;
  kind: string;
  component_ids?: string[];
  title: string;
  claim: string;
  problem: string | null;
  implementation: string | null;
  tradeoffs: string | null;
  transfer_conditions: string | null;
  certainty: string;
  evidence: SnapshotEvidence[];
  connectivity: number;
}

export interface SnapshotLearningStep {
  step_id: string;
  order: number;
  title: string;
  objective: string;
  evidence_refs: string[];
  component_ids: string[];
  completion_check: string;
}

export interface RepositoryResearchPage {
  truncated?: boolean;
  url: string;
  title: string;
  content: string;
  source_kind: "official" | "readme" | "community_search";
}

export interface RepositoryResearch {
  research_version: string;
  repository: string;
  commit_sha: string;
  description: string | null;
  homepage: string | null;
  topics: string[];
  stars: number | null;
  forks: number | null;
  readme: RepositoryResearchPage | null;
  official_pages: RepositoryResearchPage[];
  web_search_results: RepositoryResearchPage[];
  community_signals: string[];
}

export interface EvidenceSnapshot {
  snapshot_id: string;
  display_language?: string;
  language_overlay_status?: "ready" | "degraded";
  parent_snapshot_id?: string | null;
  analysis_mode?: "full" | "incremental";
  active_fact_fingerprint?: string;
  summary: Record<string, number>;
  graph: {
    schema_version?: typeof EVIDENCE_GRAPH_SCHEMA_VERSION;
    semantic_mode: string;
    semantic_coverage?: {
      total_components: number;
      provider_supported_components: number;
      degraded_component_ids: string[];
    };
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
    layers: SnapshotLayer[];
    unassigned_component_ids: string[];
    hierarchy?: SnapshotMainHierarchy;
    overlays?: SnapshotOverlay[];
    hierarchy_operations?: Array<Record<string, unknown>>;
    projections?: {
      human: SnapshotProjection;
      agent: SnapshotProjection;
    };
  };
  fact_graph?: {
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
  };
  value_points: SnapshotValuePoint[];
  languages: Array<{
    language: string;
    quality_tier: string;
    files_seen: number;
    files_analyzed: number;
    files_failed: number;
    reason_codes: string[];
    adapter_name?: string;
    adapter_version?: string;
    lsp_name?: string | null;
    lsp_version?: string | null;
    parser_name?: string | null;
    parser_version?: string | null;
    capabilities?: string[];
  }>;
  source_reports?: Array<Record<string, unknown>>;
  learning_plan: {
    snapshot_id: string;
    selected_value_point: string | null;
    steps: SnapshotLearningStep[];
  };
  repository?: string;
  commit_sha?: string;
  source_root?: string;
  research?: RepositoryResearch;
}

export interface NormalizedSnapshotNode extends SnapshotNode {
  entity_kind: SnapshotEntityKind;
  parent_entity_id: string | null;
  depth: number;
}

export type NormalizedEvidenceSnapshot = Omit<EvidenceSnapshot, "graph"> & {
  graph: Omit<
    EvidenceSnapshot["graph"],
    "schema_version" | "nodes" | "hierarchy" | "overlays" | "projections"
  > & {
    schema_version: typeof EVIDENCE_GRAPH_SCHEMA_VERSION;
    nodes: NormalizedSnapshotNode[];
    hierarchy: SnapshotMainHierarchy;
    overlays: SnapshotOverlay[];
    projections: {
      human: SnapshotProjection;
      agent: SnapshotProjection;
    };
  };
};

const ENTITY_KINDS = new Set<SnapshotEntityKind>([
  "repository",
  "system",
  "subsystem",
  "domain",
  "module",
  "component",
  "fact",
]);

const OVERLAY_KINDS = new Set<SnapshotOverlayKind>([
  "community",
  "architecture_layer",
  "process",
  "runtime",
]);

function records<T>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function evidenceRows(value: unknown): SnapshotEvidence[] {
  return records<SnapshotEvidence>(value).filter((item) => typeof item.stable_id === "string");
}

function normalizedDepth(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function normalizeNode(node: SnapshotNode, defaultKind: SnapshotEntityKind): NormalizedSnapshotNode {
  const attributes = node.attributes ?? {};
  const structuralGroup = typeof attributes.structural_group === "string"
    ? attributes.structural_group
    : null;
  const members = evidenceRows(node.members);
  const evidence = evidenceRows(node.evidence);
  const memberPaths = members
    .map((item) => item.path)
    .filter(Boolean)
    .slice(0, 3);
  const fallbackRationale = structuralGroup
    ? `程序根据成员所在的结构目录“${structuralGroup}”将它们聚合；这是静态结构依据，不等同于语义结论。`
    : memberPaths.length
      ? `当前快照只确认这些成员共同出现在 ${memberPaths.join("、")} 等路径中；语义归组理由尚未随旧快照保存。`
      : "当前快照没有保存可展示的归组依据。";
  return {
    ...node,
    entity_kind: ENTITY_KINDS.has(node.entity_kind as SnapshotEntityKind)
      ? node.entity_kind as SnapshotEntityKind
      : defaultKind,
    parent_entity_id: typeof node.parent_entity_id === "string" && node.parent_entity_id
      ? node.parent_entity_id
      : null,
    depth: normalizedDepth(node.depth),
    members,
    member_count: Number.isSafeInteger(node.member_count) ? Number(node.member_count) : members.length,
    evidence,
    grouping_rationale: typeof node.grouping_rationale === "string" && node.grouping_rationale.trim()
      ? node.grouping_rationale
      : fallbackRationale,
    architecture_layer_candidates: Array.isArray(node.architecture_layer_candidates)
      ? node.architecture_layer_candidates
      : [],
    architecture_layer_rationale: typeof node.architecture_layer_rationale === "string"
      ? node.architecture_layer_rationale
      : null,
    architecture_layer_certainty: node.architecture_layer_certainty ?? node.certainty ?? "unknown",
    source_report_ids: Array.isArray(node.source_report_ids) ? node.source_report_ids : [],
  };
}

function normalizeLayer(layer: SnapshotLayer): SnapshotLayer {
  return {
    ...layer,
    component_ids: strings(layer.component_ids),
    evidence: evidenceRows(layer.evidence),
    source_report_ids: Array.isArray(layer.source_report_ids) ? layer.source_report_ids : [],
  };
}

function normalizeEdge(edge: SnapshotEdge): SnapshotEdge {
  return { ...edge, evidence: evidenceRows(edge.evidence) };
}

function normalizeOverlay(overlay: SnapshotOverlay): SnapshotOverlay {
  return {
    ...overlay,
    kind: OVERLAY_KINDS.has(overlay.kind as SnapshotOverlayKind)
      ? overlay.kind as SnapshotOverlayKind
      : "community",
    member_entity_ids: strings(overlay.member_entity_ids),
    relation_ids: strings(overlay.relation_ids),
    evidence_ids: strings(overlay.evidence_ids),
  };
}

function identityProjection(
  kind: SnapshotProjectionKind,
  snapshotId: string,
  nodes: NormalizedSnapshotNode[],
  edges: SnapshotEdge[],
): SnapshotProjection {
  return {
    kind,
    snapshot_id: snapshotId,
    nodes: nodes.map((node) => ({
      projection_node_id: `${kind}:${node.id}`,
      entity_id: node.id,
      parent_projection_node_id: node.parent_entity_id ? `${kind}:${node.parent_entity_id}` : null,
      depth: node.depth,
      aggregate_member_entity_ids: [],
      evidence_ids: [...new Set([...node.evidence, ...node.members].map((item) => item.stable_id))],
    })),
    edges: edges.map((edge) => ({
      projection_edge_id: `${kind}:${edge.id}`,
      relation_id: edge.id,
      source_projection_node_id: `${kind}:${edge.source}`,
      target_projection_node_id: `${kind}:${edge.target}`,
      aggregate_relation_ids: [edge.id],
      evidence_ids: [...new Set(edge.evidence.map((item) => item.stable_id))],
    })),
    truncated: false,
    next_cursor: null,
  };
}

function normalizeProjection(
  value: SnapshotProjection | undefined,
  kind: SnapshotProjectionKind,
  snapshotId: string,
  fallback: SnapshotProjection,
): SnapshotProjection {
  if (!value || typeof value !== "object") return fallback;
  return {
    kind,
    snapshot_id: typeof value.snapshot_id === "string" ? value.snapshot_id : snapshotId,
    nodes: records<SnapshotProjectionNode>(value.nodes).map((node) => ({
      ...node,
      parent_projection_node_id: typeof node.parent_projection_node_id === "string"
        ? node.parent_projection_node_id
        : null,
      depth: normalizedDepth(node.depth),
      aggregate_member_entity_ids: strings(node.aggregate_member_entity_ids),
      evidence_ids: strings(node.evidence_ids),
      overlay_ids: strings(node.overlay_ids),
    })),
    edges: records<SnapshotProjectionEdge>(value.edges).map((edge) => ({
      ...edge,
      relation_id: typeof edge.relation_id === "string" ? edge.relation_id : null,
      aggregate_relation_ids: strings(edge.aggregate_relation_ids),
      evidence_ids: strings(edge.evidence_ids),
      overlay_ids: strings(edge.overlay_ids),
    })),
    truncated: value.truncated === true,
    next_cursor: typeof value.next_cursor === "string" ? value.next_cursor : null,
    partial: value.partial === true,
    omitted_entity_count: normalizedDepth(value.omitted_entity_count),
    omitted_relation_count: normalizedDepth(value.omitted_relation_count),
  };
}

function isCanonicalEvidenceSnapshot(value: unknown): value is NormalizedEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const graph = row.graph;
  if (typeof row.snapshot_id !== "string" || !graph || typeof graph !== "object") return false;
  const graphRow = graph as Record<string, unknown>;
  const hierarchy = graphRow.hierarchy;
  const projections = graphRow.projections;
  if (
    graphRow.schema_version !== EVIDENCE_GRAPH_SCHEMA_VERSION
    || !Array.isArray(graphRow.nodes)
    || !Array.isArray(graphRow.edges)
    || !Array.isArray(graphRow.layers)
    || !Array.isArray(graphRow.unassigned_component_ids)
    || !Array.isArray(graphRow.overlays)
    || !hierarchy || typeof hierarchy !== "object"
    || !Array.isArray((hierarchy as Record<string, unknown>).root_entity_ids)
    || !Number.isSafeInteger((hierarchy as Record<string, unknown>).max_depth)
    || !projections || typeof projections !== "object"
  ) return false;
  const projectionRow = projections as Record<string, unknown>;
  const projectionShape = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    return Array.isArray(item.nodes) && Array.isArray(item.edges);
  };
  if (!projectionShape(projectionRow.human) || !projectionShape(projectionRow.agent)) return false;
  const nodeShape = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    return typeof item.id === "string"
      && typeof item.entity_kind === "string"
      && Object.prototype.hasOwnProperty.call(item, "parent_entity_id")
      && Number.isSafeInteger(item.depth)
      && Array.isArray(item.members)
      && Array.isArray(item.evidence);
  };
  const edgeShape = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    return typeof item.id === "string"
      && typeof item.source === "string"
      && typeof item.target === "string"
      && Array.isArray(item.evidence);
  };
  if (!graphRow.nodes.every(nodeShape) || !graphRow.edges.every(edgeShape)) return false;
  const factGraph = row.fact_graph;
  if (factGraph !== undefined) {
    if (!factGraph || typeof factGraph !== "object") return false;
    const factRow = factGraph as Record<string, unknown>;
    if (!Array.isArray(factRow.nodes) || !Array.isArray(factRow.edges)
      || !factRow.nodes.every(nodeShape) || !factRow.edges.every(edgeShape)) return false;
  }
  const learningPlan = row.learning_plan;
  return Array.isArray(row.value_points)
    && Array.isArray(row.languages)
    && Boolean(learningPlan && typeof learningPlan === "object")
    && Array.isArray((learningPlan as Record<string, unknown>).steps);
}

export function asEvidenceSnapshot(value: unknown): NormalizedEvidenceSnapshot | null {
  if (isCanonicalEvidenceSnapshot(value)) return value;
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const graph = row.graph;
  if (!graph || typeof graph !== "object") return null;
  const graphRow = graph as Record<string, unknown>;
  if (!Array.isArray(graphRow.nodes) || !Array.isArray(graphRow.edges)) return null;
  const snapshotId = typeof row.snapshot_id === "string" ? row.snapshot_id : "";
  const nodes = records<SnapshotNode>(graphRow.nodes).map((node) => normalizeNode(node, "component"));
  const edges = records<SnapshotEdge>(graphRow.edges).map(normalizeEdge);
  const layers = records<SnapshotLayer>(graphRow.layers).map(normalizeLayer);
  const hierarchyRow = graphRow.hierarchy && typeof graphRow.hierarchy === "object"
    ? graphRow.hierarchy as Partial<SnapshotMainHierarchy>
    : null;
  const rootIds = nodes.filter((node) => node.parent_entity_id === null).map((node) => node.id);
  const hierarchy: SnapshotMainHierarchy = hierarchyRow ? {
    root_entity_ids: strings(hierarchyRow.root_entity_ids),
    max_depth: normalizedDepth(hierarchyRow.max_depth),
  } : {
    root_entity_ids: rootIds,
    max_depth: nodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0),
  };
  const overlays = Array.isArray(graphRow.overlays)
    ? records<SnapshotOverlay>(graphRow.overlays).map(normalizeOverlay)
    : layers.map((layer): SnapshotOverlay => ({
        id: layer.id,
        kind: "architecture_layer",
        name: layer.name,
        responsibility: layer.responsibility,
        member_entity_ids: [...layer.component_ids],
        relation_ids: [],
        evidence_ids: [...new Set(layer.evidence.map((item) => item.stable_id))],
        certainty: layer.certainty,
      }));
  const fallbackHuman = identityProjection("human", snapshotId, nodes, edges);
  const fallbackAgent = identityProjection("agent", snapshotId, nodes, edges);
  const projectionRow = graphRow.projections && typeof graphRow.projections === "object"
    ? graphRow.projections as Partial<Record<SnapshotProjectionKind, SnapshotProjection>>
    : {};
  const factGraphRow = row.fact_graph && typeof row.fact_graph === "object"
    ? row.fact_graph as Record<string, unknown>
    : null;
  const factGraph = factGraphRow && Array.isArray(factGraphRow.nodes) && Array.isArray(factGraphRow.edges)
    ? {
        nodes: records<SnapshotNode>(factGraphRow.nodes).map((node) => normalizeNode(node, "fact")),
        edges: records<SnapshotEdge>(factGraphRow.edges).map(normalizeEdge),
      }
    : undefined;
  return {
    ...(value as EvidenceSnapshot),
    graph: {
      ...graphRow,
      schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
      nodes,
      edges,
      layers,
      unassigned_component_ids: strings(graphRow.unassigned_component_ids),
      hierarchy,
      overlays,
      hierarchy_operations: Array.isArray(graphRow.hierarchy_operations)
        ? graphRow.hierarchy_operations.filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item))) as Array<Record<string, unknown>>
        : [],
      projections: {
        human: normalizeProjection(projectionRow.human, "human", snapshotId, fallbackHuman),
        agent: normalizeProjection(projectionRow.agent, "agent", snapshotId, fallbackAgent),
      },
    },
    fact_graph: factGraph,
  } as NormalizedEvidenceSnapshot;
}
