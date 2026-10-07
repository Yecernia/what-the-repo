import { smoothPath, type PenPoint } from './pen-path';

/** How far flat colour sits off its line, up and to the left, like a hand-painted cel (drawing units). */
const PAINT_SHIFT: readonly [number, number] = [-2.4, -1.6];

/** One even pen line with round ends; a fill only where a shape must hide what is behind it.
 * The line is deliberately heavy, like a felt-tip drawing: weight, more than wobble, is what makes it read as hand-drawn.
 * A shape can also carry flat colour (`paint`), laid as in the promo film: the paper fill underneath still hides
 * what is behind, the colour is a copy nudged a little up and left (`shift`), and the ink line goes on top. */
export function Ink({ points, width = 4.2, closed = false, fill, color = 'currentColor', className, paint, shift = PAINT_SHIFT }: {
  points: PenPoint[]; width?: number; closed?: boolean; fill?: string; color?: string; className?: string;
  paint?: string; shift?: readonly [number, number];
}) {
  const d = smoothPath(points, closed);
  const line = { stroke: color, strokeWidth: width * .95, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (!paint) return <path className={className} d={d} fill={fill ?? 'none'} {...line} />;
  return <g className={className}>
    {fill && <path d={d} fill={fill} />}
    <path d={d} fill={paint} transform={`translate(${shift[0]} ${shift[1]})`} />
    <path d={d} fill="none" {...line} />
  </g>;
}
