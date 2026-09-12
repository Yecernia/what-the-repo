import { createHash } from "node:crypto";
import type {
  SnapshotEdge,
  SnapshotEntityKind,
  SnapshotEvidence,
  SnapshotNode,
  SnapshotOverlay,
  SnapshotProjection,
  SnapshotProjectionEdge,
  SnapshotProjectionKind,
  SnapshotProjectionNode,
} from "./snapshot.js";

export interface SnapshotProjectionInput {
  snapshot_id: string;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  overlays?: SnapshotOverlay[];
  max_human_depth?: number;
  human_collapse_threshold?: number;
}

export interface SnapshotProjectionPair {
  human: SnapshotProjection;
  agent: SnapshotProjection;
}

const DEFAULT_HUMAN_DEPTH = 2;
const DEFAULT_HUMAN_COLLAPSE_THRESHOLD = 24;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function activeNode(node: SnapshotNode): boolean {
  return node.lifecycle_status !== "tombstoned" && node.lifecycle_status !== "superseded";
}

function activeEdge(edge: SnapshotEdge): boolean {
  return edge.lifecycle_status !== "tombstoned" && edge.lifecycle_status !== "superseded";
}

function evidenceForNode(node: SnapshotNode): SnapshotEvidence[] {
  const seen = new Set<string>();
  const result: SnapshotEvidence[] = [];
  for (const row of [...node.evidence, ...node.members]) {
    if (!row?.stable_id || seen.has(row.stable_id)) continue;
    seen.add(row.stable_id);
    result.push(row);
  }
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function entityKindRank(kind: SnapshotEntityKind | undefined): number {
  const order: SnapshotEntityKind[] = ["repository", "system", "subsystem", "domain", "module", "component", "fact"];
  const index = order.indexOf(kind ?? "component");
  return index < 0 ? order.length : index;
}

function overlayIndex(overlays: SnapshotOverlay[] | undefined): {
  entities: Map<string, string[]>;
  relations: Map<string, string[]>;
} {
  const entities = new Map<string, string[]>();
  const relations = new Map<string, string[]>();
  for (const overlay of overlays ?? []) {
    for (const entityId of overlay.member_entity_ids) {
      entities.set(entityId, [...(entities.get(entityId) ?? []), overlay.id]);
    }
    for (const relationId of overlay.relation_ids) {
      relations.set(relationId, [...(relations.get(relationId) ?? []), overlay.id]);
    }
  }
  for (const [key, values] of entities) entities.set(key, unique(values));
  for (const [key, values] of relations) relations.set(key, unique(values));
  return { entities, relations };
}

function projectionNodeId(kind: SnapshotProjectionKind, entityId: string): string {
  return `${kind}:entity:${entityId}`;
}

function directProjectionNode(
  kind: SnapshotProjectionKind,
  snapshotId: string,
  node: SnapshotNode,
  parentProjectionNodeId: string | null,
  depth: number,
  aggregateMemberEntityIds: string[],
  overlays: string[],
): SnapshotProjectionNode {
  return {
    projection_node_id: projectionNodeId(kind, node.id),
    entity_id: node.id,
    parent_projection_node_id: parentProjectionNodeId,
    depth,
    aggregate_member_entity_ids: unique(aggregateMemberEntityIds),
    evidence_ids: unique(evidenceForNode(node).map((row) => row.stable_id)),
    overlay_ids: overlays,
  };
}

function directProjectionEdge(
  kind: SnapshotProjectionKind,
  edge: SnapshotEdge,
  sourceEntityId: string,
  targetEntityId: string,
  overlays: string[],
): SnapshotProjectionEdge {
  return {
    projection_edge_id: `${kind}:relation:${edge.id}`,
    relation_id: edge.id,
    source_projection_node_id: projectionNodeId(kind, sourceEntityId),
    target_projection_node_id: projectionNodeId(kind, targetEntityId),
    aggregate_relation_ids: [edge.id],
    evidence_ids: unique(edge.evidence.map((row) => row.stable_id)),
    overlay_ids: overlays,
  };
}

function nearestVisibleAncestor(
  entityId: string,
  visible: Set<string>,
  byId: Map<string, SnapshotNode>,
): string | null {
  let current = byId.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (visible.has(current.id)) return current.id;
    visited.add(current.id);
    current = current.parent_entity_id ? byId.get(current.parent_entity_id) : undefined;
  }
  return null;
}

