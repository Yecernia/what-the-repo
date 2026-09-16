import { getArchitectureLayers, leafComponents, handleSides, NODE_WIDTH, NODE_HEIGHT, LAYER_NODE_WIDTH, LAYER_NODE_HEIGHT } from './component-overview';
export { getArchitectureLayers, buildLayerOverviewFlow, handleSides } from './component-overview';
import { t } from './ui-language';
import dagre from '@dagrejs/dagre';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { ArchitectureLayer, GraphNode, Snapshot, SnapshotProjection } from './types';

export interface ComponentNodeData extends Record<string, unknown> {
  onOverviewEnter?: () => void;
  component: GraphNode;
  targetLayerId?: string;
  scopeName?: string;
  scopeId?: string;
  projectionNodeId?: string;
  projectionEvidenceIds?: string[];
  projectionAggregateMemberEntityIds?: string[];
  projectionOverlayIds?: string[];
  external?: boolean;
  dimmed?: boolean;
  focused?: boolean;
  layerColorIndex?: number;
}

export interface LayerNodeData extends Record<string, unknown> {
  onOverviewEnter?: () => void;
  overview?: boolean;
  layer: ArchitectureLayer;
  componentCount: number;
  layerColorIndex: number;
  rangeKind?: 'layer' | 'scope';
  portal?: boolean;
  external?: boolean;
  dimmed?: boolean;
  focused?: boolean;
  targetLayerId?: string;
  targetScopeId?: string;
  relatedComponentCount?: number;
  relationCount?: number;
}

export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  scopeId: string;
  external?: boolean;
  onCollapse?: () => void;
}

export interface LayerExpansion {
  expandedScopeId?: string | null;
  activeComponentId?: string | null;
  expandedExternalScopeId?: string | null;
  focusComponentId?: string | null;
}

export interface ArchitectureScope extends ArchitectureLayer {
  layer_id: string;
  entity_id: string | null;
  grouping_rationale: string;
}

export interface ComponentEdgeData extends Record<string, unknown> {
  lane: number;
}

export type ComponentFlowNode = Node<ComponentNodeData, 'component'>;
export type LayerFlowNode = Node<LayerNodeData, 'layer'>;
export type GroupFlowNode = Node<GroupNodeData, 'group'>;
export type ArchitectureFlowNode = ComponentFlowNode | LayerFlowNode | GroupFlowNode;

const NODE_GAP_X = 42;
const NODE_GAP_Y = 34;
const DENSE_EDGE_THRESHOLD = 420;
const MAX_DISPLAY_EDGES = 160;
const LAYER_NODE_GAP_X = 64;
const LAYER_NODE_GAP_Y = 54;
const GROUP_NODE_MIN_WIDTH = 340;
const GROUP_NODE_MIN_HEIGHT = 196;
const GROUP_PADDING_X = 28;
const GROUP_PADDING_TOP = 42;
const GROUP_PADDING_BOTTOM = 26;

type GraphRelation = Snapshot['graph']['edges'][number];

export interface ComponentFlow {
  nodes: ComponentFlowNode[];
  edges: Edge[];
  omittedEdgeCount: number;
}

export interface ProjectionFlow {
  nodes: ComponentFlowNode[];
  edges: Edge[];
  omittedEdgeCount: number;
}

const flowCache = new WeakMap<object, ComponentFlow>();
const projectionFlowCache = new WeakMap<object, ProjectionFlow>();

function humanProjection(snapshot: Snapshot): SnapshotProjection | null {
  const projection = snapshot.graph.projections?.human;
  return projection && projection.snapshot_id === snapshot.snapshot_id ? projection : null;
}

