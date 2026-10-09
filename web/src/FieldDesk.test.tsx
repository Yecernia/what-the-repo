import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldIllustration, type FieldCue, type FieldMotionHandle } from './FieldIllustration';
import { ARMS_UP, FRONT_FADE_MS, handAt, HEART_SEEN_KEY, idleSteps } from './field-motion';

// jsdom has no Web Animations: a stand-in whose animations finish after their duration (on fake timers), so the
// figure's controller runs its moves and the test can see which elements were animated. While an animation is live
// (until cancelled) the computed opacity and transform of its element follow its keyframes (linearly, easing aside),
// as a browser's would, so a move cut short reads the parts where they are.
const animated: Element[] = [];
interface Stand { frames: Keyframe[]; duration: number; start: number; endless: boolean; live: boolean }
const live = new Map<Element, Stand[]>();
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g;
function mix(a: string, b: string, t: number) {
  const x = a.match(NUMBER) ?? [], y = b.match(NUMBER) ?? [];
  if (x.length !== y.length) return t < 1 ? a : b;
  let i = 0;
  return a.replace(NUMBER, () => { const value = Number(x[i]) + (Number(y[i]) - Number(x[i])) * t; i++; return String(value); });
}
function sample(stand: Stand, property: 'opacity' | 'transform'): string | undefined {
  const keyed = stand.frames.map((frame, i, all) => [frame.offset ?? (i === 0 ? 0 : i === all.length - 1 ? 1 : i / (all.length - 1)), frame[property]] as const)
    .filter((pair): pair is readonly [number, string | number] => pair[1] !== undefined && pair[1] !== null);
  if (!keyed.length) return undefined;
  const elapsed = (Date.now() - stand.start) / (stand.duration || 1);
  const p = stand.endless ? elapsed % 1 : Math.min(elapsed, 1);
  let k = 0;
  while (k < keyed.length - 1 && keyed[k + 1][0] <= p) k++;
  if (k === keyed.length - 1) return String(keyed[k][1]);
  const [a, from] = keyed[k], [b, to] = keyed[k + 1];
  return mix(String(from), String(to), b > a ? (p - a) / (b - a) : 1);
}
/** What a browser would compute for an element's opacity or transform this moment (the transform as a matrix). */
function seen(el: Element, property: 'opacity' | 'transform'): string {
  let value: string | undefined;
  for (const stand of live.get(el) ?? []) if (stand.live) value = sample(stand, property) ?? value;
  const inline = (el as SVGElement).style[property];
  if (value === undefined) value = inline || (property === 'opacity' ? (el.matches('.field-held-cup, .field-front, .field-puff') ? '0' : '1') : 'none');
  if (property === 'opacity') return value;
  const m = /^translate\((\S+)px, (\S+)px\) rotate\((\S+)deg\) scale\((\S+), (\S+)\)$/.exec(value);
  if (!m) return value;
  const [x, y, r, sx, sy] = m.slice(1).map(Number), a = r * Math.PI / 180;
  return `matrix(${Math.cos(a) * sx}, ${Math.sin(a) * sx}, ${-Math.sin(a) * sy}, ${Math.cos(a) * sy}, ${x}, ${y})`;
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  animated.length = 0;
  live.clear();
  Element.prototype.animate = function animate(this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    animated.push(this);
    const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0);
    const endless = typeof options === 'object' && options.iterations === Infinity;
    const stand: Stand = { frames: Array.isArray(frames) ? frames : [], duration, start: Date.now(), endless, live: true };
    live.set(this, [...live.get(this) ?? [], stand]);
    let settle = () => {};
    const finished = new Promise<void>(resolve => { settle = resolve; });
    const timer = endless ? undefined : setTimeout(() => { animation.playState = 'finished'; settle(); }, duration);
    const animation = {
      playState: 'running', finished, playbackRate: 1, pause() {}, play() {},
      cancel() { clearTimeout(timer); stand.live = false; },
    };
    return animation as unknown as Animation;
  } as typeof Element.prototype.animate;
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => new Proxy(real(el, pseudo), {
    get(style, key) {
      if (key === 'opacity' || key === 'transform') return seen(el, key);
      const value = Reflect.get(style, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(style) : value;
    },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
});

const hearts = () => animated.filter(el => el.classList.contains('field-heart')).length;
const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it('greets with a heart the first time our project is shown, and never in the middle of idling', async () => {
  const view = render(<FieldIllustration compact ownRepository pose="rest" />);
  await later(3000);
  expect(hearts()).toBe(1);
  expect(localStorage.getItem(HEART_SEEN_KEY)).toBe('1');
  // Sitting and idling for minutes, re-rendered now and then: no other heart.
  for (let i = 0; i < 6; i++) {
    view.rerender(<FieldIllustration compact ownRepository pose="rest" />);
    await later(30_000);
  }
  expect(hearts()).toBe(1);
  expect(animated.length).toBeGreaterThan(20);
});

it('plays the heart at a later opening only when the roll says so', async () => {
  localStorage.setItem(HEART_SEEN_KEY, '1');
  const random = vi.spyOn(Math, 'random').mockReturnValue(.9);
  const view = render(<FieldIllustration compact ownRepository pose="rest" />);
  await later(3000);
  expect(hearts()).toBe(0);
  // The analysis starts for it: another opening, this time with a lucky roll.
  random.mockReturnValue(.1);
  view.rerender(<FieldIllustration compact ownRepository pose="waiting" />);
  await later(3000);
  expect(hearts()).toBe(1);
  // The analysis ends: not an opening.
  view.rerender(<FieldIllustration compact ownRepository pose="rest" />);
  await later(10_000);
  expect(hearts()).toBe(1);
});

it('never plays the heart for another project', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const view = render(<FieldIllustration compact pose="rest" />);
  view.rerender(<FieldIllustration compact pose="waiting" />);
  await later(60_000);
  expect(hearts()).toBe(0);
});

