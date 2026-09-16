import { t } from './ui-language';
import type { Edge, MarkerType } from '@xyflow/react';
import type { ArchitectureLayer, GraphNode, Snapshot } from './types';
import type { ArchitectureFlowNode } from './component-flow';

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 156;
export const LAYER_NODE_WIDTH = 320;
export const LAYER_NODE_HEIGHT = 188;
export const SHARED_SUPPORT_LAYER_ID = 'layer:shared-support';

export function leafComponents(snapshot: Snapshot): GraphNode[] {
  const explicit = snapshot.graph.nodes.filter(node => node.entity_kind === 'component');
  if (explicit.length) return explicit;
  const parentIds = new Set(snapshot.graph.nodes
    .map(node => node.parent_entity_id)
    .filter((id): id is string => Boolean(id)));
  return snapshot.graph.nodes.filter(node => node.entity_kind !== 'fact' && !parentIds.has(node.id));
}

/** Build one complete, non-overlapping set of user-visible architecture layers. */
export function getArchitectureLayers(snapshot: Snapshot): ArchitectureLayer[] {
  const components = leafComponents(snapshot);
  const componentIds = new Set(components.map(component => component.id));
  const sourceLayers = snapshot.graph.layers.map(layer => ({ ...layer, component_ids: [] as string[] }));
  const byLayerId = new Map(sourceLayers.map(layer => [layer.id, layer]));
  const sourceMembership = new Map<string, string>();
  for (const layer of snapshot.graph.layers) {
    for (const componentId of layer.component_ids) {
      if (componentIds.has(componentId) && !sourceMembership.has(componentId)) {
        sourceMembership.set(componentId, layer.id);
      }
    }
  }
  let fallback: ArchitectureLayer | null = null;
  for (const component of components) {
    const semanticLayerId = component.architecture_layer_id?.trim() || null;
    let target = semanticLayerId ? byLayerId.get(semanticLayerId) : undefined;
    target ??= sourceMembership.get(component.id)
      ? byLayerId.get(sourceMembership.get(component.id) as string)
      : undefined;
    if (!target && semanticLayerId && component.architecture_layer_name?.trim()) {
      target = {
        id: semanticLayerId,
        name: component.architecture_layer_name.trim(),
        responsibility: component.architecture_layer_rationale?.trim()
          || t("{0} 相关功能。", component.architecture_layer_name.trim()),
        component_ids: [],
        evidence: component.evidence,
        certainty: component.architecture_layer_certainty || component.certainty,
        source_report_ids: component.source_report_ids,
      };
      sourceLayers.push(target);
      byLayerId.set(target.id, target);
    }
    if (!target) {
      fallback ??= {
        id: SHARED_SUPPORT_LAYER_ID,
        name: t("基础组件"),
        responsibility: t("多个模块共用的基础功能。"),
        component_ids: [],
        evidence: [],
        certainty: 'degraded',
        source_report_ids: [],
      };
      target = fallback;
      if (!byLayerId.has(fallback.id)) {
        sourceLayers.push(fallback);
        byLayerId.set(fallback.id, fallback);
      }
      fallback.evidence.push(...component.evidence);
    }
    target.component_ids.push(component.id);
  }
  return sourceLayers
    .filter(layer => layer.component_ids.length > 0)
    .map(layer => ({
      ...layer,
      component_ids: [...new Set(layer.component_ids)],
      evidence: [...new Map(layer.evidence.map(item => [item.stable_id, item])).values()].slice(0, 24),
    }));
}