/** Build a readable canvas directly from the canonical human projection. */
export function buildHumanProjectionFlow(snapshot: Snapshot): ProjectionFlow | null {
  const projection = humanProjection(snapshot);
  if (!projection) return null;
  const cached = projectionFlowCache.get(snapshot);
  if (cached) return cached;
  const byEntity = new Map(snapshot.graph.nodes.map(node => [node.id, node]));
  const projected = projection.nodes
    .map(node => ({ projection: node, component: byEntity.get(node.entity_id) }))
    .filter((row): row is { projection: NonNullable<typeof projection.nodes[number]>; component: GraphNode } => Boolean(row.component));
  const columns = new Map<number, typeof projected>();
  for (const row of projected) {
    const depth = Math.max(0, row.projection.depth);
    columns.set(depth, [...(columns.get(depth) ?? []), row]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, rows] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    rows.sort((left, right) => left.component.name.localeCompare(right.component.name) || left.component.id.localeCompare(right.component.id));
    rows.forEach((row, index) => positions.set(row.projection.projection_node_id, {
      x: depth * (NODE_WIDTH + 150),
      y: index * (NODE_HEIGHT + NODE_GAP_Y),
    }));
  }
  const nodes = projected.map<ComponentFlowNode>(row => ({
    id: row.projection.projection_node_id,
    type: 'component',
    position: positions.get(row.projection.projection_node_id) ?? { x: 0, y: 0 },
    data: {
      component: row.component,
      projectionNodeId: row.projection.projection_node_id,
      projectionEvidenceIds: row.projection.evidence_ids,
      projectionAggregateMemberEntityIds: row.projection.aggregate_member_entity_ids,
      projectionOverlayIds: row.projection.overlay_ids,
      focused: false,
      dimmed: false,
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    ariaLabel: t("实体 {0}", row.component.name),
  }));
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = projection.edges
    .filter(edge => nodeIds.has(edge.source_projection_node_id) && nodeIds.has(edge.target_projection_node_id))
    .map<Edge>((edge, index) => ({
      id: edge.projection_edge_id,
      source: edge.source_projection_node_id,
      target: edge.target_projection_node_id,
      ...handleSides(edge.source_projection_node_id, edge.target_projection_node_id, new Map(nodes.map(node => [node.id, {
        ...node.position,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }]))),
      type: 'relation',
      label: edge.relation_id ? undefined : t("{0} 条关系", edge.aggregate_relation_ids.length),
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        lane: index % 3,
        aggregate: edge.relation_id === null,
        relationIds: edge.aggregate_relation_ids,
        projectionEdgeId: edge.projection_edge_id,
        evidenceIds: edge.evidence_ids,
        alwaysLabel: edge.relation_id === null,
      },
      ariaLabel: edge.relation_id ? t("关系 {0}", edge.relation_id) : t("合并显示的 {0} 条关系", edge.aggregate_relation_ids.length),
    }));
  const result = { nodes, edges, omittedEdgeCount: projection.omitted_relation_count ?? 0 };
  projectionFlowCache.set(snapshot, result);
  return result;
}

function compactLayoutForNodes(
  components: GraphNode[],
  layers: ArchitectureLayer[],
): Map<string, { x: number; y: number }> {
  const layerOrder = new Map(layers.map((layer, index) => [layer.id, index]));
  const groups = new Map<number, GraphNode[]>();
  const unassigned = Math.max(layerOrder.size, 0);

  for (const component of components) {
    const layer = component.architecture_layer_id
      ? (layerOrder.get(component.architecture_layer_id) ?? unassigned)
      : unassigned;
    const group = groups.get(layer) ?? [];
    group.push(component);
    groups.set(layer, group);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a - b);
  const packColumns = orderedGroups.length > 4 ? 2 : 1;
  const maxColumnsPerGroup = packColumns === 1 ? 8 : 4;
  const groupColumnWidth = maxColumnsPerGroup * (NODE_WIDTH + NODE_GAP_X) + 90;
  const columnHeights = Array.from({ length: packColumns }, () => 0);
  for (const [, components] of orderedGroups) {
    components.sort((a, b) => (
      (b.fan_out + b.fan_in) - (a.fan_out + a.fan_in)
      || a.name.localeCompare(b.name)
    ));
    const columns = Math.min(maxColumnsPerGroup, Math.max(1, Math.ceil(Math.sqrt(components.length))));
    const packColumn = columnHeights.indexOf(Math.min(...columnHeights));
    const baseX = packColumn * groupColumnWidth;
    const baseY = columnHeights[packColumn];
    components.forEach((component, column) => {
      positions.set(component.id, {
        x: baseX + (column % columns) * (NODE_WIDTH + NODE_GAP_X),
        y: baseY + Math.floor(column / columns) * (NODE_HEIGHT + NODE_GAP_Y),
      });
    });
    columnHeights[packColumn] += Math.ceil(components.length / columns) * (NODE_HEIGHT + NODE_GAP_Y) + 72;
  }
  return positions;
}

function compactLayout(snapshot: Snapshot): Map<string, { x: number; y: number }> {
  return compactLayoutForNodes(snapshot.graph.nodes, snapshot.graph.layers);
}

