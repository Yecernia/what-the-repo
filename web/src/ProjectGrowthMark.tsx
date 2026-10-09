import { Ink } from './field-ink';
import { smoothPath, type PenPoint } from './pen-path';
import { projectGrowth, projectGrowthLabel, type ProjectGrowth } from './project-growth';
import type { TeachingPhase } from './types';

// Drawn on a 16px grid at real size. The flat colour is a copy nudged up and left, as in the field illustration.
const SHIFT: readonly [number, number] = [-.8, -.6];
const INK = 1.3;
const soil: PenPoint[] = [[3.2,14.2],[5.4,12.5],[8,12],[10.6,12.5],[12.8,14.2]];
const ground: PenPoint[] = [[2.2,14.3],[8,13.9],[13.8,14.3]];
const shapes: Record<ProjectGrowth, Array<{ points: PenPoint[]; paint?: string; closed?: boolean }>> = {
  seed: [{ points: [[4.5,10.5],[5.3,8],[7.8,6.7],[10.7,7],[11.7,9],[10.5,11.3],[7.4,11.9]], paint: 'var(--paint-growth-seed)', closed: true }],
  sprout: [
    { points: [[8,13.6],[8.1,10.6],[7.9,7.6]] },
    { points: [[7.9,9.4],[5.8,9.3],[3.7,7.6],[3.3,5.6],[5.6,5.9],[7.5,7.7]], paint: 'var(--paint-growth-leaf)', closed: true },
    { points: [[8.1,8.4],[8.9,5.7],[10.9,3.9],[13.2,3.5],[12.8,5.9],[10.7,7.8]], paint: 'var(--paint-growth-leaf)', closed: true },
  ],
  tree: [
    { points: [[7,13.6],[7.2,9.4],[8.8,9.4],[9,13.6]], paint: 'var(--paint-growth-seed)', closed: true },
    { points: [[8,1.4],[11.4,2.4],[12.8,5.6],[11.6,8.9],[8.2,10.2],[4.7,9.2],[3.2,6],[4.5,2.6]], paint: 'var(--paint-growth-crown)', closed: true },
  ],
};

/** A tiny plant before a project's title in the sidebar. The drawing is decorative; the state is spoken through
 * the label, which the project's open button also takes as its description. */
export function ProjectGrowthMark({ phase, id }: { phase: TeachingPhase | null | undefined; id?: string }) {
  const growth = projectGrowth(phase);
  const label = projectGrowthLabel(growth);
  return <span id={id} className="project-growth" data-growth={growth} data-tooltip={label}>
    <span className="project-growth-label">{label}</span>
    <svg viewBox="1 .8 14 14.4" aria-hidden="true" focusable="false">
      <path d={smoothPath(soil, true)} fill="var(--paint-growth-soil)" transform={`translate(${SHIFT[0]} ${SHIFT[1]})`} />
      <Ink points={ground} width={INK} />
      {shapes[growth].map((shape, index) => <Ink key={index} points={shape.points} closed={shape.closed} paint={shape.paint} width={INK} shift={SHIFT} />)}
    </svg>
  </span>;
}