// Midday and late evening in each season (avoiding festivals).
const SEASON_DAYS = { spring: [2027, 3, 20], summer: [2027, 6, 15], autumn: [2026, 9, 20], winter: [2027, 0, 12] } as const;
const deskAt = (season: keyof typeof SEASON_DAYS, hour: number) => {
  const [year, month, day] = SEASON_DAYS[season];
  return render(<FieldIllustration compact pose="rest" at={new Date(year, month, day, hour)} />).container.querySelector('svg')!;
};

it('stands the season\'s drink beside the laptop: iced in summer, tea steaming all day in winter and only after dark in spring and autumn', () => {
  const summer = deskAt('summer', 13), cup = summer.querySelector('.field-desk-cup')!;
  expect(cup.querySelector('path[stroke="var(--paint-straw-stripe)"]')).not.toBeNull();
  expect(cup.querySelector('path[fill="var(--paint-drink)"]')).not.toBeNull();
  expect(cup.querySelector('.field-steam')).toBeNull();

  const winter = deskAt('winter', 13).querySelector('.field-desk-cup .field-steam')!;
  expect(winter).not.toBeNull();
  expect(winter.classList.contains('field-night-only')).toBe(false);

  for (const season of ['spring', 'autumn'] as const) {
    const day = deskAt(season, 13), night = deskAt(season, 22);
    expect(day.querySelector('.field-desk-cup .field-steam')!.classList.contains('field-night-only')).toBe(true);
    // The mug has a clay glaze of its own, apart from the cream face it is lifted to.
    expect(day.querySelector('.field-desk-cup path[fill="var(--paint-mug)"]')).not.toBeNull();
    // The stylesheet shows night-only steam on a desk drawn at night (and always in the dark theme).
    expect(day.hasAttribute('data-night')).toBe(false);
    expect(night.hasAttribute('data-night')).toBe(true);
  }
  // The copy of the cup that the hand lifts is the same drink, hidden until then.
  for (const season of ['summer', 'winter'] as const) {
    const svg = deskAt(season, 13);
    expect(svg.querySelector('.field-front-r .field-held-cup .field-cup > g')!.innerHTML).toBe(svg.querySelector('.field-desk-cup')!.innerHTML);
  }
});

it('tints the halo behind the figure with the analysis state, on the same discs so the colour can ease across', () => {
  const view = render(<FieldIllustration compact pose="waiting" />);
  const discs = [...view.container.querySelectorAll('.field-desk-halo')];
  const fills = () => [...view.container.querySelectorAll('.field-desk-halo')].map(el => el.getAttribute('fill'));
  expect(fills()).toEqual(['var(--paint-halo-waiting-outer)', 'var(--paint-halo-waiting)']);
  view.rerender(<FieldIllustration compact pose="puzzled" />);
  expect(fills()).toEqual(['var(--paint-halo-puzzled-outer)', 'var(--paint-halo-puzzled)']);
  // Done is the warm glow the halo always had (the night one in the dark theme).
  view.rerender(<FieldIllustration compact pose="rest" />);
  expect(fills()).toEqual(['var(--paint-halo-outer)', 'var(--paint-halo)']);
  expect([...view.container.querySelectorAll('.field-desk-halo')]).toEqual(discs);
  view.unmount();
});