export function handleSides(source: string, target: string, positions?: Map<string, { x: number; y: number; width?: number; height?: number }>) {
  const from = positions?.get(source);
  const to = positions?.get(target);
  if (!from || !to) return { sourceHandle: 'right-source', targetHandle: 'left-target' };
  const dx = (to.x + (to.width ?? 260) / 2) - (from.x + (from.width ?? 260) / 2);
  const dy = (to.y + (to.height ?? NODE_HEIGHT) / 2) - (from.y + (from.height ?? NODE_HEIGHT) / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right-source', targetHandle: 'left-target' }
      : { sourceHandle: 'left-source', targetHandle: 'right-target' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom-source', targetHandle: 'top-target' }
    : { sourceHandle: 'top-source', targetHandle: 'bottom-target' };
}

/** Keep one overview entry per layer, displaying its component directly when alone. */
export function buildLayerOverviewFlow(snapshot: Snapshot): {
  nodes: ArchitectureFlowNode[];
  edges: Edge[];
  omittedEdgeCount: number;
} {
  const layers = getArchitectureLayers(snapshot);
  const indices = new Map(layers.map((layer, index) => [layer.id, index]));
  const componentLayers = new Map<string, string>();
  const componentById = new Map(leafComponents(snapshot).map(component => [component.id, component]));
  const displayByLayer = new Map(layers.map(layer => [
    layer.id,
    layer.component_ids.length === 1 && componentById.has(layer.component_ids[0]) ? layer.component_ids[0] : layer.id,
  ]));
  const columns = layers.length <= 4 ? 2 : 3;
  for (const layer of layers) {
    for (const componentId of layer.component_ids) componentLayers.set(componentId, layer.id);
  }
  const layerNodes = layers.map<ArchitectureFlowNode>((layer, index) => {
    const single = layer.component_ids.length === 1 ? componentById.get(layer.component_ids[0]) : undefined;
    if (single) return {
      id: single.id, type: 'component',
      position: { x: (index % columns) * 380 + 30, y: Math.floor(index / columns) * 220 + 18 },
      data: { component: single, scopeName: layer.name, targetLayerId: layer.id, layerColorIndex: index },
      width: NODE_WIDTH, height: NODE_HEIGHT, ariaLabel: t("组件 {0}", single.name),
    };
    return {
      id: layer.id, type: 'layer',
      position: { x: (index % columns) * 380, y: Math.floor(index / columns) * 220 },
      data: { layer, componentCount: layer.component_ids.length, layerColorIndex: index },
      width: LAYER_NODE_WIDTH, height: LAYER_NODE_HEIGHT, ariaLabel: t("架构层 {0}", layer.name),
    };
  });

  const grouped = new Map<string, {
    source: string;
    target: string;
    count: number;
    weight: number;
    relationIds: string[];
  }>();
  for (const relation of snapshot.graph.edges) {
    const sourceId = componentLayers.get(relation.source);
    const targetId = componentLayers.get(relation.target);
    const source = sourceId ? indices.get(sourceId) : undefined;
    const target = targetId ? indices.get(targetId) : undefined;
    if (source === undefined || target === undefined || source === target) continue;
    if (!sourceId || !targetId) continue;
    const sourceNodeId = displayByLayer.get(sourceId)!;
    const targetNodeId = displayByLayer.get(targetId)!;
    const [normalizedSourceId, normalizedTargetId] = [sourceNodeId, targetNodeId].sort();
    const key = `${normalizedSourceId}\u0000${normalizedTargetId}`;
    const current = grouped.get(key) ?? { source: sourceNodeId, target: targetNodeId, count: 0, weight: 0, relationIds: [] };
    current.count += 1;
    current.weight += relation.weight;
    current.relationIds.push(relation.id);
    grouped.set(key, current);
  }
  const layerPositions = new Map(layerNodes.map(node => [node.id, {
    ...node.position,
    width: node.width,
    height: node.height,
  }]));
  const edges = [...grouped.values()].map<Edge>((group, index) => ({
    id: `layer-edge:${index}:${group.source}:${group.target}`,
    source: group.source,
    target: group.target,
    ...handleSides(group.source, group.target, layerPositions),
    type: 'relation',
    label: t("{0} 条关系", group.count),
    markerEnd: { type: 'arrowclosed' as MarkerType },
    data: {
      lane: 0,
      aggregate: true,
      alwaysLabel: false,
      count: group.count,
      relationIds: group.relationIds,
    },
    style: { strokeWidth: Math.min(3.6, 2.4 + Math.log2(group.weight + 1) * 0.12) },
    ariaLabel: t("{0} 条跨层关系", group.count),
  }));
  return { nodes: layerNodes, edges, omittedEdgeCount: 0 };
}
