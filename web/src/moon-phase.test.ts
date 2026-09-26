import { describe, expect, it } from 'vitest';
import { litMoonPath, moonIllumination, moonPhase } from './moon-phase';

describe('moon phase', () => {
  it('matches known new and full moons to within a day', () => {
    // New moon 2026-09-11 03:27 UTC, full moon 2026-09-26 16:49 UTC.
    const day = 1 / 29.53;
    const newMoon = moonPhase(new Date('2026-09-11T03:27:00Z'));
    expect(Math.min(newMoon, 1 - newMoon)).toBeLessThan(day);
    expect(Math.abs(moonPhase(new Date('2026-09-26T16:49:00Z')) - .5)).toBeLessThan(day);
  });

  it('lights the right side while waxing and the left while waning, and nothing at new moon', () => {
    expect(litMoonPath(0, 0, 10, 0)).toBeNull();
    // The rim's sweep flag says which side is lit; at a quarter the terminator is a straight line.
    expect(litMoonPath(0, 0, 10, .25)).toMatch(/^M0 -10A10 10 0 0 1 0 10A0 10 /);
    expect(litMoonPath(0, 0, 10, .75)).toMatch(/^M0 -10A10 10 0 0 0 0 10A0 10 /);
    // Full: both arcs are the rim, so the whole disc is lit.
    expect(litMoonPath(0, 0, 10, .5)).toBe('M0 -10A10 10 0 0 0 0 10A10 10 0 0 0 0 -10Z');
    expect(moonIllumination(.5)).toBe(1);
  });
});