it('bares the arms below loose short sleeves in summer, each ending in its own rounded hand, and keeps the other seasons\' sleeves as they were', () => {
  // Half a limb's width: how far the first point of its outline lies from its axis.
  const half = (path: Element, [ax, ay]: number[], [bx, by]: number[]) => {
    const [x, y] = path.getAttribute('d')!.match(NUMBER)!.slice(0, 2).map(Number);
    return Math.round(Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / Math.hypot(bx - ax, by - ay) * 10) / 10;
  };
  const SHOULDER = [97, 72], ELBOW = [70, 42], WRIST = [101, 38];
  const widths = (paths: Element[], a: number[], b: number[]) => [...new Set(paths.map(path => half(path, a, b)))].sort((p, q) => p - q);
  const uppers = (svg: SVGSVGElement, selector: string) => [...svg.querySelectorAll(`.field-upper-l:not(.field-front) > ${selector}`)];
  const strokes = (svg: SVGSVGElement, paint: string) => [...svg.querySelectorAll(`.field-heart-arms path[stroke="${paint}"]`)]
    .map(path => Number(path.getAttribute('stroke-width')));

  const summer = deskAt('summer', 13);
  // A loose short sleeve (shirt colour), well wider than the bare arm below its hem, which is drawn in the face's colour.
  expect(widths(uppers(summer, 'path'), SHOULDER, ELBOW)).toEqual([4, 7.5]);
  expect(widths(uppers(summer, 'path[fill="var(--paint-skin)"]'), SHOULDER, ELBOW)).toEqual([4]);
  expect(widths(uppers(summer, 'path:not([fill])'), SHOULDER, ELBOW)).toContain(7.5);
  // The forearm is as wide, outline and front copies alike (so the hand never changes layers visibly).
  const forearms = [...summer.querySelectorAll('.field-fore-l .field-forearm')];
  expect(widths(forearms, ELBOW, WRIST)).toEqual([4]);
  expect(forearms.filter(path => path.hasAttribute('fill')).every(path => path.getAttribute('fill') === 'var(--paint-skin)')).toBe(true);
  expect(summer.querySelector('.field-cuff')).toBeNull();
  // Its hand is no separate round mitten but the arm's own tip, a little wider, drawn in the same two passes: an
  // outline beside every forearm outline and a filling of the same colour beside every forearm filling.
  expect(summer.querySelector('circle.field-hand, .field-hand circle, .field-heart-mitten')).toBeNull();
  for (const fore of summer.querySelectorAll('.field-fore-l')) {
    const [arm, hand] = [fore.querySelector('.field-forearm')!, fore.querySelector('.field-hand')!];
    expect(hand.tagName).toBe('path');
    expect(hand.getAttribute('fill')).toBe(arm.getAttribute('fill'));
    // How far the outline reaches from the forearm's axis.
    const span = (path: Element) => Math.max(...path.getAttribute('d')!.match(NUMBER)!.map(Number).reduce<number[][]>((points, value, i) =>
      i % 2 ? (points[points.length - 1].push(value), points) : [...points, [value]], []).map(([x, y]) =>
      Math.abs((WRIST[0] - ELBOW[0]) * (y - ELBOW[1]) - (WRIST[1] - ELBOW[1]) * (x - ELBOW[0])) / Math.hypot(WRIST[0] - ELBOW[0], WRIST[1] - ELBOW[1])));
    // Half as wide again as the arm's 4 at most: a rounded tip, not a ball.
    expect(span(hand)).toBeGreaterThan(5);
    expect(span(hand)).toBeLessThan(6);
  }
  // The heart's arms the same: sleeves at the jointed sleeve's width, bare parts at the bare arm's, each with its line,
  // and the two hands drawn with them, outline and filling.
  expect(Math.max(...strokes(summer, 'var(--paint-skin)'))).toBe(8);
  expect(strokes(summer, 'var(--paint-sweater)')).toEqual([15, 15]);
  expect([...new Set(strokes(summer, 'currentColor'))].sort((p, q) => p - q)).toEqual([6.6, 14.6, 21.6]);
  expect(summer.querySelectorAll('.field-heart-arms .field-heart-hand path[fill="var(--paint-skin)"]')).toHaveLength(2);
  expect(summer.querySelectorAll('.field-heart-arms .field-heart-hand path[stroke="currentColor"]')).toHaveLength(2);

  for (const season of ['spring', 'autumn', 'winter'] as const) {
    const svg = deskAt(season, 13);
    expect(widths(uppers(svg, 'path'), SHOULDER, ELBOW)).toEqual([5.5]);
    expect(widths([...svg.querySelectorAll('.field-fore-l .field-forearm')], ELBOW, WRIST)).toEqual([5]);
    expect(svg.querySelectorAll('.field-upper-l [fill="var(--paint-skin)"]:not(circle)')).toHaveLength(0);
    expect(svg.querySelector('.field-cuff')).not.toBeNull();
    // The heart's arms as wide as the jointed ones (upper arms 11, forearms 10, with their lines), and the cuffs.
    expect([...new Set(strokes(svg, 'var(--paint-sweater)'))].sort((p, q) => p - q)).toEqual([10, 11]);
    expect([...new Set(strokes(svg, 'currentColor'))].sort((p, q) => p - q)).toEqual([6.6, 16.6, 17.6]);
    expect(strokes(svg, 'var(--paint-skin)')).toHaveLength(0);
  }
});

