import { createHash } from "node:crypto";
import type {
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotMainHierarchy,
  SnapshotNode,
  SnapshotEntityKind,
} from "../domain/snapshot.js";

export interface CandidateHierarchyResult {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  hierarchy: SnapshotMainHierarchy;
  generated: boolean;
}

export interface HierarchyOperation {
  operation: "split" | "merge" | "nest" | "name" | "explain";
  entity_id: string;
  target_entity_ids?: string[];
  parent_entity_id?: string | null;
  name?: string;
  responsibility?: string;
  rationale?: string;
  evidence_ids: string[];
  /** Internal provenance for bounded semantic batches; never supplied by the model. */
  scope_entity_ids?: string[];
  scope_evidence_ids?: string[];
}

export interface AppliedHierarchyOperation extends HierarchyOperation {
  status: "accepted" | "rejected";
  reason?: string;
}

const LARGE_REPOSITORY_THRESHOLD = 8;
const MODULE_REPOSITORY_THRESHOLD = 32;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function structuralGroup(node: SnapshotNode): string {
  const value = node.attributes?.structural_group;
  if (typeof value === "string" && value.trim()) return value.trim().replaceAll("\\", "/");
  const member = node.members.find((row) => row.path)?.path;
  return member?.split("/").slice(0, 2).join("/") || node.id;
}

function groupRoot(value: string): string {
  return value.split("/")[0] || "root";
}

function nodeEvidence(node: SnapshotNode): SnapshotEvidence[] {
  return [...node.evidence, ...node.members]
    .filter((row, index, all) => Boolean(row?.stable_id)
      && all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index)
    .slice(0, 24);
}

function derivedNode(input: {
  id: string;
  kind: SnapshotEntityKind;
  name: string;
  responsibility: string;
  parent: string | null;
  depth: number;
  children: SnapshotNode[];
}): SnapshotNode {
  const evidence = input.children.flatMap(nodeEvidence)
    .filter((row, index, all) => all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index)
    .slice(0, 24);
  return {
    id: input.id,
    entity_kind: input.kind,
    parent_entity_id: input.parent,
    depth: input.depth,
    label: input.name,
    name: input.name,
    responsibility: input.responsibility,
    grouping_rationale: "程序根据真实文件路径和候选成员关系生成的主层级候选；不是 LLM 伪造的事实。",
    architecture_layer_id: null,
    architecture_layer_name: null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "degraded",
    members: [],
    member_count: input.children.length,
    evidence,
    certainty: "degraded",
    review_status: "unreviewed",
    source_report_ids: [],
    fan_in: 0,
    fan_out: 0,
    attributes: {
      hierarchy_candidate: true,
      hierarchy_child_count: input.children.length,
    },
  };
}

function hierarchyEdge(parent: SnapshotNode, child: SnapshotNode): SnapshotEdge {
  const evidence = nodeEvidence(child).slice(0, 8);
  return {
    id: `hierarchy:edge:${hash(`${parent.id}:${child.id}`)}`,
    source: parent.id,
    target: child.id,
    relation_kind: "contains",
    label: "包含",
    description: "主层级候选把子实体归入唯一父级。",
    certainty: "derived",
    evidence,
    weight: 1,
    source_observations: [{ extractor: "deterministic_hierarchy", certainty: "inferred", reason_code: "path_grouping" }],
  };
}

function hierarchyEdges(nodes: SnapshotNode[]): SnapshotEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.parent_entity_id && byId.has(node.parent_entity_id))
    .map((node) => hierarchyEdge(byId.get(node.parent_entity_id as string) as SnapshotNode, node));
}

function finalize(nodes: SnapshotNode[], edges: SnapshotEdge[]): CandidateHierarchyResult {
  const parent = new Map(nodes.map((node) => [node.id, node.parent_entity_id ?? null]));
  const roots = nodes.filter((node) => !parent.get(node.id)).map((node) => node.id).sort();
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth ?? 0), 0);
  return { nodes, edges, hierarchy: { root_entity_ids: roots, max_depth: maxDepth }, generated: maxDepth > 0 };
}

