import {
  EVIDENCE_GRAPH_SCHEMA_VERSION,
  asEvidenceSnapshot,
  type EvidenceSnapshot,
  type NormalizedEvidenceSnapshot,
  type SnapshotEvidence,
  type SnapshotProjection,
} from "./snapshot.js";

export interface SnapshotValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface SnapshotValidationResult {
  valid: boolean;
  issues: SnapshotValidationIssue[];
}

function evidenceSignature(row: SnapshotEvidence): string {
  return JSON.stringify([
    row.path,
    row.start_line,
    row.end_line,
    row.kind,
    row.source_id ?? null,
    row.target_id ?? null,
  ]);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProjection(
  snapshot: NormalizedEvidenceSnapshot,
  projection: SnapshotProjection,
  knownEntityIds: Set<string>,
  knownRelationIds: Set<string>,
  knownEvidenceIds: Set<string>,
  knownOverlayIds: Set<string>,
  issue: (code: string, path: string, message: string) => void,
): void {
  const basePath = `graph.projections.${projection.kind}`;
  if (projection.snapshot_id !== snapshot.snapshot_id) {
    issue("projection_snapshot_mismatch", `${basePath}.snapshot_id`, "投影必须绑定当前 snapshot_id。" );
  }
  const projectionNodes = new Map<string, SnapshotProjection["nodes"][number]>();
  const projectedEntities = new Set<string>();
  for (const [index, node] of projection.nodes.entries()) {
    const path = `${basePath}.nodes[${index}]`;
    if (projectionNodes.has(node.projection_node_id)) {
      issue("duplicate_projection_node", `${path}.projection_node_id`, "投影节点 ID 重复。" );
    } else {
      projectionNodes.set(node.projection_node_id, node);
    }
    if (!knownEntityIds.has(node.entity_id)) {
      issue("projection_entity_missing", `${path}.entity_id`, "投影引用了不存在的实体。" );
    }
    if (projectedEntities.has(node.entity_id)) {
      issue("duplicate_projected_entity", `${path}.entity_id`, "同一实体在一个投影中只能出现一次。" );
    }
    projectedEntities.add(node.entity_id);
    if (!Number.isSafeInteger(node.depth) || node.depth < 0) {
      issue("projection_depth_invalid", `${path}.depth`, "投影 depth 必须是非负整数。" );
    }
    for (const memberId of node.aggregate_member_entity_ids) {
      if (!knownEntityIds.has(memberId)) {
        issue("projection_aggregate_member_missing", `${path}.aggregate_member_entity_ids`, "聚合成员不存在。" );
      }
    }
    for (const evidenceId of node.evidence_ids) {
      if (!knownEvidenceIds.has(evidenceId)) {
        issue("projection_evidence_missing", `${path}.evidence_ids`, "投影引用了不存在的 Evidence ID。" );
      }
    }
    for (const overlayId of node.overlay_ids ?? []) {
      if (!knownOverlayIds.has(overlayId)) {
        issue("projection_overlay_missing", `${path}.overlay_ids`, "投影引用了不存在的 Overlay ID。" );
      }
    }
  }
  for (const [index, node] of projection.nodes.entries()) {
    const path = `${basePath}.nodes[${index}]`;
    if (!node.parent_projection_node_id) {
      if (node.depth !== 0) {
        issue("projection_root_depth_invalid", `${path}.depth`, "无父级的投影节点 depth 必须为 0。" );
      }
      continue;
    }
    const parent = projectionNodes.get(node.parent_projection_node_id);
    if (!parent) {
      issue("projection_parent_missing", `${path}.parent_projection_node_id`, "投影父节点不存在。" );
    } else if (node.depth !== parent.depth + 1) {
      issue("projection_depth_mismatch", `${path}.depth`, "投影 depth 必须等于父节点 depth + 1。" );
    }
  }
  const projectionEdges = new Set<string>();
  for (const [index, edge] of projection.edges.entries()) {
    const path = `${basePath}.edges[${index}]`;
    if (projectionEdges.has(edge.projection_edge_id)) {
      issue("duplicate_projection_edge", `${path}.projection_edge_id`, "投影关系 ID 重复。" );
    }
    projectionEdges.add(edge.projection_edge_id);
    if (!projectionNodes.has(edge.source_projection_node_id)
      || !projectionNodes.has(edge.target_projection_node_id)) {
      issue("projection_edge_endpoint_missing", path, "投影关系端点不存在。" );
    }
    if (edge.relation_id !== null && !knownRelationIds.has(edge.relation_id)) {
      issue("projection_relation_missing", `${path}.relation_id`, "投影引用了不存在的规范关系。" );
    }
    for (const relationId of edge.aggregate_relation_ids) {
      if (!knownRelationIds.has(relationId)) {
        issue("projection_aggregate_relation_missing", `${path}.aggregate_relation_ids`, "聚合关系不存在。" );
      }
    }
    for (const evidenceId of edge.evidence_ids) {
      if (!knownEvidenceIds.has(evidenceId)) {
        issue("projection_evidence_missing", `${path}.evidence_ids`, "投影引用了不存在的 Evidence ID。" );
      }
    }
    for (const overlayId of edge.overlay_ids ?? []) {
      if (!knownOverlayIds.has(overlayId)) {
        issue("projection_overlay_missing", `${path}.overlay_ids`, "投影引用了不存在的 Overlay ID。" );
      }
    }
  }
}

export function validateEvidenceSnapshot(value: EvidenceSnapshot | unknown): SnapshotValidationResult {
  const issues: SnapshotValidationIssue[] = [];
  const issue = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const rawGraph = raw?.graph && typeof raw.graph === "object" && !Array.isArray(raw.graph)
    ? raw.graph as Record<string, unknown>
    : null;
  if (rawGraph && rawGraph.schema_version !== undefined
    && rawGraph.schema_version !== EVIDENCE_GRAPH_SCHEMA_VERSION) {
    issue("snapshot_schema_invalid", "graph.schema_version", "规范图 schema_version 不受支持。" );
  }
  if (rawGraph?.schema_version === EVIDENCE_GRAPH_SCHEMA_VERSION) {
    const entityKinds = new Set(["repository", "system", "subsystem", "domain", "module", "component", "fact"]);
    const overlayKinds = new Set(["community", "architecture_layer", "process", "runtime"]);
    if (Array.isArray(rawGraph.nodes)) {
      rawGraph.nodes.forEach((value, index) => {
        const node = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null;
        if (!node || typeof node.entity_kind !== "string" || !entityKinds.has(node.entity_kind)) {
          issue("entity_kind_invalid", `graph.nodes[${index}].entity_kind`, "v2 实体必须声明受支持的 entity_kind。" );
        }
        if (!node || !Number.isSafeInteger(node.depth) || Number(node.depth) < 0) {
          issue("entity_depth_invalid", `graph.nodes[${index}].depth`, "v2 实体必须声明非负整数 depth。" );
        }
        if (!node || (node.parent_entity_id !== null && typeof node.parent_entity_id !== "string")) {
          issue("parent_entity_invalid", `graph.nodes[${index}].parent_entity_id`, "v2 主父级必须是实体 ID 或 null。" );
        }
      });
    }
    if (Array.isArray(rawGraph.overlays)) {
      rawGraph.overlays.forEach((value, index) => {
        const overlay = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null;
        if (!overlay || typeof overlay.kind !== "string" || !overlayKinds.has(overlay.kind)) {
          issue("overlay_kind_invalid", `graph.overlays[${index}].kind`, "v2 Overlay 必须声明受支持的 kind。" );
        }
      });
    }
  }
  const snapshot = asEvidenceSnapshot(value);
  if (!snapshot) {
    issue("snapshot_shape_invalid", "$", "快照缺少 graph.nodes 或 graph.edges。" );
    return { valid: false, issues };
  }

  const nodes = new Map<string, NormalizedEvidenceSnapshot["graph"]["nodes"][number]>();
  for (const [index, node] of snapshot.graph.nodes.entries()) {
    const path = `graph.nodes[${index}]`;
    if (!node.id) issue("entity_id_missing", `${path}.id`, "实体 ID 不能为空。" );
    if (nodes.has(node.id)) issue("duplicate_entity_id", `${path}.id`, "实体 ID 重复。" );
    else nodes.set(node.id, node);
    if (!Number.isSafeInteger(node.depth) || node.depth < 0) {
      issue("entity_depth_invalid", `${path}.depth`, "实体 depth 必须是非负整数。" );
    }
    if (node.parent_entity_id === node.id) {
      issue("entity_self_parent", `${path}.parent_entity_id`, "实体不能把自己设为父级。" );
    }
  }

  for (const [index, node] of snapshot.graph.nodes.entries()) {
    const path = `graph.nodes[${index}]`;
    if (node.parent_entity_id === null) {
      if (node.depth !== 0) issue("root_depth_invalid", `${path}.depth`, "根实体 depth 必须为 0。" );
      continue;
    }
    const parent = nodes.get(node.parent_entity_id);
    if (!parent) {
      issue("parent_entity_missing", `${path}.parent_entity_id`, "主父级实体不存在。" );
    } else if (node.depth !== parent.depth + 1) {
      issue("entity_depth_mismatch", `${path}.depth`, "实体 depth 必须等于主父级 depth + 1。" );
    }
  }

  for (const node of snapshot.graph.nodes) {
    const visited = new Set<string>();
    let current: typeof node | undefined = node;
    while (current?.parent_entity_id) {
      if (visited.has(current.id)) {
        issue("hierarchy_cycle", `graph.nodes.${node.id}.parent_entity_id`, "主层级存在环。" );
        break;
      }
      visited.add(current.id);
      current = nodes.get(current.parent_entity_id);
    }
  }

  const expectedRoots = sorted(snapshot.graph.nodes
    .filter((node) => node.parent_entity_id === null)
    .map((node) => node.id));
  const declaredRoots = sorted(snapshot.graph.hierarchy.root_entity_ids);
  if (!sameStrings(expectedRoots, declaredRoots)) {
    issue("hierarchy_roots_mismatch", "graph.hierarchy.root_entity_ids", "声明的根实体与实际父链不一致。" );
  }
  const maxDepth = snapshot.graph.nodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0);
  if (snapshot.graph.hierarchy.max_depth !== maxDepth) {
    issue("hierarchy_max_depth_mismatch", "graph.hierarchy.max_depth", "max_depth 与实体 depth 不一致。" );
  }

  const relationIds = new Set<string>();
  for (const [index, edge] of snapshot.graph.edges.entries()) {
    const path = `graph.edges[${index}]`;
    if (relationIds.has(edge.id)) issue("duplicate_relation_id", `${path}.id`, "规范关系 ID 重复。" );
    relationIds.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      issue("relation_endpoint_missing", path, "规范关系端点不存在。" );
    }
  }

  const factNodes = new Set((snapshot.fact_graph?.nodes ?? []).map((node) => node.id));
  for (const [index, edge] of (snapshot.fact_graph?.edges ?? []).entries()) {
    if (!factNodes.has(edge.source) || !factNodes.has(edge.target)) {
      issue("fact_relation_endpoint_missing", `fact_graph.edges[${index}]`, "事实关系端点不存在。" );
    }
  }

  const evidence = new Map<string, string>();
  const registerEvidence = (row: SnapshotEvidence, path: string): void => {
    if (!row.stable_id) {
      issue("evidence_id_missing", path, "Evidence ID 不能为空。" );
      return;
    }
    const signature = evidenceSignature(row);
    const previous = evidence.get(row.stable_id);
    if (previous !== undefined && previous !== signature) {
      issue("evidence_identity_conflict", path, "同一 Evidence ID 指向了不同位置或关系。" );
      return;
    }
    evidence.set(row.stable_id, signature);
  };
  snapshot.graph.nodes.forEach((node, nodeIndex) => {
    node.evidence.forEach((row, index) => registerEvidence(row, `graph.nodes[${nodeIndex}].evidence[${index}]`));
    node.members.forEach((row, index) => registerEvidence(row, `graph.nodes[${nodeIndex}].members[${index}]`));
  });
  snapshot.graph.edges.forEach((edge, edgeIndex) => {
    edge.evidence.forEach((row, index) => registerEvidence(row, `graph.edges[${edgeIndex}].evidence[${index}]`));
  });
  snapshot.graph.layers.forEach((layer, layerIndex) => {
    layer.evidence.forEach((row, index) => registerEvidence(row, `graph.layers[${layerIndex}].evidence[${index}]`));
  });
  snapshot.value_points.forEach((point, pointIndex) => {
    point.evidence.forEach((row, index) => registerEvidence(row, `value_points[${pointIndex}].evidence[${index}]`));
  });
  snapshot.fact_graph?.nodes.forEach((node, nodeIndex) => {
    node.evidence.forEach((row, index) => registerEvidence(row, `fact_graph.nodes[${nodeIndex}].evidence[${index}]`));
    node.members.forEach((row, index) => registerEvidence(row, `fact_graph.nodes[${nodeIndex}].members[${index}]`));
  });
  snapshot.fact_graph?.edges.forEach((edge, edgeIndex) => {
    edge.evidence.forEach((row, index) => registerEvidence(row, `fact_graph.edges[${edgeIndex}].evidence[${index}]`));
  });

  const overlayIds = new Set<string>();
  for (const [index, overlay] of snapshot.graph.overlays.entries()) {
    const path = `graph.overlays[${index}]`;
    if (overlayIds.has(overlay.id)) issue("duplicate_overlay_id", `${path}.id`, "Overlay ID 重复。" );
    overlayIds.add(overlay.id);
    for (const entityId of overlay.member_entity_ids) {
      if (!nodes.has(entityId)) issue("overlay_entity_missing", `${path}.member_entity_ids`, "Overlay 成员实体不存在。" );
    }
    for (const relationId of overlay.relation_ids) {
      if (!relationIds.has(relationId)) issue("overlay_relation_missing", `${path}.relation_ids`, "Overlay 关系不存在。" );
    }
    for (const evidenceId of overlay.evidence_ids) {
      if (!evidence.has(evidenceId)) issue("overlay_evidence_missing", `${path}.evidence_ids`, "Overlay 引用了不存在的 Evidence ID。" );
    }
  }

  const knownEntityIds = new Set(nodes.keys());
  const knownEvidenceIds = new Set(evidence.keys());
  validateProjection(snapshot, snapshot.graph.projections.human, knownEntityIds, relationIds, knownEvidenceIds, overlayIds, issue);
  validateProjection(snapshot, snapshot.graph.projections.agent, knownEntityIds, relationIds, knownEvidenceIds, overlayIds, issue);
  return { valid: issues.length === 0, issues };
}

export function assertValidEvidenceSnapshot(value: EvidenceSnapshot | unknown): NormalizedEvidenceSnapshot {
  const snapshot = asEvidenceSnapshot(value);
  if (!snapshot) throw new Error("evidence_snapshot_invalid:snapshot_shape_invalid");
  const validation = validateEvidenceSnapshot(snapshot);
  if (!validation.valid) {
    const first = validation.issues[0];
    throw new Error(`evidence_snapshot_invalid:${first?.code ?? "unknown"}:${first?.path ?? "$"}`);
  }
  return snapshot;
}