function displayRelations(snapshot: Snapshot) {
  const relations = snapshot.graph.edges;
  if (relations.length <= DENSE_EDGE_THRESHOLD) {
    return { relations, omittedEdgeCount: 0 };
  }

  // Dense component graphs are still fully available in the snapshot and in
  // evidence tools. The canvas only needs a readable representative view.
  const ranked = [...relations].sort((a, b) => (
    (b.weight - a.weight)
    || a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target)
    || a.id.localeCompare(b.id)
  ));
  const selected = new Set<string>();
  const visible = [] as typeof relations;
  const add = (relation: (typeof relations)[number]) => {
    if (selected.has(relation.id) || visible.length >= MAX_DISPLAY_EDGES) return;
    selected.add(relation.id);
    visible.push(relation);
  };

  // First keep one strongest connection touching every visible component.
  for (const node of snapshot.graph.nodes) {
    add(ranked.find(relation => relation.source === node.id || relation.target === node.id) ?? ranked[0]);
  }
  for (const relation of ranked) add(relation);
  return { relations: visible, omittedEdgeCount: relations.length - visible.length };
}

export function buildComponentFlow(snapshot: Snapshot): {
  nodes: ComponentFlowNode[];
  edges: Edge[];
  omittedEdgeCount: number;
} {
  const cached = flowCache.get(snapshot);
  if (cached) return cached;

  const dense = snapshot.graph.edges.length > DENSE_EDGE_THRESHOLD || snapshot.graph.nodes.length > 140;
  const graph = new dagre.graphlib.Graph();
  let positions: Map<string, { x: number; y: number }>;
  if (dense) {
    positions = compactLayout(snapshot);
  } else {
    graph.setDefaultEdgeLabel(() => ({}));
    graph.setGraph({
      rankdir: 'LR',
      ranksep: 120,
      nodesep: 52,
      marginx: 40,
      marginy: 40,
    });
    for (const component of snapshot.graph.nodes) {
      graph.setNode(component.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const relation of snapshot.graph.edges) {
      graph.setEdge(relation.source, relation.target, { weight: Math.max(1, relation.weight) });
    }
    dagre.layout(graph);
    positions = new Map(snapshot.graph.nodes.map(component => {
      const point = graph.node(component.id) as { x: number; y: number } | undefined;
      return [component.id, {
        x: (point?.x ?? 0) - NODE_WIDTH / 2,
        y: (point?.y ?? 0) - NODE_HEIGHT / 2,
      }];
    }));
  }

  const { relations, omittedEdgeCount } = displayRelations(snapshot);

  const nodes = snapshot.graph.nodes.map<ComponentFlowNode>(component => {
    const point = positions.get(component.id);
    return {
      id: component.id,
      type: 'component',
      position: {
        x: point?.x ?? 0,
        y: point?.y ?? 0,
      },
      data: { component },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      ariaLabel: t("组件 {0}", component.name),
    };
  });
  const flowPositions = new Map([...positions.entries()].map(([id, point]) => [id, { ...point, width: NODE_WIDTH, height: NODE_HEIGHT }]));
  const edges = relationEdges(relations, { positions: flowPositions });
  const result = { nodes, edges, omittedEdgeCount };
  flowCache.set(snapshot, result);
  return result;
}

function relationEdges(
  relations: Snapshot['graph']['edges'],
  options: { aggregate?: boolean; positions?: Map<string, { x: number; y: number; width?: number; height?: number }> } = {},
): Edge[] {
  const groups = new Map<string, { source: string; target: string; relations: GraphRelation[] }>();
  for (const relation of relations) {
    const [source, target] = [relation.source, relation.target].sort();
    const key = `${source}\u0000${target}`;
    const group = groups.get(key) ?? { source: relation.source, target: relation.target, relations: [] };
    group.relations.push(relation);
    groups.set(key, group);
  }
  return [...groups.values()].map<Edge>(group => {
    const representative = group.relations[0];
    const label = group.relations.length === 1
      ? representative.label
      : t("{0} 条关系", group.relations.length);
    return {
      id: `relation:${group.source}:${group.target}`,
      source: group.source,
      target: group.target,
      ...handleSides(group.source, group.target, options.positions),
      label,
      type: 'relation',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        relation: representative,
        relationIds: group.relations.map(item => item.id),
        lane: 0,
        aggregate: options.aggregate ?? false,
      },
      style: {
        strokeWidth: Math.min(5, 1.4 + Math.log2(group.relations.reduce((sum, item) => sum + item.weight, 0) + 1)),
      },
      ariaLabel: t("关系 {0}", label),
    };
  });
}

function layerIndex(snapshot: Snapshot): Map<string, number> {
  return new Map(getArchitectureLayers(snapshot).map((layer, index) => [layer.id, index]));
}