it('moves the arms of the drawing it shows after the season changes (summer draws other arms), without greeting again', async () => {
  const handle: { current: FieldMotionHandle | null } = { current: null };
  const view = render(<FieldIllustration compact ownRepository pose="rest" at={new Date(2027, 0, 12, 13)} motionRef={handle} />);
  await later(9000);
  expect(hearts()).toBe(1);
  view.rerender(<FieldIllustration compact ownRepository pose="rest" at={new Date(2027, 6, 15, 13)} motionRef={handle} />);
  await later(500);
  animated.length = 0;
  act(() => handle.current!.play('stretch'));
  const svg = view.container.querySelector('svg')!;
  // Every jointed arm part in the summer drawing moves (none is left behind the lid with only its sleeve showing).
  for (const part of ['upper-l', 'fore-l', 'upper-r', 'fore-r']) {
    const els = [...svg.querySelectorAll(`.field-${part}:not(.field-front *):not(.field-front)`)];
    expect(els.length).toBeGreaterThan(1);
    expect(els.every(el => animated.includes(el))).toBe(true);
  }
  // No second heart for the new drawing.
  await later(20_000);
  expect(hearts()).toBe(0);
});

it('takes a sip and puts the cup back on the desk', async () => {
  localStorage.setItem(HEART_SEEN_KEY, '1');
  const handle: { current: FieldMotionHandle | null } = { current: null };
  const view = render(<FieldIllustration compact pose="rest" at={new Date(2027, 0, 12, 13)} motionRef={handle} />);
  await later(500);
  animated.length = 0;
  act(() => handle.current!.play('drink'));
  expect(animated.some(el => el.classList.contains('field-held-cup'))).toBe(true);
  expect(animated.some(el => el.classList.contains('field-desk-cup'))).toBe(true);
  await later(7000);
  const svg = view.container.querySelector('svg')!;
  expect((svg.querySelector('.field-held-cup') as SVGElement).style.opacity).toBe('');
  expect((svg.querySelector('.field-desk-cup') as SVGElement).style.opacity).toBe('');
});

