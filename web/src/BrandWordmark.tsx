import type { CSSProperties } from 'react';
import { smoothPath, type PenPoint } from './pen-path';

/** Letters drawn as single pen strokes, in the order a hand writes them (baseline 80, x-height 46).
 * A font only has outlines, so it cannot be written; these lines can, and they match the drawings above. */
const LETTERS: Record<string, { width: number; strokes: PenPoint[][] }> = {
  w: { width: 33, strokes: [[[0,46],[6,79],[16,54],[26,79],[33,46]]] },
  h: { width: 26, strokes: [[[3,14],[2,50],[2,80]], [[2,64],[8,50],[17,46],[24,53],[25,68],[25,80]]] },
  a: { width: 32, strokes: [[[26,55],[20,47],[11,46],[3,54],[1,67],[7,79],[17,79],[25,68]], [[27,46],[26,66],[28,77],[32,80]]] },
  t: { width: 21, strokes: [[[9,22],[9,50],[9,72],[13,80],[21,78]], [[0,46],[11,45],[21,45]]] },
  '-': { width: 20, strokes: [[[1,63],[11,62],[20,62]]] },
  e: { width: 28, strokes: [[[3,62],[15,63],[26,61],[25,51],[16,46],[6,49],[1,60],[3,73],[12,80],[22,79],[28,73]]] },
  r: { width: 23, strokes: [[[2,46],[2,63],[2,80]], [[2,62],[6,51],[14,46],[23,48]]] },
  p: { width: 27, strokes: [[[2,46],[2,78],[2,108]], [[2,56],[10,47],[21,47],[27,59],[25,73],[15,80],[3,76]]] },
  o: { width: 29, strokes: [[[16,46],[6,49],[1,62],[4,75],[14,81],[25,77],[29,64],[25,51],[15,46],[9,48]]] },
};
const NAME = 'what-the-repo';
const GAP = 7;
const START_MS = 600;
// A calm, steady hand: the pen moves along each stroke at an even pace (about 0.42 units per ms), and between
// strokes it travels through the air to the next start a little faster, so there are no fixed pauses and no
// letter pops out on its own. Each letter's pace wavers a few percent, as a real hand does.
const WRITE_SPEED = 0.42;
const AIR_SPEED = 1.1;
const AIR_MIN_MS = 25;
const WAVER = [1, .94, 1.05, .97, 1.03, .95, 1.02, .98, 1.06, .96, 1.01, .97, 1.04];

const length = (points: PenPoint[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);

/** Every stroke with its place and timing, worked out once. */
const STROKES = (() => {
  const out: Array<{ d: string; delay: number; duration: number }> = [];
  let x = 4, time = START_MS;
  let pen: PenPoint | null = null;
  [...NAME].forEach((char, index) => {
    const letter = LETTERS[char];
    for (const stroke of letter.strokes) {
      const points = stroke.map(([px, py]) => [px + x, py] as PenPoint);
      if (pen) time += AIR_MIN_MS + Math.hypot(points[0][0] - pen[0], points[0][1] - pen[1]) / AIR_SPEED;
      const duration = length(points) * 1.05 / (WRITE_SPEED * WAVER[index % WAVER.length]);
      out.push({ d: smoothPath(points, false), delay: time, duration });
      time += duration;
      pen = points[points.length - 1];
    }
    x += letter.width + GAP;
  });
  return { strokes: out, width: x - GAP + 4 };
})();

/** The product name, written once with the same heavy pen as the illustration: each stroke is drawn in order,
 * the pen moving on through the air to wherever the next stroke starts. */
export function BrandWordmark() {
  return (
    <svg className="brand-wordmark" viewBox={`0 0 ${STROKES.width} 118`} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={6.2} strokeLinecap="round" strokeLinejoin="round">
      {STROKES.strokes.map(({ d, delay, duration }) => (
        <path key={d} d={d} pathLength={1} className="brand-wordmark-stroke"
          style={{ animationDelay: `${Math.round(delay)}ms`, animationDuration: `${Math.round(duration)}ms` } as CSSProperties} />
      ))}
    </svg>
  );
}
