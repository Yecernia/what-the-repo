/**
 * Today's moon, worked out on the device: the phase is the same everywhere at a given moment, so the viewer's own
 * clock is enough and nothing is fetched. A mean synodic month from a known new moon is off by well under a day,
 * which a small drawing cannot show.
 */
const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

/** Where the moon is in its cycle: 0 new, .25 first quarter, .5 full, .75 last quarter. */
export function moonPhase(at: Date = new Date()): number {
  const days = (at.getTime() - KNOWN_NEW_MOON) / 86_400_000;
  return ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS / SYNODIC_DAYS;
}

/** Share of the disc that is lit, from 0 (new) to 1 (full). */
export function moonIllumination(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * The lit part of a moon disc as seen from the northern hemisphere (it grows on the right). One half of the rim
 * plus the terminator, an ellipse whose width follows the phase. Null around new moon, when nothing is lit.
 */
export function litMoonPath(cx: number, cy: number, r: number, phase: number): string | null {
  if (moonIllumination(phase) < .02) return null;
  const waxing = phase < .5;
  const terminator = Math.abs(Math.cos(2 * Math.PI * phase)) * r;
  const gibbous = moonIllumination(phase) > .5;
  const top = `${round(cx)} ${round(cy - r)}`, bottom = `${round(cx)} ${round(cy + r)}`;
  // Rim from top to bottom on the lit side, then back up along the terminator: it bulges toward the lit side for a
  // crescent and away from it for a gibbous moon.
  const rimSweep = waxing ? 1 : 0;
  const terminatorSweep = gibbous ? rimSweep : 1 - rimSweep;
  return `M${top}A${round(r)} ${round(r)} 0 0 ${rimSweep} ${bottom}`
    + `A${round(terminator)} ${round(r)} 0 0 ${terminatorSweep} ${top}Z`;
}

function round(value: number) { return Math.round(value * 100) / 100; }