describe('a sip cut short', () => {
  type Pose = 'rest' | 'waiting';
  type Run = Awaited<ReturnType<typeof cutShort>>;
  const WINTER = new Date(2027, 0, 12, 13), SUMMER = new Date(2027, 6, 15, 13);
  const turn = (el: Element) => {
    const m = /matrix\(([^)]+)\)/.exec(seen(el, 'transform'));
    if (!m) return { r: 0, s: 1 };
    const [a, b] = m[1].split(',').map(Number);
    return { r: Math.atan2(b, a) * 180 / Math.PI, s: Math.hypot(a, b) };
  };
  const near = (deg: number, to: number) => Math.abs(((deg - to) % 360 + 540) % 360 - 180) < .6;

  /** Renders the figure, starts a sip, cuts it short at `cut` ms with `trigger`, and follows every 20 ms what shows
   * until the figure sits still again, checking the cup, its steam and the drinking arm frame by frame. */
  async function cutShort({ pose = 'rest', at = WINTER, cut, trigger }: {
    pose?: Pose; at?: Date; cut: number;
    trigger: (tools: { rerender: (props: { pose?: Pose; draft?: string }) => void; play: (cue: FieldCue) => void; svg: SVGSVGElement }) => void;
  }) {
    localStorage.setItem(HEART_SEEN_KEY, '1');
    vi.spyOn(Math, 'random').mockReturnValue(.5);
    const handle: { current: FieldMotionHandle | null } = { current: null };
    const view = render(<FieldIllustration compact pose={pose} at={at} motionRef={handle} />);
    const svg = view.container.querySelector('svg')!;
    const held = svg.querySelector('.field-held-cup')!, desk = svg.querySelector('.field-desk-cup')!;
    const steam = svg.querySelector('.field-held-cup .field-steam');
    const upper = svg.querySelector('.field-upper-r:not(.field-front)')!, fore = upper.querySelector('.field-fore-r')!;
    const shows = (el: Element) => Number(seen(el, 'opacity')) > .5;
    await later(pose === 'rest' ? 500 : 2500);
    act(() => handle.current!.play('drink'));
    const log: Array<{ t: number; held: boolean; desk: boolean }> = [];
    let t = 0;
    const watch = async (until: number) => {
      for (; t < until; t += 20) {
        await later(20);
        const record = { t, held: shows(held), desk: shows(desk) };
        log.push(record);
        // The cup is always somewhere: on the desk, in the hand, or for a moment both, in the gripping pose, where
        // the two copies lie on each other.
        expect(record.held || record.desk).toBe(true);
        if (record.held && record.desk) {
          expect(near(turn(upper).r, 103.8) && near(turn(fore).r, 81.6)).toBe(true);
          // The see-through steam is never drawn twice.
          if (steam) expect(Number(seen(steam, 'opacity'))).toBeLessThan(.01);
        }
        // The upper arm is drawn shorter only while the cup is in the hand.
        if (Math.abs(turn(upper).s - 1) > 1e-3) expect(record.held).toBe(true);
      }
    };
    await watch(cut);
    const heldAtCut = shows(held);
    act(() => trigger({
      rerender: props => view.rerender(<FieldIllustration compact pose={props.pose ?? pose} at={at} draft={props.draft} motionRef={handle} />),
      play: cue => handle.current!.play(cue), svg,
    }));
    const moving = () => [...live.values()].some(stands => stands.some(stand => stand.live && !stand.endless));
    // On until the figure sits still again: every move done, the chair settled.
    const cutAt = t;
    for (let guard = 0; guard < 60 && (t === cutAt || moving()); guard++) await watch(t + 200);
    expect(moving()).toBe(false);
    return { svg, handle, log, heldAtCut, cutAt, watch, upper, view, now: () => t };
  }

  /** Still after the move: the cup on the desk and only there, every part drawn, the arm at its length. */
  const settled = (svg: SVGSVGElement) => {
    expect((svg.querySelector('.field-held-cup') as SVGElement).style.opacity).toBe('');
    expect((svg.querySelector('.field-desk-cup') as SVGElement).style.opacity).toBe('');
    for (const el of svg.querySelectorAll<SVGElement>('.field-fore-l, .field-fore-r, .field-front')) expect(el.style.opacity).toBe('');
    for (const el of svg.querySelectorAll<SVGElement>('.field-upper-r, .field-fore-r')) expect(el.style.transform).toContain('scale(1, 1)');
  };
  const lands = (log: Run['log']) => log.filter((record, i) => i > 0 && log[i - 1].held && !record.held).length;
  const takes = (log: Run['log']) => log.filter((record, i) => i > 0 && !log[i - 1].held && record.held).length;
  /** After the cut the cup went down onto the desk exactly once (or never left it) and was not taken up again. */
  const landedOnce = ({ log, heldAtCut, cutAt }: Run) => {
    const after = log.filter(record => record.t >= cutAt - 20);
    expect(lands(after)).toBe(heldAtCut ? 1 : 0);
    expect(takes(after)).toBe(0);
    expect(after[after.length - 1]).toMatchObject({ held: false, desk: true });
  };
  /** The next sip goes as any other: the cup taken once and set down once. */
  const nextSip = async (run: Run) => {
    const from = run.log.length;
    act(() => run.handle.current!.play('drink'));
    await run.watch(run.now() + 9000);
    const log = run.log.slice(from);
    expect([takes(log), lands(log)]).toEqual([1, 1]);
    settled(run.svg);
  };

  // The moments of a sip (ms from its start, with Math.random at .5): the forearm turning over behind the lid, the
  // hand gripping the cup, the cup at the mouth, and the cup on its way down.
  const moments = (pose: Pose, drink: 'hot' | 'iced' = 'hot') => {
    const steps = idleSteps('drink', pose, () => .5, drink), [[take], [give]] = steps.cup, ms = (at: number) => Math.round(at * steps.ms);
    const atMouth = steps.find(step => step.at > take && step.at < give && (step.parts.head?.y ?? 0) < 0)?.at ?? (take + give) / 2;
    return { ...(pose === 'rest' && { turning: ms(steps[0].at / 2) }), gripping: ms(take) + 60, atMouth: ms(atMouth) + 100, lowering: ms(give) - 120 };
  };

  it('an analysis starting puts the cup back on the desk once, at any moment of the sip', async () => {
    for (const [moment, cut] of Object.entries(moments('rest'))) {
      const run = await cutShort({ cut, trigger: ({ rerender }) => rerender({ pose: 'waiting' }) });
      expect(run.heldAtCut).toBe(moment !== 'turning');
      landedOnce(run);
      settled(run.svg);
      expect(run.svg.classList.contains('field-waiting')).toBe(true);
      await nextSip(run);
      run.view.unmount();
    }
  });

  it('an analysis ending puts the cup back on the desk once and the hand on the keyboard', async () => {
    for (const cut of Object.values(moments('waiting'))) {
      const run = await cutShort({ pose: 'waiting', cut, trigger: ({ rerender }) => rerender({ pose: 'rest' }) });
      landedOnce(run);
      settled(run.svg);
      expect(near(turn(run.upper).r, 120)).toBe(true);
      await nextSip(run);
      run.view.unmount();
    }
  });

  it('a wave on hover puts the cup back on the desk once first', async () => {
    for (const cut of Object.values(moments('rest', 'iced'))) {
      const run = await cutShort({ at: SUMMER, cut, trigger: ({ svg }) => {
        svg.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
      } });
      landedOnce(run);
      settled(run.svg);
      await nextSip(run);
      run.view.unmount();
    }
  });

  it('a question in the composer pulls the chair in only once the cup is down, and the cup then stays there', async () => {
    for (const cut of Object.values(moments('rest'))) {
      const run = await cutShort({ cut, trigger: ({ rerender }) => rerender({ draft: 'How is this deployed?' }) });
      // The sip is not cut short: it goes on to its end, the cup taken and set down once, and only then does the chair
      // come in.
      expect([takes(run.log), lands(run.log)]).toEqual([1, 1]);
      const landed = run.log.findIndex((record, i) => i > 0 && run.log[i - 1].held && !record.held);
      const pull = run.svg.querySelector('.field-pull') as SVGElement;
      expect(animated.indexOf(pull)).toBeGreaterThanOrEqual(0);
      expect(pull.style.transform).toBe('scale(1.09, 1.09)');
      settled(run.svg);
      expect(landed).toBeGreaterThan(0);
      // Pulled in, the cup stays on the desk.
      animated.length = 0;
      act(() => run.handle.current!.play('drink'));
      expect(animated.some(el => el.classList.contains('field-held-cup'))).toBe(false);
      run.view.unmount();
    }
  });

  it('the gallery\'s buttons take over from a sip at any moment', async () => {
    for (const cue of ['stretch', 'chin', 'wave', 'heart', 'drink'] as const) {
      for (const cut of Object.values(moments('rest'))) {
        const run = await cutShort({ cut, trigger: ({ play }) => play(cue) });
        // Another sip starts from wherever the hand is; anything else first puts the cup back on the desk.
        if (cue !== 'drink') landedOnce(run);
        else expect(run.log[run.log.length - 1]).toMatchObject({ held: false, desk: true });
        settled(run.svg);
        await nextSip(run);
        run.view.unmount();
      }
    }
  });
});