function descendantIds(
  entityId: string,
  children: Map<string, string[]>,
): string[] {
  const result: string[] = [];
  const queue = [...(children.get(entityId) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as string;
    result.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return result;
}

function buildAgentProjection(input: SnapshotProjectionInput, overlays: ReturnType<typeof overlayIndex>): SnapshotProjection {
  const nodes = input.nodes.filter(activeNode).sort((left, right) => (
    (left.depth ?? 0) - (right.depth ?? 0)
    || entityKindRank(left.entity_kind) - entityKindRank(right.entity_kind)
    || left.id.localeCompare(right.id)
  ));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const projectionNodes = nodes.map((node) => {
    const parent = node.parent_entity_id && byId.has(node.parent_entity_id)
      ? node.parent_entity_id
      : null;
    const depth = parent ? (byId.get(parent)?.depth ?? 0) + 1 : 0;
    return directProjectionNode(
      "agent",
      input.snapshot_id,
      node,
      parent ? projectionNodeId("agent", parent) : null,
      depth,
      [],
      overlays.entities.get(node.id) ?? [],
    );
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const projectionEdges = input.edges
    .filter((edge) => activeEdge(edge) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((edge) => directProjectionEdge(
      "agent",
      edge,
      edge.source,
      edge.target,
      overlays.relations.get(edge.id) ?? [],
    ));
  return {
    kind: "agent",
    snapshot_id: input.snapshot_id,
    nodes: projectionNodes,
    edges: projectionEdges,
    truncated: false,
    next_cursor: null,
    partial: false,
    omitted_entity_count: 0,
    omitted_relation_count: 0,
  };
}

function buildHumanProjection(input: SnapshotProjectionInput, overlays: ReturnType<typeof overlayIndex>): SnapshotProjection {
  const nodes = input.nodes.filter(activeNode);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parent_entity_id || !byId.has(node.parent_entity_id)) continue;
    children.set(node.parent_entity_id, [...(children.get(node.parent_entity_id) ?? []), node.id]);
  }
  const threshold = Math.max(1, Math.floor(input.human_collapse_threshold ?? DEFAULT_HUMAN_COLLAPSE_THRESHOLD));
  const maxDepth = Math.max(0, Math.floor(input.max_human_depth ?? DEFAULT_HUMAN_DEPTH));
  const collapse = nodes.length > threshold;
  const visible = new Set(nodes.filter((node) => !collapse || (node.depth ?? 0) <= maxDepth).map((node) => node.id));
  // A malformed/legacy parent chain must not make a visible node orphaned.
  for (const node of nodes.filter((candidate) => visible.has(candidate.id))) {
    let parent = node.parent_entity_id ? byId.get(node.parent_entity_id) : undefined;
    while (parent && !visible.has(parent.id)) {
      visible.add(parent.id);
      parent = parent.parent_entity_id ? byId.get(parent.parent_entity_id) : undefined;
    }
  }
  const visibleNodes = nodes.filter((node) => visible.has(node.id)).sort((left, right) => (
    (left.depth ?? 0) - (right.depth ?? 0)
    || entityKindRank(left.entity_kind) - entityKindRank(right.entity_kind)
    || left.id.localeCompare(right.id)
  ));
  const projectionNodes = visibleNodes.map((node) => {
    const parentEntityId = nearestVisibleAncestor(node.parent_entity_id ?? "", visible, byId);
    const parent = parentEntityId ? byId.get(parentEntityId) : undefined;
    const hiddenDescendants = descendantIds(node.id, children).filter((id) => !visible.has(id));
    const aggregateEvidence = hiddenDescendants.flatMap((id) => evidenceForNode(byId.get(id) as SnapshotNode));
    const aggregateOverlays = hiddenDescendants.flatMap((id) => overlays.entities.get(id) ?? []);
    const evidenceIds = unique([
      ...evidenceForNode(node).map((row) => row.stable_id),
      ...aggregateEvidence.map((row) => row.stable_id),
    ]);
    const projectionNode = directProjectionNode(
      "human",
      input.snapshot_id,
      node,
      parentEntityId ? projectionNodeId("human", parentEntityId) : null,
      parent ? (parent.depth ?? 0) + 1 : 0,
      hiddenDescendants,
      unique([...(overlays.entities.get(node.id) ?? []), ...aggregateOverlays]),
    );
    projectionNode.evidence_ids = evidenceIds;
    return projectionNode;
  });
  const projectedEntity = (entityId: string): string | null => nearestVisibleAncestor(entityId, visible, byId);
  const grouped = new Map<string, {
    source: string;
    target: string;
    relationIds: string[];
    evidenceIds: string[];
    overlayIds: string[];
  }>();
  for (const edge of input.edges.filter(activeEdge)) {
    const source = projectedEntity(edge.source);
    const target = projectedEntity(edge.target);
    if (!source || !target || source === target) continue;
    const [left, right] = [source, target].sort((a, b) => a.localeCompare(b));
    const key = `${left}\u0000${right}`;
    const group = grouped.get(key) ?? {
      source,
      target,
      relationIds: [],
      evidenceIds: [],
      overlayIds: [],
    };
    group.relationIds.push(edge.id);
    group.evidenceIds.push(...edge.evidence.map((row) => row.stable_id));
    group.overlayIds.push(...(overlays.relations.get(edge.id) ?? []));
    grouped.set(key, group);
  }
  const projectionEdges = [...grouped.values()].sort((left, right) =>
    `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`)).map((group) => {
    const relationIds = unique(group.relationIds);
    return {
      projection_edge_id: `human:aggregate:${hash(`${group.source}:${group.target}:${relationIds.join(",")}`)}`,
      relation_id: relationIds.length === 1 ? relationIds[0] as string : null,
      source_projection_node_id: projectionNodeId("human", group.source),
      target_projection_node_id: projectionNodeId("human", group.target),
      aggregate_relation_ids: relationIds,
      evidence_ids: unique(group.evidenceIds),
      overlay_ids: unique(group.overlayIds),
    } satisfies SnapshotProjectionEdge;
  });
  const omittedEntities = nodes.length - visibleNodes.length;
  const omittedRelations = input.edges.filter(activeEdge).length - groupEdgesCount(input, visible, byId);
  return {
    kind: "human",
    snapshot_id: input.snapshot_id,
    nodes: projectionNodes,
    edges: projectionEdges,
    truncated: false,
    next_cursor: null,
    partial: false,
    omitted_entity_count: Math.max(0, omittedEntities),
    omitted_relation_count: Math.max(0, omittedRelations),
  };
}

function groupEdgesCount(
  input: SnapshotProjectionInput,
  visible: Set<string>,
  byId: Map<string, SnapshotNode>,
): number {
  let count = 0;
  for (const edge of input.edges.filter(activeEdge)) {
    const source = nearestVisibleAncestor(edge.source, visible, byId);
    const target = nearestVisibleAncestor(edge.target, visible, byId);
    if (source && target && source !== target) count += 1;
  }
  return count;
}

/**
 * Derive read-only human and Agent projections from the canonical graph.
 * No node, edge, overlay or Evidence content is created or modified here.
 */
export function deriveSnapshotProjections(input: SnapshotProjectionInput): SnapshotProjectionPair {
  const overlays = overlayIndex(input.overlays);
  return {
    human: buildHumanProjection(input, overlays),
    agent: buildAgentProjection(input, overlays),
  };
}
