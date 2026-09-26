import { smoothPath, type PenPoint } from './pen-path';

/** One even pen line with round ends; a fill only where a shape must hide what is behind it.
 * The line is deliberately heavy, like a felt-tip drawing: weight, more than wobble, is what makes it read as hand-drawn. */
export function Ink({ points, width = 4.2, closed = false, fill, color = 'currentColor', className }: {
  points: PenPoint[]; width?: number; closed?: boolean; fill?: string; color?: string; className?: string;
}) {
  return <path className={className} d={smoothPath(points, closed)} fill={fill ?? 'none'} stroke={color}
    strokeWidth={width * .95} strokeLinecap="round" strokeLinejoin="round" />;
}
