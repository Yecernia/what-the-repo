import { SHARED_SUPPORT_LAYER_ID, getArchitectureLayers } from './component-overview';
import type { Snapshot } from './types';

/** The promo film's card papers (index.css `--tint-*`, each with an `-ink` of the same hue), in preference order. */
const LAYER_TINTS = ['green', 'blue', 'yellow', 'rose', 'lilac', 'teal'] as const;
export type LayerTint = typeof LAYER_TINTS[number];
export interface ArchitectureTints {
  byLayer: ReadonlyMap<string, LayerTint>;
  byComponent: ReadonlyMap<string, LayerTint>;
  /** Layers (and their components) printed on grid paper because every tint was taken by a related layer. */
  gridLayers: ReadonlySet<string>;
  gridComponents: ReadonlySet<string>;
}
export interface LayerPapers { tints: Map<string, LayerTint>; grid: Set<string> }

/**
 * Colour layers like a political map: related layers never share a tint, so the 相关 cards around a drilled-in layer
 * differ from it. Greedy in list order; among the allowed tints prefer one no sibling uses (a layer two hops away, which
 * appears beside this one as a 相关 card around their shared neighbour), then one that differs from the previous layer
 * (its neighbour in the overview grid), then the least used so far, then palette order. Only when related layers already
 * hold all six tints does the layer take the least-conflicting tint on grid paper; siblings never cause grid paper.
 */
export function assignLayerPapers(layerIds: readonly string[], relations: Iterable<readonly [string, string]>): LayerPapers {
  const related = new Map<string, Set<string>>(layerIds.map(id => [id, new Set()]));
  for (const [a, b] of relations) {
    if (a === b || !related.has(a) || !related.has(b)) continue;
    related.get(a)!.add(b);
    related.get(b)!.add(a);
  }
  const tints = new Map<string, LayerTint>();
  const grid = new Set<string>();
  const usage = new Map<LayerTint, number>(LAYER_TINTS.map(tint => [tint, 0]));
  let previous: LayerTint | undefined;
  for (const id of layerIds) {
    const conflicts = new Map<LayerTint, number>(LAYER_TINTS.map(tint => [tint, 0]));
    for (const other of related.get(id)!) {
      const tint = tints.get(other);
      if (tint) conflicts.set(tint, conflicts.get(tint)! + 1);
    }
    const siblingUses = new Map<LayerTint, number>(LAYER_TINTS.map(tint => [tint, 0]));
    const siblings = new Set([...related.get(id)!].flatMap(other => [...related.get(other)!]));
    for (const sibling of siblings) {
      const tint = sibling !== id ? tints.get(sibling) : undefined;
      if (tint) siblingUses.set(tint, siblingUses.get(tint)! + 1);
    }
    const allowed = LAYER_TINTS.filter(tint => !conflicts.get(tint));
    const candidates = allowed.length ? allowed : [...LAYER_TINTS];
    const rank = (tint: LayerTint) => [conflicts.get(tint)!, siblingUses.get(tint)!, tint === previous ? 1 : 0, usage.get(tint)!, LAYER_TINTS.indexOf(tint)];
    const tint = candidates.reduce((best, tint) => {
      const [a, b] = [rank(tint), rank(best)];
      const index = a.findIndex((value, i) => value !== b[i]);
      return index >= 0 && a[index] < b[index] ? tint : best;
    });
    if (!allowed.length) grid.add(id);
    tints.set(id, tint);
    usage.set(tint, usage.get(tint)! + 1);
    previous = tint;
  }
  return { tints, grid };
}

/** Each layer's paper by layer id, and each component's through the layer it is drawn in. 基础组件 gets none. */
export function architectureTints(snapshot: Snapshot): ArchitectureTints {
  const layers = getArchitectureLayers(snapshot).filter(layer => layer.id !== SHARED_SUPPORT_LAYER_ID);
  const layerOf = new Map(layers.flatMap(layer => layer.component_ids.map(id => [id, layer.id] as const)));
  // The overview's edges: component relations aggregated between the layers they cross.
  const relations = snapshot.graph.edges.flatMap(edge => {
    const [source, target] = [layerOf.get(edge.source), layerOf.get(edge.target)];
    return source && target && source !== target ? [[source, target] as const] : [];
  });
  const papers = assignLayerPapers(layers.map(layer => layer.id), relations);
  const byComponent = new Map<string, LayerTint>();
  const gridComponents = new Set<string>();
  for (const [componentId, layerId] of layerOf) {
    byComponent.set(componentId, papers.tints.get(layerId)!);
    if (papers.grid.has(layerId)) gridComponents.add(componentId);
  }
  return { byLayer: papers.tints, byComponent, gridLayers: papers.grid, gridComponents };
}