describe('layer switches: a part changes layers only where both drawings look the same', () => {
  const WINTER = new Date(2027, 0, 12, 13);
  type Log = Array<{ t: number; front: number; held: number; desk: number }>;
  /** Plays `cue` and follows, every millisecond over each window (ms from its start), how much of a hand's front copy,
   * the cup in the hand and the desk cup shows. */
  async function follow(pose: 'rest' | 'waiting', cue: FieldCue, windows: Array<[number, number]>, side: 'l' | 'r' = 'r') {
    localStorage.setItem(HEART_SEEN_KEY, '1');
    vi.spyOn(Math, 'random').mockReturnValue(.5);
    const handle: { current: FieldMotionHandle | null } = { current: null };
    const view = render(<FieldIllustration compact pose={pose} at={WINTER} motionRef={handle} />);
    const svg = view.container.querySelector('svg')!;
    const [front, held, desk] = [`.field-front-${side}`, '.field-held-cup', '.field-desk-cup'].map(selector => svg.querySelector(selector)!);
    await later(pose === 'rest' ? 500 : 2500);
    act(() => handle.current!.play(cue));
    const log: Log = [];
    let t = 0;
    for (const [from, to] of windows) {
      await later(from - t);
      for (t = from; t <= to; t++) {
        log.push({ t, front: Number(seen(front, 'opacity')), held: Number(seen(held, 'opacity')), desk: Number(seen(desk, 'opacity')) });
        await later(1);
      }
    }
    view.unmount();
    return log;
  }
  /** How long (ms) each fade of the front copy in the log takes, from its last steady moment to its next. */
  const fades = (log: Log) => {
    const out: number[] = [], steady = (front: number) => front === 0 || front === 1;
    for (let i = 1; i < log.length; i++) {
      if (!steady(log[i - 1].front) || log[i].front === log[i - 1].front) continue;
      let k = i;
      while (k < log.length && !steady(log[k].front)) k++;
      out.push(log[k].t - log[i - 1].t);
      i = k;
    }
    return out;
  };
  const sip = (pose: 'rest' | 'waiting') => {
    const steps = idleSteps('drink', pose, () => .5), [[take], [give]] = steps.cup, ms = (at: number) => Math.round(at * steps.ms);
    return { ms: steps.ms, windows: [[ms(take) - 20, ms(take) + 120], [ms(give) - 20, ms(give) + 120]] as Array<[number, number]> };
  };

  it('fades a front copy in and out over a few frames, however long the move', async () => {
    // A sip of six seconds and more, and the chin held twenty seconds and more: the fade is the same short one.
    for (const pose of ['rest', 'waiting'] as const) {
      const { ms, windows } = sip(pose);
      expect(ms).toBeGreaterThan(6000);
      const times = fades(await follow(pose, 'drink', windows));
      expect(times).toHaveLength(2);
      for (const time of times) expect(Math.abs(time - FRONT_FADE_MS)).toBeLessThanOrEqual(1);
    }
    expect(idleSteps('chin', 'rest', () => .5).ms).toBeGreaterThan(20_000);
    const times = fades(await follow('rest', 'chin-long', [[0, 150]], 'l'));
    expect(times).toHaveLength(1);
    expect(Math.abs(times[0] - FRONT_FADE_MS)).toBeLessThanOrEqual(1);
  });

  it('a sip: the cup in the hand is whole before the desk cup goes, and the desk cup is whole again before it fades', async () => {
    for (const pose of ['rest', 'waiting'] as const) {
      const log = await follow(pose, 'drink', sip(pose).windows);
      // At every moment one of the two copies, lying on each other in the gripping pose, is whole.
      for (const record of log) expect(Math.max(record.front * record.held, record.desk)).toBeGreaterThan(.999);
      // Both switches are in the log.
      expect(log.some(record => record.desk < .001)).toBe(true);
      expect(log.some(record => record.front * record.held < .001)).toBe(true);
    }
  });

  it('the heart\'s drawn arms, straight up, lie exactly on the jointed arms in ARMS_UP, as wide and in the same layers', () => {
    const turn = ([x, y]: readonly number[], deg: number) => {
      const a = deg * Math.PI / 180;
      return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
    };
    const numbers = (d: string) => d.match(NUMBER)!.map(Number);
    const near = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < .08;
    for (const season of ['spring', 'autumn', 'winter'] as const) {
      const svg = deskAt(season, 13);
      for (const [side, shoulder, elbow, wrist] of [['l', [97, 72], [70, 42], [101, 38]], ['r', [129, 72], [156, 42], [125, 38]]] as const) {
        const upper = ARMS_UP[`upper-${side}`] as number, fore = ARMS_UP[`fore-${side}`] as number;
        const e = turn([elbow[0] - shoulder[0], elbow[1] - shoulder[1]], upper).map((v, i) => v + shoulder[i]);
        const w = turn([wrist[0] - elbow[0], wrist[1] - elbow[1]], upper + fore).map((v, i) => v + e[i]);
        // Outline and filling of the upper arm (shoulder to elbow; the filling in two at the hem) and of the forearm
        // (elbow to wrist), each as wide as the jointed limb's (half-widths 5.5 and 5, lines of 6.6).
        for (const [paint, upperWidth, foreWidth] of [['currentColor', 17.6, 16.6], ['var(--paint-sweater)', 11, 10]] as const) {
          const paths = [...svg.querySelectorAll(`.field-heart-arms path[data-up][stroke="${paint}"]`)]
            .map(path => ({ d: numbers(path.getAttribute('data-up')!), width: Number(path.getAttribute('stroke-width')) }));
          const from = (p: readonly number[]) => paths.filter(({ d }) => near(d.slice(0, 2), p)).map(path => path.width);
          const to = (p: readonly number[]) => paths.filter(({ d }) => near(d.slice(-2), p)).map(path => path.width);
          expect([from(shoulder), to(e), from(e), to(w)]).toEqual([[upperWidth], [upperWidth], [foreWidth], [foreWidth]]);
        }
        // The heart's hand lies where the jointed hand does: its mitten on the jointed mitten.
        const hand = svg.querySelectorAll<SVGGElement>('.field-heart-hand')[side === 'l' ? 0 : 1];
        const [x, y, deg] = numbers(hand.dataset.up!), inner = hand.firstElementChild!, circle = inner.querySelector('.field-heart-mitten circle')!;
        const [a, bx, by] = numbers(inner.getAttribute('transform')!);
        const mitten = turn(turn([Number(circle.getAttribute('cx')) + bx, Number(circle.getAttribute('cy')) + by], a), deg).map((v, i) => v + [x, y][i]);
        expect(near(mitten, handAt(side, upper, fore))).toBe(true);
        // As on the jointed arm, the cuff and the sleeve's end close over the mitten.
        expect([...inner.children].map(child => child.tagName.toLowerCase())).toEqual(['clippath', 'g', 'path', 'path']);
      }
      // The filling goes over the body and the outfit at the neck, as the jointed arms' does; the hands come after the
      // head (they rest on it in the heart).
      const fill = svg.querySelectorAll('.field-heart-arms')[1], neck = svg.querySelector('[fill="var(--paint-knit)"], [fill="var(--paint-cream)"]');
      const jointed = [...svg.querySelectorAll('.field-upper-l:not(.field-front)')].pop()!;
      const before = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (season !== 'autumn') expect(before(neck!, fill)).toBe(true);
      expect(before(svg.querySelector('[fill="var(--paint-sweater)"] > path')!, fill)).toBe(true);
      expect(before(fill, jointed)).toBe(true);
      expect(before(svg.querySelector('.field-head')!, svg.querySelector('.field-heart-hand')!)).toBe(true);
    }
  });

  it('the heart takes over from the jointed arms, and gives back, only while its arms are straight up and fully drawn', async () => {
    const view = render(<FieldIllustration compact ownRepository pose="rest" at={WINTER} />);
    await later(2500);
    const svg = view.container.querySelector('svg')!;
    // Each animation's keyframes, the first and last at their offsets 0 and 1.
    const frames = (el: Element) => (live.get(el)?.find(stand => stand.live && stand.frames.length > 2)?.frames ?? [])
      .map((frame, i, all): Keyframe => ({ ...frame, offset: frame.offset ?? (i === 0 ? 0 : i === all.length - 1 ? 1 : null) }));
    const jointed = frames(svg.querySelector('.field-upper-l:not(.field-front)')!), heart = frames(svg.querySelector('.field-heart-arms')!);
    // The moments the jointed arms go and come back; the drawn arms are fully there on either side of each.
    const out = jointed.find(frame => frame.opacity === 0)!.offset!, back = jointed.findLast(frame => frame.opacity === 0)!.offset!;
    const shows = (at: number) => Math.min(Number(heart.findLast(frame => (frame.offset ?? 0) <= at)!.opacity),
      Number(heart.find(frame => (frame.offset ?? 1) >= at)!.opacity));
    expect([shows(out - .01), shows(out), shows(back), shows(back + .01)]).toEqual([1, 1, 1, 1]);
    // And straight up from before the one moment until after it, and from before the other until after it.
    const parts = [...svg.querySelectorAll<SVGElement>('.field-heart-arms path[data-up], .field-heart-hand')];
    expect(parts.length).toBeGreaterThan(8);
    for (const el of parts) {
      const value = (frame: Keyframe) => String(frame.d ?? frame.transform), up = el.dataset.up!;
      const straight = frames(el).filter(frame => value(frame).includes(up)).map(frame => frame.offset ?? 0);
      expect(Math.max(...straight.filter(at => at < .5))).toBeGreaterThan(out);
      expect(Math.min(...straight.filter(at => at > .5))).toBeLessThan(back - .01);
    }
    view.unmount();
  });
});

