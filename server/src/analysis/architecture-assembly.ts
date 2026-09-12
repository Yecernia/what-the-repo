/** Pure assembly of validated semantics into the existing graph contract. */
import { deriveSnapshotProjections } from "../domain/snapshot-projection.js";
import { type SnapshotEdge, type SnapshotEvidence, type SnapshotLayer, type SnapshotNode } from "../domain/snapshot.js";
import { type BuiltSnapshot } from "./graph.js";
import {
  type ArchitectureSemanticResult,
  type ResponsibilityScopePatch,
  MAX_COMPONENTS_PER_SCOPE,
  MAX_SECOND_LEVEL_ITEMS,
  scopeNameIsPlaceholder,
  TARGET_SECOND_LEVEL_ITEMS,
} from "./semantic-contracts.js";
import { componentEvidence, id } from "./semantic-snapshot.js";

export function mergeComponents(
  snapshot: BuiltSnapshot,
  result: ArchitectureSemanticResult,
  coverage?: { supportedIds: Set<string>; degradedIds: string[] },
): SnapshotNode[] {
  const patches = new Map(result.components.map((row) => [row.component_id, row]));
  const degradedIds = new Set(coverage?.degradedIds ?? []);
  return snapshot.graph.nodes.map((component) => {
    const patch = patches.get(component.id);
    if (!patch) {
      if (!coverage) return component;
      return {
        ...component,
        attributes: {
          ...(component.attributes ?? {}),
          architecture_semantic_status: "degraded",
        },
      };
    }
    const degraded = degradedIds.has(component.id);
    return {
      ...component,
      label: patch.name,
      name: patch.name,
      responsibility: patch.responsibility,
      grouping_rationale: patch.grouping_rationale?.trim() || component.grouping_rationale || "",
      architecture_layer_id: null,
      architecture_layer_name: patch.layer_name ?? component.architecture_layer_name,
      architecture_layer_rationale: patch.layer_rationale?.trim() || component.architecture_layer_rationale || null,
      architecture_layer_certainty: !degraded && patch.layer_rationale?.trim()
        ? "provider_supported"
        : "degraded",
      certainty: degraded ? "degraded" : "provider_supported",
      review_status: degraded ? "unreviewed" : "reviewed",
      attributes: {
        ...(component.attributes ?? {}),
        architecture_semantic_status: degraded
          ? "language_mismatch_after_retry"
          : "provider_supported",
        ...(patch.layer_responsibility
          ? { architecture_layer_responsibility: patch.layer_responsibility }
          : {}),
        ...(patch.layer_group_rationale
          ? { architecture_layer_group_rationale: patch.layer_group_rationale }
          : {}),
      },
    };
  });
}

export function buildLayers(components: SnapshotNode[]): {
  components: SnapshotNode[];
  layers: SnapshotLayer[];
} {
  const layers = new Map<string, SnapshotLayer>();
  const leafComponents = components.filter((component) => (component.entity_kind ?? "component") === "component");
  for (const component of leafComponents) {
    const name = component.architecture_layer_name?.trim() || "共享基础层";
    const semanticStatus = component.attributes?.architecture_semantic_status;
    const layer = layers.get(name) ?? {
      id: "",
      name,
      responsibility: typeof component.attributes?.architecture_layer_responsibility === "string"
        ? component.attributes.architecture_layer_responsibility
        : `组织“${name}”中的相关组件。`,
      component_ids: [],
      evidence: [],
      certainty: semanticStatus === "provider_supported" ? "provider_supported" : "degraded",
    };
    layer.component_ids.push(component.id);
    if (semanticStatus !== "provider_supported") layer.certainty = "degraded";
    for (const row of component.evidence.slice(0, 3)) {
      if (layer.evidence.length >= 24) break;
      if (!layer.evidence.some((item) => item.stable_id === row.stable_id)) layer.evidence.push(row);
    }
    layers.set(name, layer);
  }
  const finalized = [...layers.values()].map((layer) => ({
    ...layer,
    component_ids: [...new Set(layer.component_ids)].sort(),
    id: "layer:" + id(JSON.stringify({
      kind: "architecture-layer",
      components: [...new Set(layer.component_ids)].sort(),
    })),
  }));
  const layerByComponent = new Map(finalized.flatMap((layer) =>
    layer.component_ids.map((componentId) => [componentId, layer] as const)));
  return {
    components: components.map((component) => {
      const layer = layerByComponent.get(component.id);
      return layer ? {
        ...component,
        architecture_layer_id: layer.id,
        architecture_layer_name: layer.name,
      } : component;
    }),
    layers: finalized,
  };
}

