/**
 * The pen stroke drawn as a scrollbar thumb: a straight line with tapered tips of fixed size and an even middle,
 * laid out for the thumb's real length instead of stretching one drawing, so short thumbs keep the same tips.
 * Shared by the phone overlay bars, the settings sheet's rail and (through scripts/generate-scrollbar-art.mjs) the
 * desktop scrollbar images.
 */
export const SCROLL_INK_CAP = 14;
/** Length of the even middle piece the desktop image repeats between its two tips. */
export const SCROLL_INK_TILE = 16;

export function scrollInkPath(length: number, { width = 8, weight = 1.4 }: { width?: number; weight?: number } = {}): string {
  const total = Math.max(length, SCROLL_INK_CAP * 2);
  const center = width / 2;
  const samples: Array<{ y: number; half: number }> = [];
  // Only the tips curve; the straight middle needs no points of its own.
  for (let y = 1; y <= SCROLL_INK_CAP; y += 1) samples.push(sample(y));
  for (let y = Math.max(SCROLL_INK_CAP + 1, total - SCROLL_INK_CAP); y < total - 1; y += 1) samples.push(sample(y));
  samples.push(sample(total - 1));
  const left = samples.map(p => `${round(center - p.half)} ${round(p.y)}`);
  const right = samples.reverse().map(p => `${round(center + p.half)} ${round(p.y)}`);
  return `M${left.join('L')}L${right.join('L')}Z`;

  function sample(y: number) {
    // Pen pressure: thin at both tips, easing to full weight over the cap.
    const fromEnd = Math.min(y - 1, total - 1 - y);
    const taper = fromEnd >= SCROLL_INK_CAP - 1 ? 1 : .3 + .7 * Math.sin(Math.PI / 2 * fromEnd / (SCROLL_INK_CAP - 1));
    return { y, half: weight * taper };
  }
}

function round(value: number) { return Math.round(value * 100) / 100; }
