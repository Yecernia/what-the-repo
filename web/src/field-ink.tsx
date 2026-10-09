import { Fragment, useId } from 'react';
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

/** Closed shapes inked as one, as `Ink` inks a single shape (paper, the colour nudged off, the line on top): all
 * the colour goes down first, then each shape's line except where it runs inside another shape, so where limbs join
 * or a hand grows out of an arm no line parts them. A line along another shape's edge keeps its full weight. */
export function InkUnion({ paths, width = 4.2, fill, paint, shift = PAINT_SHIFT, className, lineClip }: {
  paths: string[]; width?: number; fill?: string; paint: string; shift?: readonly [number, number]; className?: string;
  /** A clip (`url(#…)`) for the lines only, where something else already draws them. */
  lineClip?: string;
}) {
  const id = `ink-${useId().replace(/:/g, '')}`, stroke = width * .95;
  const box = { x: -400, y: -400, width: 1400, height: 1240 };
  return <g className={className}>
    {fill && paths.map((d, i) => <path key={i} d={d} fill={fill} />)}
    <g transform={`translate(${shift[0]} ${shift[1]})`}>{paths.map((d, i) => <path key={i} d={d} fill={paint} />)}</g>
    <g clipPath={lineClip}>{paths.map((d, i) => <Fragment key={i}>
      <mask id={`${id}-${i}`} maskUnits="userSpaceOnUse" {...box}>
        <rect {...box} fill="white" />
        {paths.map((other, j) => j !== i && <Fragment key={j}>
          <path d={other} fill="black" /><path d={other} fill="none" stroke="white" strokeWidth={stroke} />
        </Fragment>)}
      </mask>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" mask={`url(#${id}-${i})`} />
    </Fragment>)}</g>
  </g>;
}