export interface ResolvedResponsibilityScope extends ResponsibilityScopePatch {
  id: string;
  layer_id: string;
  evidence: SnapshotEvidence[];
  certainty: string;
}

export function componentStructuralGroup(node: SnapshotNode): string {
  const structural = node.attributes?.structural_group;
  if (typeof structural === "string" && structural.trim()) return structural.trim().replaceAll("\\", "/");
  return (node.members.find((row) => row.path)?.path ?? "root")
    .replaceAll("\\", "/")
    .split("/")
    .slice(0, 2)
    .join("/") || "root";
}

export function semanticWords(value: string): Set<string> {
  const ignored = new Set(["src", "source", "app", "application", "server", "web", "lib", "library", "module", "component", "layer", "service", "模块", "组件", "职责", "层"]);
  return new Set(value.toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !ignored.has(word)));
}

export function componentAffinity(
  left: SnapshotNode,
  right: SnapshotNode,
  relationWeights: Map<string, number>,
): number {
  const relationKey = [left.id, right.id].sort().join("\0");
  let score = Math.log2((relationWeights.get(relationKey) ?? 0) + 1) * 120;
  const leftPath = componentStructuralGroup(left).split("/").filter(Boolean);
  const rightPath = componentStructuralGroup(right).split("/").filter(Boolean);
  let commonPath = 0;
  while (commonPath < Math.min(leftPath.length, rightPath.length)
    && leftPath[commonPath]?.toLocaleLowerCase() === rightPath[commonPath]?.toLocaleLowerCase()) {
    commonPath += 1;
  }
  score += commonPath * 36;
  const leftWords = semanticWords(`${left.name} ${left.responsibility}`);
  const rightWords = semanticWords(`${right.name} ${right.responsibility}`);
  score += [...leftWords].filter((word) => rightWords.has(word)).length * 18;
  return score;
}

