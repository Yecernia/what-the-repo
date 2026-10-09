import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldIllustration, FieldScene } from './FieldIllustration';

const AUTUMN = new Date(2026, 9, 15, 15);
const QIXI = new Date(2026, 7, 19, 22, 30);
const SUMMER = new Date(2026, 6, 15, 13);
const SPRING = new Date(2026, 3, 20, 13);
const WINTER = new Date(2027, 0, 12, 13);

describe('the friend in the bench scene', () => {
  it('is not there on an ordinary day', () => {
    const svg = render(<FieldScene at={AUTUMN} />).container.querySelector('svg')!;
    expect(svg.querySelector('.field-friend')).toBeNull();
    expect(svg.dataset.friend).toBeUndefined();
  });

  it('stands behind the bench and leans on it when flagged', () => {
    const svg = render(<FieldScene at={AUTUMN} friend />).container.querySelector('svg')!;
    expect(svg.dataset.friend).toBe('true');
    const parts = svg.querySelectorAll('.field-friend');
    expect(parts).toHaveLength(2);
    expect(svg.querySelector('.field-friend-head')).not.toBeNull();
    expect(svg.querySelector('.field-friend-thumb')).not.toBeNull();
  });

  it('dresses for winter with a scarf and a hat', () => {
    const plain = render(<FieldScene at={AUTUMN} friend />).container.querySelector('.field-friend')!;
    const winter = render(<FieldScene at={new Date(2027, 0, 12, 13)} friend />).container.querySelector('.field-friend')!;
    expect(winter.querySelectorAll('[fill="var(--paint-friend-scarf)"]').length).toBeGreaterThan(plain.querySelectorAll('[fill="var(--paint-friend-scarf)"]').length);
  });

  it('never appears in the desk figure', () => {
    const svg = render(<FieldIllustration compact pose="rest" friend at={AUTUMN} />).container.querySelector('svg')!;
    expect(svg.querySelector('.field-friend')).toBeNull();
  });

  it('keeps the Qixi magpie off the backrest the friend leans on', () => {
    const alone = render(<FieldScene at={QIXI} />).container;
    const together = render(<FieldScene at={QIXI} friend />).container;
    const start = (root: HTMLElement) => root.querySelector('.field-magpie-face')!.parentElement!.parentElement!.getAttribute('transform');
    expect(start(alone)).toBeNull();
    expect(start(together)).toMatch(/^translate\(/);
  });

  it('bares the arms below short sleeve caps in summer, each arm and its hand one shape with no ball of a hand', () => {
    const front = render(<FieldScene at={SUMMER} friend />).container.querySelectorAll('.field-friend')[1];
    // No round mitten: the left hand grows out of the bare forearm, and the fist is inked with its arm.
    expect(front.querySelector('circle')).toBeNull();
    expect(front.querySelector('.field-friend-thumb')).not.toBeNull();
    const skin = [...front.querySelectorAll('path[fill="var(--paint-skin)"]')].map(path => path.getAttribute('d')!);
    const halfWidths = skin.flatMap(d => [...d.matchAll(/A([\d.]+) /g)].map(match => Number(match[1])));
    expect(new Set(halfWidths)).toEqual(new Set([7]));
    // Every line of an arm is masked where it runs inside another part of it (upper arm, forearm, hand or fist): no
    // seam at the elbow or the wrist.
    expect(front.querySelectorAll('path[mask]')).toHaveLength(6);
    // The body is the same plain shape in every season (no arms in it); the hems cut the caps straight across.
    const [summer, autumn] = [SUMMER, AUTUMN].map(day => render(<FieldScene at={day} friend />).container.querySelector('.field-friend')!);
    const body = (root: Element) => root.querySelector('[fill="var(--paint-friend)"]')!.getAttribute('d');
    expect(body(summer)).toBe(body(autumn));
    expect(front.querySelectorAll('path[stroke="currentColor"]:not([mask]):not([fill="none"])').length).toBeGreaterThanOrEqual(2);
  });

  it('leans on the backrest with an elbow out at each side, the arms well apart', () => {
    for (const day of [SPRING, SUMMER, AUTUMN, WINTER]) {
      const front = render(<FieldScene at={day} friend />).container.querySelectorAll('.field-friend')[1];
      // Summer's bare arms are masked where their parts join; a long sleeve is one outline (its line).
      const lines = day === SUMMER ? [...front.querySelectorAll('path[mask]')] : [...front.querySelectorAll('.field-friend-sleeve > path:nth-child(2)')];
      const wave = front.querySelector('.field-friend-wave')!;
      const left = xs(lines.filter(path => !wave.contains(path))), right = xs(lines.filter(path => wave.contains(path)));
      // Out past the body (416 ± 33) on both sides, and the left hand ends well short of the right arm.
      expect(Math.min(...left)).toBeLessThan(416 - 50);
      expect(Math.max(...right)).toBeGreaterThan(416 + 50);
      expect(Math.min(...right) - Math.max(...left)).toBeGreaterThan(10);
    }
  });

  it('dresses the arms in cloth in the other seasons: loose sleeves with a bagged elbow, folds at the crook and a cuff', () => {
    const widths: number[] = [];
    for (const day of [SPRING, AUTUMN, WINTER]) {
      const front = render(<FieldScene at={day} friend />).container.querySelectorAll('.field-friend')[1];
      expect(front.querySelector('path[fill="var(--paint-skin)"]:not(.field-friend-thumb path)')).toBeNull();
      expect(front.querySelectorAll('circle[fill="var(--paint-skin)"]')).toHaveLength(1);
      const sleeves = [...front.querySelectorAll('.field-friend-sleeve')];
      expect(sleeves).toHaveLength(2);
      for (const sleeve of sleeves) {
        // The body's colour, one outline inked on top, at least one fold and a cuff band of its own.
        const [colour, line, ...rest] = [...sleeve.children];
        expect(colour.getAttribute('fill')).toBe('var(--paint-friend)');
        expect(line.getAttribute('stroke')).toBe('currentColor');
        expect(rest.filter(part => part.tagName === 'path' && part.getAttribute('stroke-width') === '2.4').length).toBeGreaterThan(0);
        expect(sleeve.querySelector(':scope > g > path[fill="var(--paint-friend)"]')).not.toBeNull();
        // The line starts and ends on the body's own line, with no seam cut away inside the shoulder.
        expect(sleeve.querySelector('[clip-path], [mask]')).toBeNull();
      }
      // Looser than the bare arm (half-width 7 at the elbow): the thumbs-up's upper arm and bagged elbow are well over
      // 14 across.
      const right = xs([sleeves[1].children[1]]);
      widths.push(Math.max(...right) - Math.min(...right));
      expect(widths.at(-1)).toBeGreaterThan(28);
    }
    // Winter's coat stands further off the arm than the sweater.
    expect(widths[2]).toBeGreaterThan(widths[1]);
  });

  it("softens the armpit into the body behind a long sleeve: the body's side is painted over above it", () => {
    for (const [day, patched] of [[SUMMER, false], [AUTUMN, true]] as const) {
      const behind = render(<FieldScene at={day} friend />).container.querySelector('.field-friend')!;
      expect(behind.querySelector(':scope > path[fill="var(--paint-friend)"]') !== null).toBe(patched);
    }
  });
});

/** Every x of a path's points (moves, lines, curves, arcs' ends). */
function xs(paths: Element[]) {
  return paths.flatMap(path => {
    const d = path.getAttribute('d')!;
    return [...d.matchAll(/([MLCA])([^MLCAZ]*)/g)].flatMap(([, command, args]) => {
      const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (command === 'A') return [n[5]];
      return n.filter((_, k) => k % 2 === 0);
    });
  });
}