it('dresses the bench learner in summer in a real T-shirt: short sleeves of their own, flared past the slimmer bare arms, with no seam at the elbow', () => {
  const bench = (season: keyof typeof SEASON_DAYS) => {
    const [y, m, d] = SEASON_DAYS[season];
    return render(<FieldIllustration at={new Date(y, m, d, 13)} />).container.querySelector('svg')!;
  };
  const summer = bench('summer'), tee = summer.querySelector('.field-tee')!;
  // Each bare arm is clearly slimmer than its sleeve's straight hem, which runs square across the arm.
  const radii = (root: Element) => [...new Set([...root.querySelectorAll('path[fill]')].flatMap(path =>
    [...path.getAttribute('d')!.matchAll(/A([\d.]+) /g)].map(match => Number(match[1]))))].sort((p, q) => p - q);
  const arms = [...tee.querySelectorAll('.field-tee-arm')];
  expect(arms.map(radii)).toEqual([[9], [6.2]]);
  for (const arm of arms) expect(arm.querySelectorAll('path[fill="var(--paint-skin)"]').length).toBeGreaterThan(0);
  // Upper arm and forearm are one shape: each line is masked inside the other part.
  expect(arms[0].querySelectorAll('path[mask]')).toHaveLength(2);
  // Each sleeve's hem line: wider than the arm (half-widths 9 and 6.2) by a good margin, and square across it.
  expect(arms.map(arm => arm.querySelectorAll(':scope > path[stroke="currentColor"]').length)).toEqual([1, 1]);
  arms.forEach((arm, i) => {
    const [x0, y0, x1, y1] = arm.querySelector(':scope > path[stroke="currentColor"]')!.getAttribute('d')!.match(/-?[\d.]+/g)!.map(Number);
    expect(Math.hypot(x1 - x0, y1 - y0) / 2).toBeGreaterThan([9, 6.2][i] + 3);
    expect(Math.abs(y1 - y0)).toBeGreaterThan(3);
  });
  // Each sleeve is set in along a seam from the dropped shoulder to the armpit, apart from the torso.
  expect(tee.querySelectorAll('.field-tee-seam')).toHaveLength(2);
  // The sweater's own body and arm lines are not drawn under the tee; the other seasons keep them.
  expect(summer.querySelector('path[fill="var(--paint-sweater)"]:not(.field-tee path)')).toBeNull();
  for (const season of ['spring', 'autumn', 'winter'] as const) {
    const svg = bench(season);
    expect(svg.querySelector('.field-tee')).toBeNull();
    expect(svg.querySelectorAll('path[fill="var(--paint-sweater)"]')).toHaveLength(1);
  }
});
