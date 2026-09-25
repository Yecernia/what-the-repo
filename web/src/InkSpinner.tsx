import { smoothPath, type PenPoint } from './pen-path';

// A slightly uneven closed loop, so the ink can chase itself round without a seam.
export const INK_LOOP = smoothPath([[8.2,2.5],[12.4,4.1],[13.6,8.3],[11.7,12.4],[7.6,13.6],[3.7,11.8],[2.4,7.6],[4.3,3.7]] as PenPoint[], true);

/** The waiting mark used wherever something loads: a stroke of ink that stretches and shrinks as it runs round a
 * hand-drawn loop. Each cycle ends exactly where the next begins, so it never jumps. */
export function InkSpinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return <svg className={`ink-spinner ${className}`.trim()} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"
    focusable="false" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <path d={INK_LOOP} pathLength={1} strokeWidth={1.7} />
  </svg>;
}