export function readableScopeStem(value: string): string {
  return value
    .replace(/(?:层|模块|组件|服务|职责域|职责)$/u, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
}

export function fallbackScopeName(components: SnapshotNode[], layer: SnapshotLayer): string {
  const categories: Array<[string, RegExp]> = [
    ["认证与权限职责", /auth|login|identity|permission|security|认证|登录|权限|身份/iu],
    ["接口与请求职责", /api|route|controller|handler|http|request|接口|路由|请求/iu],
    ["分析与图谱职责", /analysis|analy|graph|semantic|cluster|snapshot|分析|图谱|语义|快照/iu],
    ["Agent 与扩展职责", /agent|skill|tool|model|prompt|plugin|extension|智能体|技能|工具|模型|插件|扩展/iu],
    ["任务与流程职责", /job|queue|task|workflow|schedule|worker|任务|队列|流程|调度/iu],
    ["数据持久化职责", /store|storage|persist|database|postgres|redis|cache|数据|存储|持久化|缓存/iu],
    ["交互界面职责", /ui|view|page|screen|component|frontend|web|界面|页面|交互|前端/iu],
    ["测试与评测职责", /test|spec|fixture|eval|quality|测试|评测|质量/iu],
    ["配置与部署职责", /config|infra|deploy|docker|kubernetes|script|配置|基础设施|部署/iu],
    ["领域契约职责", /domain|schema|contract|entity|type|领域|契约|实体|类型/iu],
    ["仓库接入职责", /repository|github|source|fetch|clone|仓库|源码|拉取/iu],
  ];
  const rows = components.map((component) => `${component.name} ${component.responsibility} ${componentStructuralGroup(component)}`);
  const ranked = categories
    .map(([name, pattern]) => ({ name, count: rows.filter((row) => pattern.test(row)).length }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  if ((ranked[0]?.count ?? 0) >= Math.min(2, components.length)) return ranked[0]?.name as string;
  const structural = components.map(componentStructuralGroup);
  const sharedSegment = structural[0]?.split("/").filter(Boolean).reverse()
    .find((segment) => structural.every((path) => path.split("/").some((candidate) => candidate.toLocaleLowerCase() === segment.toLocaleLowerCase()))
      && !/^(?:src|source|app|server|web|lib|packages?)$/iu.test(segment));
  if (sharedSegment) return `${readableScopeStem(sharedSegment)} 职责`;
  const first = readableScopeStem(components[0]?.name ?? layer.name) || readableScopeStem(layer.name);
  const second = readableScopeStem(components[1]?.name ?? "");
  return components.length === 2 && second
    ? `${first}与${second}`.slice(0, 80)
    : `${first}相关职责`.slice(0, 80);
}

export function resolveResponsibilityScopes(input: {
  snapshot: BuiltSnapshot;
  components: SnapshotNode[];
  layers: SnapshotLayer[];
  proposals: ResponsibilityScopePatch[];
  directComponentIds?: readonly string[];
}): { scopes: ResolvedResponsibilityScope[]; directComponentIds: Set<string> } {
  const componentById = new Map(input.components.map((component) => [component.id, component]));
  const layerByComponent = new Map(input.layers.flatMap((layer) => layer.component_ids.map((componentId) => [componentId, layer.id] as const)));
  const relationWeights = new Map<string, number>();
  const relationEvidence = new Map<string, SnapshotEvidence[]>();
  for (const edge of input.snapshot.graph.edges) {
    if (!componentById.has(edge.source) || !componentById.has(edge.target) || edge.source === edge.target) continue;
    const key = [edge.source, edge.target].sort().join("\0");
    relationWeights.set(key, (relationWeights.get(key) ?? 0) + Math.max(1, edge.weight));
    relationEvidence.set(key, [...(relationEvidence.get(key) ?? []), ...edge.evidence]);
  }
  const accepted: Array<{ componentIds: string[]; proposal: ResponsibilityScopePatch | null }> = [];
  const claimed = new Set<string>();
  const explicitDirect = new Set(input.directComponentIds ?? []);
  for (const proposal of input.proposals) {
    const componentIds = [...new Set(proposal.component_ids)].filter((componentId) => componentById.has(componentId));
    const layerIds = [...new Set(componentIds.map((componentId) => layerByComponent.get(componentId)))];
    if (componentIds.length < 2
      || componentIds.length > MAX_COMPONENTS_PER_SCOPE
      || layerIds.length !== 1
      || !layerIds[0]
      || scopeNameIsPlaceholder(proposal.name)
      || componentIds.some((componentId) => explicitDirect.has(componentId))
      || componentIds.some((componentId) => claimed.has(componentId))) continue;
    const allowedEvidence = new Set(componentIds.flatMap((componentId) => componentEvidence(componentById.get(componentId) as SnapshotNode).map((row) => row.stable_id)));
    for (let left = 0;left < componentIds.length;left += 1) {
      for (let right = left + 1;right < componentIds.length;right += 1) {
        for (const row of relationEvidence.get([componentIds[left], componentIds[right]].sort().join("\0")) ?? []) {
          allowedEvidence.add(row.stable_id);
        }
      }
    }
    const evidenceIds = [...new Set(proposal.evidence_ids)].filter((evidenceId) => allowedEvidence.has(evidenceId));
    if (!evidenceIds.length) continue;
    componentIds.forEach((componentId) => claimed.add(componentId));
    accepted.push({ componentIds: componentIds.sort(), proposal: { ...proposal, evidence_ids: evidenceIds } });
  }

  const resolved: ResolvedResponsibilityScope[] = [];
  const directComponentIds = new Set<string>();
  for (const layer of input.layers) {
    const layerComponentIds = layer.component_ids.filter((componentId) => componentById.has(componentId));
    let groups = [
      ...accepted.filter((group) => group.componentIds.every((componentId) => layerByComponent.get(componentId) === layer.id)),
      ...layerComponentIds.filter((componentId) => !claimed.has(componentId)).map((componentId) => ({ componentIds: [componentId], proposal: null })),
    ];
    const hasModelPlan = groups.some((group) => group.proposal)
      || layerComponentIds.some((componentId) => explicitDirect.has(componentId));
    const targetItems = hasModelPlan ? MAX_SECOND_LEVEL_ITEMS : Math.min(
      MAX_SECOND_LEVEL_ITEMS,
      Math.max(Math.ceil(layerComponentIds.length / MAX_COMPONENTS_PER_SCOPE), Math.min(TARGET_SECOND_LEVEL_ITEMS, layerComponentIds.length)),
    );
    while (groups.length > targetItems) {
      let best: { left: number; right: number; score: number; key: string } | null = null;
      for (let leftIndex = 0;leftIndex < groups.length;leftIndex += 1) {
        for (let rightIndex = leftIndex + 1;rightIndex < groups.length;rightIndex += 1) {
          const left = groups[leftIndex] as typeof groups[number];
          const right = groups[rightIndex] as typeof groups[number];
          if ([...left.componentIds, ...right.componentIds].some((componentId) => explicitDirect.has(componentId))) continue;
          if (left.componentIds.length + right.componentIds.length > MAX_COMPONENTS_PER_SCOPE) continue;
          let score = 0;
          for (const leftId of left.componentIds) {
            for (const rightId of right.componentIds) {
              score = Math.max(score, componentAffinity(
                componentById.get(leftId) as SnapshotNode,
                componentById.get(rightId) as SnapshotNode,
                relationWeights,
              ));
            }
          }
          const key = [...left.componentIds, ...right.componentIds].sort().join("|");
          if (!best || score > best.score || (score === best.score && key < best.key)) {
            best = { left: leftIndex, right: rightIndex, score, key };
          }
        }
      }
      if (!best) break;
      const left = groups[best.left] as typeof groups[number];
      const right = groups[best.right] as typeof groups[number];
      const merged = {
        componentIds: [...left.componentIds, ...right.componentIds].sort(),
        proposal: null,
      };
      groups = groups.filter((_group, index) => index !== best?.left && index !== best?.right);
      groups.push(merged);
    }
    for (const group of groups.sort((left, right) => left.componentIds[0]?.localeCompare(right.componentIds[0] ?? "") ?? 0)) {
      if (group.componentIds.length === 1) {
        directComponentIds.add(group.componentIds[0] as string);
        continue;
      }
      const components = group.componentIds.map((componentId) => componentById.get(componentId) as SnapshotNode);
      const proposal = group.proposal;
      const evidence = [
        ...components.flatMap(componentEvidence),
        ...group.componentIds.flatMap((leftId, leftIndex) => group.componentIds
          .slice(leftIndex + 1)
          .flatMap((rightId) => relationEvidence.get([leftId, rightId].sort().join("\0")) ?? [])),
      ].filter((row, index, all) => all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index);
      const proposedEvidence = proposal
        ? proposal.evidence_ids.flatMap((evidenceId) => evidence.filter((row) => row.stable_id === evidenceId))
        : [];
      const name = proposal?.name ?? fallbackScopeName(components, layer);
      const relationCount = group.componentIds.reduce((count, leftId, leftIndex) => count + group.componentIds
        .slice(leftIndex + 1)
        .filter((rightId) => relationWeights.has([leftId, rightId].sort().join("\0"))).length, 0);
      resolved.push({
        id: `entity:domain:${id(JSON.stringify({ kind: "responsibility-scope", componentIds: group.componentIds }))}`,
        layer_id: layer.id,
        name,
        responsibility: proposal?.responsibility
          ?? `协同承载${components.slice(0, 3).map((component) => component.name).join("、")}等相关能力。`,
        grouping_rationale: proposal?.grouping_rationale
          ?? `程序根据 ${relationCount} 组静态依赖/调用关系、目录邻近和职责相似度，将这些组件归为同一职责范围。`,
        component_ids: group.componentIds,
        evidence_ids: (proposedEvidence.length ? proposedEvidence : evidence).slice(0, 24).map((row) => row.stable_id),
        evidence: (proposedEvidence.length ? proposedEvidence : evidence).slice(0, 24),
        certainty: proposal ? "provider_supported" : "degraded",
      });
    }
  }
  return { scopes: resolved, directComponentIds };
}

export function semanticHierarchyEdge(parent: SnapshotNode, child: SnapshotNode): SnapshotEdge {
  return {
    id: `hierarchy:edge:${id(`${parent.id}:${child.id}`)}`,
    source: parent.id,
    target: child.id,
    relation_kind: "contains",
    label: "包含",
    description: "主层级把实体归入唯一职责父级。",
    certainty: child.certainty,
    evidence: componentEvidence(child).slice(0, 8),
    weight: 1,
    source_observations: [{ extractor: "semantic_hierarchy", certainty: "inferred", reason_code: "validated_responsibility_grouping" }],
  };
}

export function buildSemanticHierarchy(input: {
  snapshot: BuiltSnapshot;
  components: SnapshotNode[];
  layers: SnapshotLayer[];
  proposals: ResponsibilityScopePatch[];
  directComponentIds?: readonly string[];
}): { nodes: SnapshotNode[]; edges: SnapshotEdge[]; hierarchy: { root_entity_ids: string[]; max_depth: number }; scopes: ResolvedResponsibilityScope[] } {
  const components: SnapshotNode[] = input.components.filter((node) => (node.entity_kind ?? "component") === "component")
    .map((node) => ({ ...node, entity_kind: "component" as const, parent_entity_id: null, depth: 0 }));
  const scopePlan = resolveResponsibilityScopes({ ...input, components });
  const rootEvidence: SnapshotEvidence[] = [];
  const rootEvidenceIds = new Set<string>();
  for (const row of components.flatMap(componentEvidence)) {
    if (rootEvidenceIds.has(row.stable_id)) continue;
    rootEvidenceIds.add(row.stable_id);
    rootEvidence.push(row);
    if (rootEvidence.length >= 24) break;
  }
  const includeRepositoryRoot = components.length >= 8;
  const root: SnapshotNode = {
    id: `entity:repository:${id(input.snapshot.repository.toLocaleLowerCase())}`,
    entity_kind: "repository",
    parent_entity_id: null,
    depth: 0,
    label: input.snapshot.repository,
    name: input.snapshot.repository,
    responsibility: "承载当前 commit 的全部架构层、职责范围和组件。",
    grouping_rationale: "仓库是当前分析快照的唯一主层级根节点。",
    architecture_layer_id: null,
    architecture_layer_name: null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "verified",
    members: [],
    member_count: components.length,
    evidence: rootEvidence,
    certainty: "verified",
    review_status: "reviewed",
    source_report_ids: [],
    fan_in: 0,
    fan_out: 0,
    attributes: { hierarchy_role: "repository_root", component_ids: components.map((component) => component.id) },
  };
  const componentById = new Map(components.map((component) => [component.id, component]));
  const nodes: SnapshotNode[] = includeRepositoryRoot ? [root] : [];
  const hierarchyEdges: SnapshotEdge[] = [];
  for (const layer of input.layers) {
    const layerComponents = layer.component_ids.flatMap((componentId) => {
      const component = componentById.get(componentId);
      return component ? [component] : [];
    });
    const layerNode: SnapshotNode = {
      id: layer.id,
      entity_kind: "system",
      parent_entity_id: root.id,
      depth: 1,
      label: layer.name,
      name: layer.name,
      responsibility: layer.responsibility,
      grouping_rationale: layerComponents.map((component) => component.attributes?.architecture_layer_group_rationale)
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
        ?? layerComponents.map((component) => component.architecture_layer_rationale).find((value) => Boolean(value))
        ?? "组件经语义归并后属于同一架构职责层。",
      architecture_layer_id: layer.id,
      architecture_layer_name: layer.name,
      architecture_layer_candidates: [],
      architecture_layer_rationale: null,
      architecture_layer_certainty: layer.certainty,
      members: [],
      member_count: layerComponents.length,
      evidence: layer.evidence,
      certainty: layer.certainty,
      review_status: layer.certainty === "provider_supported" ? "reviewed" : "unreviewed",
      source_report_ids: layer.source_report_ids ?? [],
      fan_in: 0,
      fan_out: 0,
      attributes: { hierarchy_role: "architecture_layer", component_ids: layer.component_ids },
    };
    if (includeRepositoryRoot) {
      nodes.push(layerNode);
      hierarchyEdges.push(semanticHierarchyEdge(root, layerNode));
    }
    const scopes = scopePlan.scopes.filter((scope) => scope.layer_id === layer.id);
    const scopeByComponent = new Map(scopes.flatMap((scope) => scope.component_ids.map((componentId) => [componentId, scope] as const)));
    for (const scope of scopes) {
      const scopeNode: SnapshotNode = {
        id: scope.id,
        entity_kind: "domain",
        parent_entity_id: includeRepositoryRoot ? layer.id : null,
        depth: includeRepositoryRoot ? 2 : 0,
        label: scope.name,
        name: scope.name,
        responsibility: scope.responsibility,
        grouping_rationale: scope.grouping_rationale,
        architecture_layer_id: layer.id,
        architecture_layer_name: layer.name,
        architecture_layer_candidates: [],
        architecture_layer_rationale: layerNode.grouping_rationale,
        architecture_layer_certainty: scope.certainty,
        members: [],
        member_count: scope.component_ids.length,
        evidence: scope.evidence,
        certainty: scope.certainty,
        review_status: scope.certainty === "provider_supported" ? "reviewed" : "unreviewed",
        source_report_ids: [...new Set(scope.component_ids.flatMap((componentId) => componentById.get(componentId)?.source_report_ids ?? []))],
        fan_in: 0,
        fan_out: 0,
        attributes: {
          hierarchy_role: "responsibility_scope",
          component_ids: scope.component_ids,
          evidence_ids: scope.evidence_ids,
        },
      };
      nodes.push(scopeNode);
      if (includeRepositoryRoot) hierarchyEdges.push(semanticHierarchyEdge(layerNode, scopeNode));
    }
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const component of layerComponents) {
      const scope = scopeByComponent.get(component.id);
      component.parent_entity_id = scope?.id ?? (includeRepositoryRoot ? layer.id : null);
      component.depth = scope ? (includeRepositoryRoot ? 3 : 1) : (includeRepositoryRoot ? 2 : 0);
      nodes.push(component);
      const parent = scope
        ? nodesById.get(scope.id)
        : includeRepositoryRoot ? layerNode : null;
      if (parent) hierarchyEdges.push(semanticHierarchyEdge(parent, component));
    }
  }
  const componentIds = new Set(components.map((component) => component.id));
  const relationEdges = input.snapshot.graph.edges.filter((edge) =>
    !edge.id.startsWith("hierarchy:edge:") && componentIds.has(edge.source) && componentIds.has(edge.target));
  return {
    nodes,
    edges: [...relationEdges, ...hierarchyEdges],
    hierarchy: {
      root_entity_ids: nodes.filter((node) => !node.parent_entity_id).map((node) => node.id).sort(),
      max_depth: nodes.reduce((maximum, node) => Math.max(maximum, node.depth ?? 0), 0),
    },
    scopes: scopePlan.scopes,
  };
}

export function applyArchitectureResult(
  snapshot: BuiltSnapshot,
  result: ArchitectureSemanticResult,
  coverage?: { supportedIds: Set<string>; degradedIds: string[] },
): BuiltSnapshot {
  const mergedComponents = mergeComponents(snapshot, result, coverage);
  const architecture = buildLayers(mergedComponents);
  const supported = coverage?.supportedIds.size ?? result.components
    .filter((patch) => snapshot.graph.nodes.some((node) => node.id === patch.component_id)).length;
  const total = snapshot.graph.nodes
    .filter((node) => (node.entity_kind ?? "component") === "component")
    .length;
  const hierarchy = buildSemanticHierarchy({
    snapshot,
    components: architecture.components,
    layers: architecture.layers,
    proposals: result.scopes ?? [],
    directComponentIds: result.direct_component_ids,
  });
  const architectureOverlays = architecture.layers.map((layer) => ({
    id: layer.id,
    kind: "architecture_layer" as const,
    name: layer.name,
    responsibility: layer.responsibility,
    member_entity_ids: [...layer.component_ids],
    relation_ids: [],
    evidence_ids: [...new Set(layer.evidence.map((row) => row.stable_id))],
    certainty: layer.certainty,
  }));
  const overlays = [
    ...(snapshot.graph.overlays ?? []).filter((overlay) => overlay.kind !== "architecture_layer"),
    ...architectureOverlays,
  ];
  const projections = deriveSnapshotProjections({
    snapshot_id: snapshot.snapshot_id,
    nodes: hierarchy.nodes,
    edges: hierarchy.edges,
    overlays,
  });
  return {
    ...snapshot,
    graph: {
      ...snapshot.graph,
      semantic_mode: supported === total
        ? "provider_supported"
        : supported > 0
          ? "partial_provider_supported"
          : snapshot.graph.semantic_mode,
      semantic_coverage: coverage ? {
        total_components: total,
        provider_supported_components: supported,
        degraded_component_ids: coverage.degradedIds,
      } : snapshot.graph.semantic_coverage,
      nodes: hierarchy.nodes,
      edges: hierarchy.edges,
      layers: architecture.layers,
      hierarchy: hierarchy.hierarchy,
      overlays,
      projections,
      hierarchy_operations: [
        ...(snapshot.graph.hierarchy_operations ?? []),
        ...(result.operations ?? []).map((operation) => ({
          ...operation,
          status: "rejected",
          reason: "superseded_by_responsibility_scope_contract",
        })),
      ],
    },
  };
}