const MAX_COMPONENTS_PER_SCOPE = 12;

function semanticAncestorChain(component: GraphNode, byId: Map<string, GraphNode>): GraphNode[] {
  const chain: GraphNode[] = [];
  const visited = new Set<string>();
  let current = component.parent_entity_id ? byId.get(component.parent_entity_id) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (!['repository', 'system', 'fact', 'component'].includes(current.entity_kind ?? '')) chain.push(current);
    current = current.parent_entity_id ? byId.get(current.parent_entity_id) : undefined;
  }
  return chain.reverse();
}

function structuralPath(component: GraphNode): string {
  const path = component.evidence[0]?.path || component.members[0]?.path || '';
  const [first] = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return first || 'root';
}

function pathScopeName(path: string, layer: ArchitectureLayer): string {
  if (path === 'root') return t("{0} 分组", layer.name);
  return path;
}

/**
 * Derive one bounded set of named responsibility scopes inside an architecture
 * layer. Existing semantic ancestors supply names and Evidence; oversized
 * ancestors are split by their next semantic child without adding another UI level.
 */
export function getArchitectureScopes(snapshot: Snapshot, layerId: string): ArchitectureScope[] {
  const layer = getArchitectureLayers(snapshot).find(item => item.id === layerId);
  if (!layer) return [];
  const byId = new Map(snapshot.graph.nodes.map(node => [node.id, node]));
  const componentById = new Map(leafComponents(snapshot).map(component => [component.id, component]));
  const canonicalScopes = snapshot.graph.nodes.filter(node => node.entity_kind === 'domain' && (
    node.parent_entity_id === layer.id || node.architecture_layer_id === layer.id
  ));
  if (canonicalScopes.length > 0) {
    return canonicalScopes
      .map<ArchitectureScope>(scope => {
        const declaredIds = Array.isArray(scope.attributes?.component_ids)
          ? scope.attributes.component_ids.filter((id): id is string => typeof id === 'string')
          : [];
        const componentIds = [...new Set([
          ...layer.component_ids.filter(id => componentById.get(id)?.parent_entity_id === scope.id),
          ...declaredIds.filter(id => layer.component_ids.includes(id) && componentById.has(id)),
        ])];
        const components = componentIds.map(id => componentById.get(id) as GraphNode);
        const evidence = [
          ...scope.evidence,
          ...scope.members,
          ...components.flatMap(component => component.evidence),
        ];
        return {
          id: scope.id,
          layer_id: layer.id,
          entity_id: scope.id,
          name: scope.name,
          responsibility: scope.responsibility,
          grouping_rationale: scope.grouping_rationale,
          component_ids: componentIds,
          evidence: [...new Map(evidence.map(item => [item.stable_id, item])).values()].slice(0, 24),
          certainty: scope.certainty,
          source_report_ids: [...new Set([
            ...scope.source_report_ids,
            ...components.flatMap(component => component.source_report_ids),
          ])],
        };
      })
      .filter(scope => scope.component_ids.length >= 2)
      .sort((left, right) => (
        right.component_ids.length - left.component_ids.length
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
      ));
  }
  const rows = layer.component_ids
    .map(id => componentById.get(id))
    .filter((component): component is GraphNode => Boolean(component))
    .map(component => ({ component, ancestors: semanticAncestorChain(component, byId) }));
  const anchored = rows.filter(row => row.ancestors.length > 0);
  const flat = rows.filter(row => row.ancestors.length === 0);
  const groups: Array<{ anchor: GraphNode | null; key: string; components: GraphNode[]; path?: string }> = [];

  const partition = (items: typeof anchored, level: number) => {
    const buckets = new Map<string, typeof anchored>();
    for (const row of items) {
      const anchor = row.ancestors[level] ?? row.component;
      buckets.set(anchor.id, [...(buckets.get(anchor.id) ?? []), row]);
    }
    for (const [key, bucket] of buckets) {
      const canSplit = bucket.length > MAX_COMPONENTS_PER_SCOPE
        && bucket.some(row => Boolean(row.ancestors[level + 1]));
      if (canSplit) partition(bucket, level + 1);
      else groups.push({
        anchor: byId.get(key) ?? componentById.get(key) ?? null,
        key,
        components: bucket.map(row => row.component),
      });
    }
  };
  if (anchored.length) partition(anchored, 0);

  const flatBuckets = new Map<string, GraphNode[]>();
  for (const row of flat) {
    const path = structuralPath(row.component);
    flatBuckets.set(path, [...(flatBuckets.get(path) ?? []), row.component]);
  }
  for (const [path, components] of flatBuckets) {
    groups.push({ anchor: null, key: `path:${path}`, path, components });
  }

  return groups
    .map<ArchitectureScope>(group => {
      const anchorIsComponent = group.anchor?.entity_kind === 'component' || componentById.has(group.anchor?.id ?? '');
      const name = group.anchor
        ? (anchorIsComponent ? t("{0} 分组", group.anchor.name) : group.anchor.name)
        : pathScopeName(group.path ?? 'root', layer);
      const evidence = [
        ...(group.anchor?.evidence ?? []),
        ...(group.anchor?.members ?? []),
        ...group.components.flatMap(component => component.evidence),
      ];
      return {
        id: `scope:${layer.id}:${group.key}`,
        layer_id: layer.id,
        entity_id: group.anchor?.id ?? null,
        name,
        responsibility: group.anchor?.responsibility?.trim()
          || (group.path === 'root'
            ? t("包含 {0} 的主要组件。", layer.name)
            : t("{0} 中与 {1} 相关的组件。", group.path, layer.name)),
        grouping_rationale: group.anchor?.grouping_rationale?.trim()
          || t("这些组件位于同一目录：{0}。", group.path ?? t("根目录")),
        component_ids: group.components.map(component => component.id),
        evidence: [...new Map(evidence.map(item => [item.stable_id, item])).values()].slice(0, 24),
        certainty: group.anchor?.certainty ?? layer.certainty,
        source_report_ids: [...new Set([
          ...(group.anchor?.source_report_ids ?? []),
          ...group.components.flatMap(component => component.source_report_ids),
        ])],
      };
    })
    .filter(scope => scope.component_ids.length >= 2)
    .sort((left, right) => (
      right.component_ids.length - left.component_ids.length
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    ));
}