/** Build a conservative, deterministic hierarchy candidate from static structure. */
export function buildCandidateHierarchy(input: {
  repository: string;
  components: SnapshotNode[];
  edges: SnapshotEdge[];
}): CandidateHierarchyResult {
  const leaves = input.components.map((node) => ({
    ...node,
    entity_kind: node.entity_kind ?? "component",
    parent_entity_id: null,
    depth: 0,
  }));
  if (leaves.length < LARGE_REPOSITORY_THRESHOLD) return finalize(leaves, input.edges);

  const root = derivedNode({
    id: `entity:repository:${hash(input.repository.toLowerCase())}`,
    kind: "repository",
    name: input.repository,
    responsibility: "承载当前 commit 的全部主层级实体。",
    parent: null,
    depth: 0,
    children: leaves,
  });
  const byRoot = new Map<string, SnapshotNode[]>();
  for (const leaf of leaves) {
    const key = groupRoot(structuralGroup(leaf));
    byRoot.set(key, [...(byRoot.get(key) ?? []), leaf]);
  }

  const generated: SnapshotNode[] = [root];
  const generatedEdges: SnapshotEdge[] = [];
  const groups = [...byRoot.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [rootName, group] of groups) {
    const subsystem = derivedNode({
      id: `entity:subsystem:${hash(`${root.id}:${rootName.toLowerCase()}`)}`,
      kind: "subsystem",
      name: `${rootName} 子系统`,
      responsibility: `组织 ${rootName} 路径下的相关组件。`,
      parent: root.id,
      depth: 1,
      children: group,
    });
    generated.push(subsystem);
    generatedEdges.push(hierarchyEdge(root, subsystem));
    const byModule = new Map<string, SnapshotNode[]>();
    for (const leaf of group) {
      const key = structuralGroup(leaf);
      byModule.set(key, [...(byModule.get(key) ?? []), leaf]);
    }
    const useModules = leaves.length >= MODULE_REPOSITORY_THRESHOLD && byModule.size > 1;
    for (const [moduleName, moduleLeaves] of [...byModule.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      let parent = subsystem;
      if (useModules) {
        const moduleNode = derivedNode({
          id: `entity:module:${hash(`${subsystem.id}:${moduleName.toLowerCase()}`)}`,
          kind: "module",
          name: `${moduleName} 模块`,
          responsibility: `组织 ${moduleName} 路径下的实现。`,
          parent: subsystem.id,
          depth: 2,
          children: moduleLeaves,
        });
        generated.push(moduleNode);
        generatedEdges.push(hierarchyEdge(subsystem, moduleNode));
        parent = moduleNode;
      }
      for (const leaf of moduleLeaves) {
        leaf.parent_entity_id = parent.id;
        leaf.depth = (parent.depth ?? 0) + 1;
        generated.push(leaf);
        generatedEdges.push(hierarchyEdge(parent, leaf));
      }
    }
  }
  return finalize(generated, [...input.edges, ...generatedEdges]);
}

export function evidenceIndexForHierarchy(nodes: SnapshotNode[], edges: SnapshotEdge[]): Map<string, SnapshotEvidence> {
  const rows = [
    ...nodes.flatMap(nodeEvidence),
    ...edges.flatMap((edge) => edge.evidence),
  ];
  return new Map(rows.filter((row) => row?.stable_id).map((row) => [row.stable_id, row]));
}

export function isMutableHierarchyEntity(node: SnapshotNode): boolean {
  return node.entity_kind !== "fact";
}

function createsCycle(parentById: Map<string, string | null>, entityId: string, parentId: string): boolean {
  const visited = new Set<string>();
  let current: string | null | undefined = parentId;
  while (current) {
    if (current === entityId || visited.has(current)) return true;
    visited.add(current);
    current = parentById.get(current);
  }
  return false;
}

/** Apply only operations that reference existing entities and Evidence IDs. */
export function applyHierarchyOperations(input: {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  operations: HierarchyOperation[];
  allowedEntityIds?: ReadonlySet<string>;
  allowedEvidenceIds?: ReadonlySet<string>;
}): { nodes: SnapshotNode[]; edges: SnapshotEdge[]; operations: AppliedHierarchyOperation[]; hierarchy: SnapshotMainHierarchy } {
  const nodes = input.nodes.map((node) => ({ ...node, attributes: { ...(node.attributes ?? {}) } }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const evidence = evidenceIndexForHierarchy(nodes, input.edges);
  const parentById = new Map(nodes.map((node) => [node.id, node.parent_entity_id ?? null]));
  const applied: AppliedHierarchyOperation[] = [];
  for (const operation of input.operations.slice(0, 200)) {
    const targetIds = [...new Set([operation.entity_id, ...(operation.target_entity_ids ?? [])])];
    const missingEntity = targetIds.find((id) => !byId.has(id));
    const missingEvidence = (operation.evidence_ids ?? []).find((id) => !evidence.has(id));
    const entityScope = operation.scope_entity_ids
      ? new Set(operation.scope_entity_ids)
      : input.allowedEntityIds;
    const evidenceScope = operation.scope_evidence_ids
      ? new Set(operation.scope_evidence_ids)
      : input.allowedEvidenceIds;
    const outOfScopeEntity = entityScope && targetIds.find((id) => !entityScope.has(id));
    const outOfScopeEvidence = evidenceScope && (operation.evidence_ids ?? []).find((id) => !evidenceScope.has(id));
    if (missingEntity) { applied.push({ ...operation, status: "rejected", reason: `entity_missing:${missingEntity}` }); continue; }
    if (missingEvidence) { applied.push({ ...operation, status: "rejected", reason: `evidence_missing:${missingEvidence}` }); continue; }
    if (outOfScopeEntity) { applied.push({ ...operation, status: "rejected", reason: `entity_outside_scope:${outOfScopeEntity}` }); continue; }
    if (outOfScopeEvidence) { applied.push({ ...operation, status: "rejected", reason: `evidence_outside_scope:${outOfScopeEvidence}` }); continue; }
    if (!operation.evidence_ids?.length) { applied.push({ ...operation, status: "rejected", reason: "evidence_required" }); continue; }
    const immutable = targetIds.find((id) => !isMutableHierarchyEntity(byId.get(id) as SnapshotNode));
    if (immutable) { applied.push({ ...operation, status: "rejected", reason: `fact_entity_immutable:${immutable}` }); continue; }
    if (operation.operation === "nest" || operation.operation === "split") {
      const parentId = operation.parent_entity_id ?? null;
      if (parentId && !byId.has(parentId)) { applied.push({ ...operation, status: "rejected", reason: "parent_missing" }); continue; }
      const movingIds = operation.operation === "split"
        ? targetIds
        : [operation.entity_id];
      if (movingIds.some((id) => parentId && createsCycle(parentById, id, parentId))) {
        applied.push({ ...operation, status: "rejected", reason: "hierarchy_cycle" });
        continue;
      }
      for (const id of movingIds) parentById.set(id, parentId);
      applied.push({ ...operation, status: "accepted" });
      continue;
    }
    if (operation.operation === "merge") {
      const canonical = byId.get(operation.entity_id) as SnapshotNode;
      const merged = targetIds.filter((id) => id !== operation.entity_id);
      if (!merged.length) { applied.push({ ...operation, status: "rejected", reason: "merge_targets_required" }); continue; }
      canonical.members = [...canonical.members, ...merged.flatMap((id) => byId.get(id)?.members ?? [])]
        .filter((row, index, all) => all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index);
      canonical.evidence = [...canonical.evidence, ...merged.flatMap((id) => byId.get(id)?.evidence ?? [])]
        .filter((row, index, all) => all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index);
      canonical.member_count = canonical.members.length;
      canonical.attributes = { ...(canonical.attributes ?? {}), semantic_merge_targets: merged };
      for (const id of merged) {
        const node = byId.get(id);
        if (node) { node.lifecycle_status = "superseded"; node.superseded_by = canonical.id; }
      }
      applied.push({ ...operation, status: "accepted" });
      continue;
    }
    const node = byId.get(operation.entity_id) as SnapshotNode;
    if (operation.operation === "name" && text(operation.name)) {
      node.name = text(operation.name);
      node.label = node.name;
      applied.push({ ...operation, status: "accepted" });
      continue;
    }
    if (operation.operation === "explain" && text(operation.responsibility)) {
      node.responsibility = text(operation.responsibility);
      node.grouping_rationale = text(operation.rationale) || node.grouping_rationale;
      applied.push({ ...operation, status: "accepted" });
      continue;
    }
    applied.push({ ...operation, status: "rejected", reason: "operation_payload_missing" });
  }
  for (const node of nodes) {
    const parent = parentById.get(node.id) ?? null;
    node.parent_entity_id = parent;
  }
  const depth = (id: string, visiting = new Set<string>()): number => {
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parent = parentById.get(id) ?? null;
    const value = parent ? depth(parent, visiting) + 1 : 0;
    visiting.delete(id);
    return value;
  };
  for (const node of nodes) node.depth = depth(node.id);
  const roots = nodes.filter((node) => !node.parent_entity_id).map((node) => node.id).sort();
  return {
    nodes,
    edges: [
      ...input.edges.filter((edge) => !edge.id.startsWith("hierarchy:edge:")),
      ...hierarchyEdges(nodes),
    ],
    operations: applied,
    hierarchy: { root_entity_ids: roots, max_depth: nodes.reduce((max, node) => Math.max(max, node.depth ?? 0), 0) },
  };
}
