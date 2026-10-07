import { describe, expect, it } from 'vitest';
import { assignLayerPapers } from './layer-tint';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `layer-${index}`);
const clique = (layers: string[]) => layers.flatMap((a, i) => layers.slice(i + 1).map(b => [a, b] as const));

// A dsh-like overview: 11 top-level layers, each talking to a handful of others through shared services.
const ELEVEN = ids(11);
const ELEVEN_RELATIONS = ([
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 4], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 8],
  [5, 6], [5, 9], [6, 7], [6, 10], [7, 10], [8, 9], [9, 10], [2, 9], [3, 5], [1, 10],
] as const).map(([a, b]) => [ELEVEN[a], ELEVEN[b]] as const);

// The gallery's dsh-like fixture (ui-gallery manyLayerSnapshot): Agent 运行时 is a hub with six related layers.
const DSH = ['cli', 'tui', 'session', 'scheduler', 'runtime', 'tools', 'sandbox', 'llm', 'store', 'config', 'telemetry'];
const DSH_RELATIONS = ([
  [0, 1], [0, 2], [0, 9], [1, 2], [1, 4], [2, 3], [2, 8], [3, 4], [3, 10], [4, 5], [4, 7],
  [4, 8], [5, 6], [5, 8], [6, 9], [7, 10], [8, 10], [9, 5], [9, 7], [2, 4], [1, 10],
] as const).map(([a, b]) => [DSH[a], DSH[b]] as const);
const neighbours = (layer: string, relations: ReadonlyArray<readonly [string, string]>) =>
  relations.flatMap(([a, b]) => a === layer ? [b] : b === layer ? [a] : []);
/** Same-colour pairs among the 相关 cards shown around `hub`, counted as cards minus distinct colours. */
const siblingRepeats = (hub: string, relations: ReadonlyArray<readonly [string, string]>, tints: Map<string, string>) => {
  const colours = neighbours(hub, relations).map(layer => tints.get(layer));
  return colours.length - new Set(colours).size;
};

describe('assignLayerPapers', () => {
  it('never gives related layers the same tint', () => {
    const { tints, grid } = assignLayerPapers(ELEVEN, ELEVEN_RELATIONS);
    for (const [a, b] of ELEVEN_RELATIONS) expect(tints.get(a), `${a} ~ ${b}`).not.toBe(tints.get(b));
    expect(grid.size).toBe(0);
    expect(tints.size).toBe(11);
  });

  it('is deterministic and ignores relation order and direction', () => {
    const first = assignLayerPapers(ELEVEN, ELEVEN_RELATIONS);
    const second = assignLayerPapers(ELEVEN, [...ELEVEN_RELATIONS].reverse().map(([a, b]) => [b, a] as const));
    expect([...second.tints]).toEqual([...first.tints]);
  });

  it('differs from the previous layer and spreads tints when nothing is related', () => {
    const { tints } = assignLayerPapers(ids(12), []);
    const sequence = ids(12).map(id => tints.get(id));
    sequence.slice(1).forEach((tint, index) => expect(tint).not.toBe(sequence[index]));
    expect(sequence.slice(0, 6)).toEqual(['green', 'blue', 'yellow', 'rose', 'lilac', 'teal']);
  });

  it('prefers a tint no sibling uses when one is free', () => {
    // L1, L3 and L6 all sit around L0; L2, L4 and L5 are unrelated and only even out the usage counts.
    const layers = ids(7);
    const relations = [[layers[0], layers[1]], [layers[0], layers[3]], [layers[0], layers[6]]] as const;
    const { tints } = assignLayerPapers(layers, relations);
    expect(siblingRepeats(layers[0], relations, tints)).toBe(0);
    expect(tints.get(layers[6])).toBe('yellow');
  });

  it('keeps sibling repeats around the dsh-like hub at the pigeonhole minimum', () => {
    const { tints, grid } = assignLayerPapers(DSH, DSH_RELATIONS);
    for (const [a, b] of DSH_RELATIONS) expect(tints.get(a)).not.toBe(tints.get(b));
    expect(grid.size).toBe(0);
    // Six related layers and five tints left after the hub's own: one repeat is unavoidable, and only one.
    expect(neighbours('runtime', DSH_RELATIONS)).toHaveLength(6);
    expect(siblingRepeats('runtime', DSH_RELATIONS, tints)).toBe(1);
    // Position-and-usage colouring without the sibling preference left 11 repeats across all hubs.
    const total = DSH.reduce((sum, hub) => sum + siblingRepeats(hub, DSH_RELATIONS, tints), 0);
    expect(total).toBeLessThan(11);
  });

  it('puts only the seventh layer of a 7-clique on grid paper', () => {
    const layers = ids(9);
    const { tints, grid } = assignLayerPapers(layers, [...clique(layers.slice(0, 7)), [layers[7], layers[8]]]);
    expect([...grid]).toEqual([layers[6]]);
    expect(new Set(layers.slice(0, 6).map(id => tints.get(id))).size).toBe(6);
    expect(tints.get(layers[7])).not.toBe(tints.get(layers[8]));
  });
});