function allArchitectureScopes(snapshot: Snapshot): ArchitectureScope[] {
  return getArchitectureLayers(snapshot).flatMap(layer => getArchitectureScopes(snapshot, layer.id));
}

function directLayerComponents(
  snapshot: Snapshot,
  layer: ArchitectureLayer,
  scopes: ArchitectureScope[],
): GraphNode[] {
  const componentById = new Map(leafComponents(snapshot).map(component => [component.id, component]));
  const scopedIds = new Set(scopes.flatMap(scope => scope.component_ids));
  return layer.component_ids
    .filter(id => !scopedIds.has(id))
    .map(id => componentById.get(id))
    .filter((component): component is GraphNode => Boolean(component))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Keep the layer's cards on screen, with at most one main and one external frame. */
export function buildLayerScopeFlow(
  snapshot: Snapshot,
  activeLayerId: string,
  expansion: LayerExpansion = {},
): { nodes: ArchitectureFlowNode[]; edges: Edge[]; omittedEdgeCount: number } {
  const layer = getArchitectureLayers(snapshot).find(item => item.id === activeLayerId);
  if (!layer) return { nodes: [], edges: [], omittedEdgeCount: 0 };
  const scopes = allArchitectureScopes(snapshot);
  const layerScopes = scopes.filter(scope => scope.layer_id === activeLayerId);
  const components = leafComponents(snapshot);
  const componentById = new Map(components.map(component => [component.id, component]));
  const scopeByComponent = new Map(scopes.flatMap(scope => scope.component_ids.map(id => [id, scope] as const)));
  const layerComponentIds = new Set(layer.component_ids);
  const mainScope = layerScopes.find(scope => scope.id === expansion.expandedScopeId);
  const directComponents = directLayerComponents(snapshot, layer, layerScopes);
  const mainComponent = !mainScope ? directComponents.find(component => component.id === expansion.activeComponentId) : undefined;
  const hasSubject = Boolean(mainScope || mainComponent);
  const externalScope = hasSubject ? scopes.find(scope => (
    scope.id === expansion.expandedExternalScopeId && scope.layer_id !== activeLayerId
  )) : undefined;
  const openScopes = [mainScope, externalScope].filter((scope): scope is ArchitectureScope => Boolean(scope));
  const openIds = new Set([
    ...openScopes.flatMap(scope => scope.component_ids),
    ...(mainComponent ? [mainComponent.id] : []),
  ]);
  const relations = snapshot.graph.edges.filter(relation => (
    componentById.has(relation.source) && componentById.has(relation.target)
    && (hasSubject
      ? openIds.has(relation.source) || openIds.has(relation.target)
      : layerComponentIds.has(relation.source) && layerComponentIds.has(relation.target))
  ));
  const relatedIds = new Set(relations.flatMap(relation => [relation.source, relation.target]));
  const foreignScopes = scopes.filter(scope => scope.layer_id !== activeLayerId
    && (scope.id === externalScope?.id || scope.component_ids.some(id => relatedIds.has(id))));
  const foreignSingles = components.filter(component => relatedIds.has(component.id)
    && !layerComponentIds.has(component.id) && !scopeByComponent.has(component.id));
  const colors = layerIndex(snapshot);
  const displayByComponent = new Map<string, string>();
  const frameByComponent = new Map<string, string>();
  const membersByNode = new Map<string, string[]>();
  type FlowItem = { node: ArchitectureFlowNode; children: ComponentFlowNode[] };
  const scopeItem = (scope: ArchitectureScope): FlowItem => {
    const external = scope.layer_id !== activeLayerId;
    const expanded = scope.id === mainScope?.id || scope.id === externalScope?.id;
    const id = expanded ? 'frame:' + scope.id : external ? 'portal:' + scope.id : scope.id;
    membersByNode.set(id, scope.component_ids);
    scope.component_ids.forEach(componentId => displayByComponent.set(componentId, id));
    if (expanded) {
      const layout = groupFrameLayout({
        id, label: scope.name, scopeId: scope.id, external, position: { x: 0, y: 0 },
        components: scope.component_ids.map(componentId => componentById.get(componentId))
          .filter((component): component is GraphNode => Boolean(component)),
      });
      layout.children.forEach(child => {
        frameByComponent.set(child.id, id);
        membersByNode.set(child.id, [child.id]);
        child.data.layerColorIndex = colors.get(scope.layer_id) ?? 0;
      });
      return { node: layout.frame, children: layout.children };
    }
    return {
      node: {
        id, type: 'layer', position: { x: 0, y: 0 },
        data: {
          layer: scope, componentCount: scope.component_ids.length,
          layerColorIndex: colors.get(scope.layer_id) ?? 0,
          rangeKind: 'scope', external, portal: external,
          targetLayerId: scope.layer_id, targetScopeId: scope.id,
          relatedComponentCount: scope.component_ids.filter(componentId => relatedIds.has(componentId)).length,
          relationCount: relations.filter(relation => scope.component_ids.includes(relation.source)
            || scope.component_ids.includes(relation.target)).length,
        },
        width: LAYER_NODE_WIDTH, height: LAYER_NODE_HEIGHT,
        ariaLabel: (external ? t("外部") : '') + t("组件分组 ") + scope.name,
      },
      children: [],
    };
  };
  const componentItem = (component: GraphNode, external: boolean): FlowItem => {
    displayByComponent.set(component.id, component.id);
    membersByNode.set(component.id, [component.id]);
    return {
      node: {
        id: component.id, type: 'component', position: { x: 0, y: 0 },
        data: {
          component, external,
          scopeName: external ? component.architecture_layer_name ?? t("基础组件") : layer.name,
          layerColorIndex: colors.get(component.architecture_layer_id ?? activeLayerId) ?? 0,
        },
        width: NODE_WIDTH, height: NODE_HEIGHT, ariaLabel: t("组件 ") + component.name,
      },
      children: [],
    };
  };
  const localItems = [
    ...layerScopes.map(scopeItem),
    ...directComponents.map(component => componentItem(component, false)),
  ];
  const foreignItems = [
    ...foreignScopes.map(scopeItem),
    ...foreignSingles.map(component => componentItem(component, true)),
  ];
  const nodes: ArchitectureFlowNode[] = [];
  const placeItem = (item: FlowItem, x: number, y: number) => {
    item.node.position = { x, y };
    item.children.forEach(child => {
      child.position = { x: child.position.x + x, y: child.position.y + y };
    });
    nodes.push(item.node, ...item.children);
  };
  // Keep the subject anchored, and reserve an adjacent slot for the external
  // frame. Related cards must not separate the two frames being compared.
  const placeItems = (items: FlowItem[], startY: number): number => {
    // Size each region for its own cards. A small main layer can still have many
    // external neighbors, and opening those must not move the main layer's rows.
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(items.length))));
    const rowWidth = Math.max(
      columns * (LAYER_NODE_WIDTH + LAYER_NODE_GAP_X) - LAYER_NODE_GAP_X,
      ...items.map(item => item.node.width ?? NODE_WIDTH),
    );
    let x = 0;
    let y = startY;
    let rowHeight = 0;
    for (const item of items) {
      const width = item.node.width ?? NODE_WIDTH;
      const height = item.node.height ?? NODE_HEIGHT;
      if (x > 0 && (item.node.type === 'group' || x + width > rowWidth)) {
        x = 0;
        y += rowHeight + LAYER_NODE_GAP_Y;
        rowHeight = 0;
      }
      placeItem(item, x, y);
      rowHeight = Math.max(rowHeight, height);
      x += width + LAYER_NODE_GAP_X;
      if (item.node.type === 'group') x = rowWidth + LAYER_NODE_GAP_X;
    }
    return y + rowHeight;
  };
  const subject = localItems.find(item => item.node.type === 'group' || item.node.id === mainComponent?.id);
  const comparison = foreignItems.find(item => item.node.type === 'group');
  if (subject) {
    placeItem(subject, 0, 0);
    if (comparison) placeItem(comparison, (subject.node.width ?? NODE_WIDTH) + 160, 0);
    const bottom = Math.max(subject.node.height ?? NODE_HEIGHT, comparison?.node.height ?? 0);
    placeItems([
      ...localItems.filter(item => item !== subject),
      ...foreignItems.filter(item => item !== comparison),
    ], bottom + 100);
    // Reuse the compact grid, but assign its slots by actual connections to
    // the open frames. This shortens cross-frame curves without stretching a
    // dense cyclic graph into a long dependency chain or removing any edge.
    const anchors = [subject, comparison].filter((item): item is FlowItem => Boolean(item));
    const peripheral = [...localItems, ...foreignItems].filter(item => !anchors.includes(item));
    const links = new Map<string, { anchor: FlowItem; weight: number }[]>();
    for (const relation of relations) {
      const source = displayByComponent.get(relation.source);
      const target = displayByComponent.get(relation.target);
      for (const anchor of anchors) {
        const peer = source === anchor.node.id ? target : target === anchor.node.id ? source : null;
        if (peer && peer !== anchor.node.id) {
          const list = links.get(peer) ?? [];
          list.push({ anchor, weight: Math.max(1, relation.weight) });
          links.set(peer, list);
        }
      }
    }
    const cost = (item: FlowItem, position: { x: number; y: number }) => (links.get(item.node.id) ?? []).reduce((sum, link) => {
      const dx = position.x + (item.node.width ?? NODE_WIDTH) / 2
        - link.anchor.node.position.x - (link.anchor.node.width ?? NODE_WIDTH) / 2;
      const dy = position.y + (item.node.height ?? NODE_HEIGHT) / 2
        - link.anchor.node.position.y - (link.anchor.node.height ?? NODE_HEIGHT) / 2;
      return sum + link.weight * Math.hypot(dx, dy);
    }, 0);
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false;
      for (let i = 0; i < peripheral.length; i += 1) {
        for (let j = i + 1; j < peripheral.length; j += 1) {
          const a = peripheral[i], b = peripheral[j];
          const before = cost(a, a.node.position) + cost(b, b.node.position);
          const after = cost(a, b.node.position) + cost(b, a.node.position);
          if (after + 1 < before) {
            [a.node.position, b.node.position] = [b.node.position, a.node.position];
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  } else {
    const localBottom = placeItems(localItems, 0);
    placeItems(foreignItems, localBottom + 100);
  }
  const positions = new Map(nodes.map(node => [node.id, { ...node.position, width: node.width, height: node.height }]));
  const focus = nodes.some(node => node.type === 'component' && node.id === expansion.focusComponentId)
    ? expansion.focusComponentId : null;
  const internalRelations = relations.filter(relation => frameByComponent.has(relation.source)
    && frameByComponent.get(relation.source) === frameByComponent.get(relation.target));
  const crossRelations = relations.filter(relation => {
    const source = displayByComponent.get(relation.source);
    const target = displayByComponent.get(relation.target);
    return source && target && source !== target;
  });
  const edges = [
    ...relationEdges(internalRelations, { positions }),
    ...aggregateRelationEdges(crossRelations, relation => {
      const connected = focus && (relation.source === focus || relation.target === focus);
      // An open frame is only a container. Focused relationships land on its
      // actual members, and must not share an aggregate with unrelated pairs.
      const endpoint = (id: string) => connected && frameByComponent.has(id) ? id : displayByComponent.get(id)!;
      return { source: endpoint(relation.source), target: endpoint(relation.target) };
    }, 'scope-edge:' + activeLayerId, { positions, portal: hasSubject }),
  ];
  // Focus changes the visible relationship endpoints, never node membership,
  // layout positions or the underlying evidence/relationship set.
  const neighbors = new Set<string>(focus ? [focus] : []);
  if (focus) {
    for (const relation of relations) {
      if (relation.source === focus) neighbors.add(relation.target);
      if (relation.target === focus) neighbors.add(relation.source);
    }
  }
  for (const node of nodes) {
    if (node.type === 'group') continue;
    const members = membersByNode.get(node.id) ?? [];
    node.data.focused = members.includes(focus ?? '');
    node.data.dimmed = Boolean(focus && !members.some(id => neighbors.has(id)));
    node.draggable = !node.data.dimmed && node.draggable !== false;
  }
  if (focus) {
    const focusedRelationIds = new Set(relations.filter(relation => relation.source === focus || relation.target === focus).map(relation => relation.id));
    for (const edge of edges) {
      const connected = (edge.data?.relationIds as string[] | undefined)?.some(id => focusedRelationIds.has(id));
      edge.style = { ...edge.style, opacity: connected ? 1 : 0.08, stroke: connected ? 'var(--accent)' : 'var(--graph-edge)' };
    }
  }
  return { nodes, edges, omittedEdgeCount: 0 };
}

function aggregateRelationEdges(
  relations: GraphRelation[],
  endpoint: (relation: GraphRelation) => { source: string; target: string },
  idPrefix: string,
  options: { portal?: boolean; accent?: boolean; positions?: Map<string, { x: number; y: number; width?: number; height?: number }> } = {},
): Edge[] {
  const groups = new Map<string, {
    source: string;
    target: string;
    relations: GraphRelation[];
    weight: number;
  }>();
  for (const relation of relations) {
    const { source, target } = endpoint(relation);
    const [normalizedSource, normalizedTarget] = [source, target].sort();
    const key = `${normalizedSource}\u0000${normalizedTarget}`;
    const group = groups.get(key) ?? { source, target, relations: [], weight: 0 };
    group.relations.push(relation);
    group.weight += relation.weight;
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => ({
    id: `${idPrefix}:${index}:${group.source}:${group.target}`,
    source: group.source,
    target: group.target,
    ...handleSides(group.source, group.target, options.positions),
    type: 'relation',
    label: group.relations.length === 1 ? group.relations[0].label : t("{0} 条关系", group.relations.length),
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      lane: 0,
      aggregate: true,
      portal: options.portal ?? false,
      relationIds: group.relations.map(relation => relation.id),
    },
    style: {
      strokeWidth: Math.min(3.6, 2.4 + Math.log2(group.weight + 1) * 0.12),
      stroke: options.accent ? 'var(--accent)' : undefined,
    },
    ariaLabel: t("合并显示的 {0} 条关系", group.relations.length),
  }));
}

function groupFrameLayout(input: {
  id: string;
  label: string;
  scopeId: string;
  components: GraphNode[];
  position: { x: number; y: number };
  external: boolean;
}): { frame: GroupFlowNode; children: ComponentFlowNode[]; width: number; height: number } {
  const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(input.components.length))));
  const rows = Math.max(1, Math.ceil(input.components.length / columns));
  const contentWidth = columns * NODE_WIDTH + Math.max(0, columns - 1) * NODE_GAP_X;
  const contentHeight = rows * NODE_HEIGHT + Math.max(0, rows - 1) * NODE_GAP_Y;
  const width = Math.max(GROUP_NODE_MIN_WIDTH, contentWidth + GROUP_PADDING_X * 2);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, GROUP_PADDING_TOP + contentHeight + GROUP_PADDING_BOTTOM);
  const frame: GroupFlowNode = {
    id: input.id,
    type: 'group',
    position: input.position,
    data: {
      label: input.label,
      scopeId: input.scopeId,
      external: input.external,
    },
    width,
    height,
    selectable: false,
    draggable: false,
    zIndex: -1,
    ariaLabel: t("{0}分组 {1}", input.external ? t("外部") : '', input.label),
  };
  const children = input.components.map<ComponentFlowNode>((component, index) => ({
    id: component.id,
    type: 'component',
    position: {
      x: input.position.x + GROUP_PADDING_X + (index % columns) * (NODE_WIDTH + NODE_GAP_X),
      y: input.position.y + GROUP_PADDING_TOP + Math.floor(index / columns) * (NODE_HEIGHT + NODE_GAP_Y),
    },
    zIndex: 1,
    draggable: false,
    data: {
      component,
      scopeName: input.label,
      scopeId: input.scopeId,
      external: input.external,
      focused: false,
      layerColorIndex: 0,
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    ariaLabel: t("组件 {0}", component.name),
  }));
  return { frame, children, width, height };
}
