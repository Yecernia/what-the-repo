import { describe, expect, it } from 'vitest';
import { loginLawnPath, loginMeadowPath, type LawnFrame } from './login-lawn';
import type { PenPoint } from './pen-path';

const GROUND: PenPoint[] = [[101, 381], [270, 379], [508, 378.5]];
/** The on-curve points of the path's top edge: the start and each cubic segment's end, then the closing corners. */
function points(d: string): number[][] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const start = [numbers[0], numbers[1]];
  const rest: number[][] = [];
  for (const segment of d.slice(d.indexOf('C')).split(/(?=[CL])/)) {
    const values = (segment.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    rest.push(values.slice(-2));
  }
  return [start, ...rest];
}
/** Points along the path's curved top edge (its cubic segments), a few per segment. */
function samples(d: string): number[][] {
  const numbers = (d.slice(0, d.indexOf('L')).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: number[][] = [];
  for (let i = 2; i + 6 <= numbers.length; i += 6) {
    const [x0, y0] = [numbers[i - 2], numbers[i - 1]], [x1, y1, x2, y2, x3, y3] = numbers.slice(i, i + 6);
    for (let t = 0; t <= 1; t += .125) {
      const u = 1 - t;
      out.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
    }
  }
  return out;
}

describe('loginLawnPath', () => {
  const frame: LawnFrame = {
    page: { left: -400, top: -300, right: 1400, bottom: 900 },
    button: { left: 690, top: 330, right: 1060, bottom: 380 },
    dip: .3,
  };

  it('closes below the bottom edge of the page, reaching past its left edge', () => {
    const d = loginLawnPath(GROUND, frame);
    const all = points(d);
    expect(d.endsWith('Z')).toBe(true);
    expect(all[0][0]).toBeLessThan(frame.page.left);
    expect(Math.max(...all.map(([, y]) => y))).toBeGreaterThan(frame.page.bottom);
  });

  /** The same page composed for the lawn: the guest button stands low enough for the slope from the bench to reach it. */
  const composed: LawnFrame = { ...frame, button: { left: 690, top: 370, right: 1060, bottom: 420 } };

  it('runs along the scene ground and, on a page composed for it, falls through the lower part of the button', () => {
    const d = loginLawnPath(GROUND, composed);
    const top = points(d);
    for (const [x, y] of GROUND) expect(top).toContainEqual([x, y]);
    const inButton = samples(d).filter(([x]) => x >= 700 && x <= 1050);
    expect(inButton.length).toBeGreaterThan(0);
    for (const [, y] of inButton) {
      expect(y).toBeLessThan(420);
      expect(y).toBeGreaterThanOrEqual(420 - 50 / 2);
    }
    // Higher where it enters at the left than where it leaves at the right.
    expect(inButton[0][1]).toBeLessThan(inButton[inButton.length - 1][1] - 10);
  });

  it('has its highest point at the bench and only ever falls from there to the right', () => {
    for (const each of [frame, composed, { ...frame, dip: -.45 }, { ...frame, button: null }]) {
      const right = samples(loginLawnPath(GROUND, each)).filter(([x]) => x >= 508);
      expect(right.length).toBeGreaterThan(10);
      // Never rising by more than a hair (the smoothing just past the crest), so the eye reads it as falling.
      for (let i = 1; i < right.length; i++) expect(right[i][1]).toBeGreaterThanOrEqual(right[i - 1][1] - .05);
      expect(right[0][1]).toBeCloseTo(378.5, 1);
    }
  });

  it('passes under a button that stands above the slope instead of rising into it', () => {
    const inButton = samples(loginLawnPath(GROUND, frame)).filter(([x]) => x >= 690 && x <= 1060);
    expect(inButton.length).toBeGreaterThan(0);
    for (const [, y] of inButton) expect(y).toBeGreaterThan(380);
  });

  it('falls gently off the left edge of the page', () => {
    const top = points(loginLawnPath(GROUND, frame));
    const left = top[0], ground = GROUND[0];
    const slope = (left[1] - ground[1]) / (ground[0] - left[0]);
    expect(slope).toBeGreaterThanOrEqual(0);
    expect(slope).toBeLessThanOrEqual(.12);
  });

  it('rounds off past the button into a shoulder that leaves the page bottom before its right edge', () => {
    // A landscape window, as wide as the one above but shorter.
    const frame: LawnFrame = { page: { left: -400, top: -300, right: 1400, bottom: 750 }, button: { left: 690, top: 330, right: 1060, bottom: 380 }, dip: .3 };
    const top = points(loginLawnPath(GROUND, frame));
    const shoulder = top.slice(0, -2).filter(([x]) => x > 1060);
    // Falling all the way, ever more steeply: a round hillside, not a cliff or a ramp.
    for (let i = 1; i < shoulder.length; i++) expect(shoulder[i][1]).toBeGreaterThan(shoulder[i - 1][1]);
    const slopes = shoulder.slice(1).map(([x, y], i) => (y - shoulder[i][1]) / Math.max(x - shoulder[i][0], 1e-6));
    for (let i = 1; i < slopes.length; i++) expect(slopes[i]).toBeGreaterThan(slopes[i - 1]);
    // Where its flank crosses the page bottom: inside the page, between three quarters of the width and the edge.
    const below = shoulder.findIndex(([, y]) => y >= frame.page.bottom);
    const [x0, y0] = shoulder[below - 1], [x1, y1] = shoulder[below];
    const cross = x0 + (x1 - x0) * (frame.page.bottom - y0) / (y1 - y0);
    const width = frame.page.right - frame.page.left;
    expect(cross).toBeGreaterThan(frame.page.left + width * .75);
    expect(cross).toBeLessThan(frame.page.right);
    // The hill closes straight down from its foot, below the page, so it covers nothing past its flank.
    expect(top[top.length - 2][0]).toBe(shoulder[shoulder.length - 1][0]);
  });

  it('lays a low far meadow across the whole page behind the hill', () => {
    const d = loginMeadowPath(frame);
    const all = points(d);
    expect(d.endsWith('Z')).toBe(true);
    expect(all[0][0]).toBeLessThan(frame.page.left);
    expect(Math.max(...all.map(([x]) => x))).toBeGreaterThan(frame.page.right);
    const height = frame.page.bottom - frame.page.top;
    const crest = all.filter(([, y]) => y < frame.page.bottom);
    for (const [, y] of crest) {
      expect(frame.page.bottom - y).toBeGreaterThan(height * .05);
      expect(frame.page.bottom - y).toBeLessThanOrEqual(height * .16);
    }
    // Highest at the right edge, where it shows past the hill, between 10% and 16% of the page.
    const right = crest[crest.length - 1];
    expect(frame.page.bottom - right[1]).toBeGreaterThanOrEqual(height * .1);
  });

  it('passes under the GitHub button when there is no guest button', () => {
    const top = points(loginLawnPath(GROUND, { ...frame, dip: -.45 }));
    for (const [, y] of top.filter(([x]) => x >= 690 && x <= 1060)) expect(y).toBeGreaterThan(380);
  });

  it('keeps to the scene ground when no button stands beside it', () => {
    const d = loginLawnPath(GROUND, { ...frame, button: null });
    expect(points(d)).toContainEqual([508, 378.5]);
    expect(d).not.toContain('NaN');
  });
});
