import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { BRAND_MARK } from './brand-mark';
import { BrandWordmark } from './BrandWordmark';
import { smoothPath, type PenPoint } from './pen-path';
import { litMoonPath, moonPhase } from './moon-phase';
import { Ink } from './field-ink';
import { BenchSnow, BranchSnow, CrownSeason, Dumplings, FallingThing, GroundSnow, IcedDrink, Magpie, MilkyWay, MoonRabbit,
  OccasionScenery, SantaHat, SeasonHat, SeasonTop, Tangyuan, Tea, WinterScarf } from './FieldOccasions';
import { occasionOf, phaseOf, seasonOf, type DayPhase, type Season } from './occasions';

const round = (value: number) => Math.round(value * 10) / 10;

/** A disc of flat paint with a slight, fixed hand-cut wobble (never lumpy: only the two slowest waves). */
function paintDisc(cx: number, cy: number, r: number, seed: number): string {
  const points: PenPoint[] = [];
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2;
    const k = 1 + Math.sin(a * 2 + seed) * .008 + Math.sin(a * 3 + seed * 2.3) * .005;
    points.push([round(cx + Math.cos(a) * r * k), round(cy + Math.sin(a) * r * k)]);
  }
  return smoothPath(points, true);
}

/** The glow behind a scene: a pale disc and a stronger one of about 0.7 r a little up and to the left of its centre. */
function halo(cx: number, cy: number, r: number, seed: number): [string, string] {
  return [paintDisc(cx, cy, r, seed), paintDisc(round(cx - r * .06), round(cy - r * .05), round(r * .7), seed + 1)];
}

/** The flat middle of the lawn, along the scene's ground line, where the tree and the bench stand. */
const LAWN_MIDDLE: PenPoint[] = [[101, 381], [170, 378.5], [222, 380], [269, 379], [290, 381], [365, 379.5], [433, 381], [508, 378.5]];
/** As at the end of the promo film (the login page), the lawn is the ground of the whole page: its left shoulder runs
 * off the page to the left, it goes on under the text beside the scene with a gentle rise, and its right shoulder curves
 * down off the bottom near the far edge of that text. Its outer edges lie well outside any page. */
const LAWN_OPEN = `${smoothPath([[-560, 960], [-330, 690], [-200, 560], [-120, 486], [-60, 438], [0, 408], [50, 391], ...LAWN_MIDDLE,
  [570, 378], [660, 370], [760, 358], [860, 352], [950, 352], [1040, 358], [1110, 372], [1166, 394], [1210, 424], [1244, 462],
  [1266, 508], [1280, 570], [1288, 670], [1292, 800], [1294, 1100]])}L1294 2400L-1400 2400L-1400 960Z`;
/** Where the scene stands on its own (centred empty states): a closed island inside the drawing, no slab of colour. */
const LAWN_ISLAND = smoothPath([[24, 429], [38, 404], [66, 389], ...LAWN_MIDDLE, [540, 381], [566, 391], [582, 407], [586, 425],
  [570, 434], [470, 437], [300, 438], [130, 437], [38, 435]], true);
const HALO_OPEN = halo(236, 222, 262, 7);
const HALO_ISLAND = halo(252, 222, 200, 7);
/** At night the glow's inner disc is the moon: centre and radius of that disc for each backdrop. */
const MOON_OPEN: [number, number, number] = [round(236 - 262 * .06), round(222 - 262 * .05), round(262 * .7)];
const MOON_ISLAND: [number, number, number] = [round(252 - 200 * .06), round(222 - 200 * .05), round(200 * .7)];
const DESK_HALO = halo(119, 77, 66, 3);

/** The time of day by the viewer's clock. A page left open turns to dusk by itself: the phase is checked every few
 * minutes (and when the page is shown again), and only a change of phase renders anything. */
function useDayPhase(at?: Date): DayPhase {
  const [phase, setPhase] = useState(() => phaseOf(at ?? new Date()));
  useEffect(() => {
    if (at) return;
    const check = () => setPhase(phaseOf(new Date()));
    check();
    const timer = window.setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [at]);
  return at ? phaseOf(at) : phase;
}


/** A rounded limb from a to b, closed so it can hide what is behind it. */
function limb(a: PenPoint, b: PenPoint, r: number): PenPoint[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, nx = -dy * r, ny = dx * r;
  const m: PenPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [[a[0] + nx, a[1] + ny], [m[0] + nx * 1.04, m[1] + ny * 1.04], [b[0] + nx, b[1] + ny], [b[0] + dx * r, b[1] + dy * r],
    [b[0] - nx, b[1] - ny], [m[0] - nx * .96, m[1] - ny * .96], [a[0] - nx, a[1] - ny], [a[0] - dx * r, a[1] - dy * r]];
}

const TORSO: PenPoint[] = [[96,60],[84,70],[80,94],[83,115],[148,115],[149,89],[141,68],[126,60]];

/** The seated learner's torso and arms jointed at shoulder and elbow; at the keyboard the arms
 * hang down behind the lid, so only the pose decides what shows.
 * Rendered twice (outline pass, then fill pass) so overlapping parts merge into one shape:
 * no seam where an arm leaves the body or at the elbow. */
function Silhouette({ pass, season }: { pass: 'stroke' | 'fill'; season: Season }) {
  const fill = pass === 'fill';
  const paint = fill ? { fill: 'var(--paint-sweater)' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 6.6, strokeLinejoin: 'round' as const };
  const shape = (points: PenPoint[], className?: string) => <path className={className} d={smoothPath(points, true)} />;
  const forearm = (a: PenPoint, b: PenPoint) => <Forearm a={a} b={b} fill={fill} />;
  // A short sleeve (summer) ends halfway down the visible upper arm: below its hem the arm is bare down to the elbow.
  const upper = (a: PenPoint, b: PenPoint) => {
    if (!fill || season !== 'summer') return shape(limb(a, b, 5.5));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, r = 5.5;
    const m: PenPoint = [a[0] + (b[0] - a[0]) * HEM, a[1] + (b[1] - a[1]) * HEM], at = (p: PenPoint, k: number) => `${round(p[0] - dy * k)} ${round(p[1] + dx * k)}`;
    return <>
      {shape(limb(a, b, r))}
      <path d={`M${at(m, r)}L${at(b, r)}A${r} ${r} 0 0 0 ${at(b, -r)}L${at(m, -r)}Z`} fill="var(--paint-skin)" />
      <path d={`M${at(m, r * 1.15)}L${at(m, -r * 1.15)}`} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />
    </>;
  };
  return <g {...paint}>
    {shape(TORSO)}
    {fill && <DeskTop season={season} />}
    <g className="field-upper-l"><g className="field-fore-l">{forearm(...FOREARMS.l)}</g>{upper([97,72], [70,42])}</g>
    <g className="field-upper-r"><g className="field-fore-r">{forearm(...FOREARMS.r)}</g>{upper([129,72], [156,42])}</g>
  </g>;
}

/** A forearm from the elbow `a` to the wrist `b`. The filling pass gives it its hand: the mitten first, then the cuff's
 * edge, then the sleeve closing over the wrist, as in the promo film. Inside the forearm group the hand turns with the
 * arm, and the head and the lid, drawn later, still cover it. */
function Forearm({ a, b, fill, inset = 0 }: { a: PenPoint; b: PenPoint; fill: boolean; inset?: number }) {
  if (!fill) return <path d={smoothPath(limb(a, b, 5), true)} />;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, r = 5;
  return <>
    <Mitten cx={round(b[0] + dx * 8)} cy={round(b[1] + dy * 8)} inset={inset} />
    <path className="field-cuff" d={`M${round(b[0] - dy * r)} ${round(b[1] + dx * r)}A${r} ${r} 0 0 0 ${round(b[0] + dy * r)} ${round(b[1] - dx * r)}`}
      fill="none" stroke="currentColor" strokeWidth={6.6} strokeLinecap="round" />
    <path className="field-forearm" d={smoothPath(limb(a, b, r), true)} />
  </>;
}

/** Where each forearm runs in the drawing, elbow to wrist (the hands-behind-head drawing). */
const FOREARMS = { l: [[70, 42], [101, 38]], r: [[156, 42], [125, 38]] } as Record<'l' | 'r', [PenPoint, PenPoint]>;

/**
 * A second copy of one forearm and its hand, drawn above the head, for the moments the hand is at the face (chin on
 * hand, rubbing an eye, covering a yawn). It sits in the same jointed groups as the arm, so it is always exactly on
 * top of it; the motion controller shows it only while that would change nothing (the hand behind the lid, or beside
 * the head), so the hand never jumps between layers. Towards the elbow the copy fades out, so no seam shows where the
 * forearm meets the upper arm, which stays behind.
 */
/** The copy's lines are a hair thinner on their outer side, so their soft edges fall on the arm's own solid lines:
 * drawn over the arm it leaves the picture exactly as it was. */
const FRONT_INSET = .6;
function FrontHand({ side, id }: { side: 'l' | 'r'; id: string }) {
  const [a, b] = FOREARMS[side], at = (k: number) => [round(a[0] + (b[0] - a[0]) * k), round(a[1] + (b[1] - a[1]) * k)];
  const [x1, y1] = at(.45), [x2, y2] = at(.75), mask = `${id}-front-${side}`;
  return <g className={`field-upper-${side} field-front field-front-${side}`}><g className={`field-fore-${side}`}>
    <linearGradient id={`${mask}-fade`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
      <stop offset="0" stopColor="#000" /><stop offset="1" stopColor="#fff" />
    </linearGradient>
    <mask id={mask} maskUnits="userSpaceOnUse" x="-120" y="-120" width="480" height="400">
      <rect x="-120" y="-120" width="480" height="400" fill={`url(#${mask}-fade)`} />
    </mask>
    <g mask={`url(#${mask})`}>
      <g fill="none" stroke="currentColor" strokeWidth={6.6 - FRONT_INSET} strokeLinejoin="round"><Forearm a={a} b={b} fill={false} /></g>
      <g fill="var(--paint-sweater)"><Forearm a={a} b={b} fill inset={FRONT_INSET} /></g>
    </g>
  </g></g>;
}

/** A round mitten of a hand, a little wider than the cuff, with its colour off the line like the rest. */
function Mitten({ cx, cy, className = 'field-hand', inset = 0 }: { cx: number; cy: number; className?: string; inset?: number }) {
  return <g className={className}>
    <circle cx={cx} cy={cy} r={7} fill="var(--chat-bg, var(--bg))" />
    <circle cx={cx - 1.1} cy={cy - .8} r={7} fill="var(--paint-skin)" />
    <circle cx={cx} cy={cy} r={7 - inset / 2} fill="none" stroke="currentColor" strokeWidth={3.2 - inset} />
  </g>;
}

/** The desk figure's outfit at the neck, over the body and under the arms: a cream V under the spring cardigan, a
 * round tee neck in summer and a knitted scarf in winter (its hanging end goes on behind the lid). */
function DeskTop({ season }: { season: Season }) {
  if (season === 'spring') return <Ink points={[[101,60],[123,60],[112,75]]} width={2.6} closed fill="var(--paint-cream)" />;
  if (season === 'summer') return <path d="M101 61 Q112 69 123 61" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />;
  if (season !== 'winter') return null;
  return <g>
    <Ink points={[[115,63],[125,63],[127,84],[117,84]]} width={2.6} closed fill="var(--paint-knit)" />
    <path d="M117 71 H125 M117.5 77 H126" stroke="var(--paint-knit-stripe)" strokeWidth={2} strokeLinecap="round" fill="none" />
    <Ink points={[[96,56],[112,61],[128,56],[131,64],[112,70],[93,64]]} width={2.6} closed fill="var(--paint-knit)" />
    <path d="M104 60 V67 M120 60 V67" stroke="var(--paint-knit-stripe)" strokeWidth={2} strokeLinecap="round" fill="none" />
  </g>;
}

/** Winter: a knitted bobble hat on the desk figure's head (in the head group, so it tilts with it). */
function DeskHat() {
  return <g>
    <Ink points={[[98,38],[101,28],[112,22],[123,28],[126,38]]} width={2.6} closed fill="var(--paint-knit)" />
    <Ink points={[[95,37],[112,34],[129,37],[129,43],[112,40],[95,43]]} width={2.6} closed fill="var(--paint-knit-stripe)" />
    <circle cx={112} cy={18.5} r={4.4} fill="var(--paint-cream)" stroke="currentColor" strokeWidth={2.2} />
  </g>;
}

export type { FieldPose, FieldCue, FieldMotionHandle } from './field-motion';
import { DeskMotion, greetAtOpening, isOpening, type FieldPose, type FieldMotionHandle, type FigureState } from './field-motion';

/** The heart the arms make over the head: up and out from each shoulder, round over the two lobes and down to the
 * hands meeting on top of the head. */
const HEART_ARMS = 'M97 72 C86 58 72 44 74 28 C76 14 92 9 103 15 C108 18 111 22 113 27 '
  + 'M129 72 C140 58 154 44 152 28 C150 14 134 9 123 15 C118 18 115 22 113 27';
/** The same two arms straight up, exactly where the jointed arms are in ARMS_UP, with the same commands as the heart
 * so one can bend into the other. */
const HEART_ARMS_UP = 'M97 72 C92 60 86 47 81.2 34.8 C79.5 27 77.5 19 76.8 14.4 C76 10.5 75.2 7 74.5 4.2 '
  + 'M129 72 C134 60 140 47 144.8 34.8 C146.5 27 148.5 19 149.2 14.4 C150 10.5 150.8 7 151.5 4.2';
/** Where a short sleeve ends along the upper arm, from the shoulder joint (which sits inside the body) to the elbow:
 * about halfway down the part that shows. */
const HEM = .6;
/** An upper arm's one-curve path split at the hem (de Casteljau), for the sleeve and the bare arm below its hem;
 * the bare half comes after the sleeve, with flat ends, so the hem is a straight cut. */
function halves(up: string, heart: string): Array<[string, string, string]> {
  const split = (d: string) => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = d.match(/-?[\d.]+/g)!.map(Number);
    const mid = (a: number, b: number) => a + (b - a) * HEM;
    const [ax, ay, bx, by, cx, cy] = [mid(x0, x1), mid(y0, y1), mid(x1, x2), mid(y1, y2), mid(x2, x3), mid(y2, y3)];
    const [dx, dy, ex, ey] = [mid(ax, bx), mid(ay, by), mid(bx, cx), mid(by, cy)], [fx, fy] = [mid(dx, ex), mid(dy, ey)];
    const n = (...v: number[]) => v.map(round).join(' ');
    return [`M${n(x0, y0)} C${n(ax, ay, dx, dy, fx, fy)}`, `M${n(fx, fy)} C${n(ex, ey, cx, cy, x3, y3)}`];
  };
  const [upSleeve, upBare] = split(up), [heartSleeve, heartBare] = split(heart);
  return [['', upSleeve, heartSleeve], ['field-bare', upBare, heartBare]];
}

/** The same arms in pieces for their filling, [class, straight up, heart]: forearms apart from upper arms, so a short
 * sleeve can leave the forearm bare. Each piece keeps the commands of its part of the whole arm. */
const HEART_PIECES: Array<[string, string, string]> = [
  ['field-forearm', 'M81.2 34.8 C79.5 27 77.5 19 76.8 14.4 C76 10.5 75.2 7 74.5 4.2', 'M74 28 C76 14 92 9 103 15 C108 18 111 22 113 27'],
  ['field-forearm', 'M144.8 34.8 C146.5 27 148.5 19 149.2 14.4 C150 10.5 150.8 7 151.5 4.2', 'M152 28 C150 14 134 9 123 15 C118 18 115 22 113 27'],
  ...halves('M97 72 C92 60 86 47 81.2 34.8', 'M97 72 C86 58 72 44 74 28'),
  ...halves('M129 72 C134 60 140 47 144.8 34.8', 'M129 72 C140 58 154 44 152 28'),
];
/** Where the two hands are at the ends of those arms: straight up (exactly where the jointed arms put them), and
 * meeting on top of the head in the heart. */
const HEART_HANDS: Array<[number, number, number, number]> = [[72.8, -3.9, 110, 24], [153.2, -3.9, 116, 24]];

/** Runs the desk figure's motion controller (field-motion.ts) and tells it what happens: the state, our project
 * opening (the heart), and the user typing a question (`draft`, the composer's text). */
function useDeskMotion(ref: RefObject<SVGSVGElement | null>, pose: FieldPose, own: boolean, draft: string | undefined,
  at: Date | undefined, handle?: MutableRefObject<FieldMotionHandle | null>) {
  const motion = useRef<DeskMotion | null>(null);
  const clock = useRef(at);
  clock.current = at;
  const seen = useRef<FigureState | null>(null);
  const greet = useRef(false);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const created = new DeskMotion(svg, { clock: () => clock.current ?? new Date() });
    motion.current = created;
    if (handle) handle.current = { play: cue => created.play(cue), speed: rate => created.speed(rate) };
    return () => {
      created.destroy();
      motion.current = null;
      if (handle) handle.current = null;
    };
  }, [ref, handle]);
  // While the composer holds a question the chair is pulled in to the laptop; it goes back once the text is gone.
  // (Before the state is applied, so a figure that appears with text already there starts pulled in.)
  const attentive = Boolean(draft?.trim());
  useLayoutEffect(() => { motion.current?.setAttentive(attentive); }, [attentive]);
  useLayoutEffect(() => {
    const controller = motion.current;
    if (!controller) return;
    const now = { pose, own }, was = seen.current;
    // A heart is decided once per opening; React running this again for the same state keeps that decision.
    const changed = !was || was.pose !== pose || was.own !== own;
    if (changed) {
      greet.current = isOpening(was, now) && greetAtOpening(storage());
      seen.current = now;
    }
    if (!controller.isStarted) controller.start(pose, greet.current);
    else if (changed && (was?.pose !== pose || greet.current)) controller.setPose(pose, greet.current);
  }, [pose, own]);
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The product mark: a learner reaching into a computer folder for a page of code. Resting the pointer on it lifts
 * the page for a closer look. While the agent works (`busy`) he takes a page out, reads it, puts it back and takes
 * the next one (the writing on the page changes while it is out of sight). When the work is done he tucks the page
 * away, rests his arm on the folder and the two "got it" lines of the first mark appear by his head.
 * The page is drawn twice, once as ink and once inside the mask that hides the folder behind it, so both copies
 * share the class that moves them. The busy class is set here rather than by React, so the current pose can be
 * read when the work ends and the closing moment can start from it. */
export function FieldMark({ busy = false, celebrate = 0 }: { busy?: boolean; celebrate?: number }) {
  const id = `${useId().replace(/:/g, '')}-mark`;
  const ref = useRef<SVGSVGElement>(null);
  const shown = useRef<boolean | null>(null);
  // Each time `celebrate` goes up (a learning route was just finished) he cheers: tosses the page he was reading up
  // into the air, throws his arm up and hops twice, says "got it", and a moment later the page is back in the folder.
  // Nothing happens on the first render.
  const celebrated = useRef(celebrate);
  useLayoutEffect(() => {
    if (celebrate === celebrated.current) return;
    celebrated.current = celebrate;
    const svg = ref.current;
    if (!svg) return;
    const run = (selector: string, frames: Keyframe[], duration = 3000) =>
      svg.querySelectorAll<SVGElement>(selector).forEach(el => el.animate?.(frames, { duration, easing: 'ease-in-out' }));
    run('.field-mark-page', [{ transform: 'none', opacity: 1 },
      { transform: 'translate(3px, -6px) rotate(-12deg)', opacity: 1, offset: .12, easing: 'cubic-bezier(.2, .7, .4, 1)' },
      { transform: 'translate(12px, -24px) rotate(-150deg)', opacity: .9, offset: .38 },
      { transform: 'translate(17px, -30px) rotate(-240deg)', opacity: 0, offset: .5 },
      { transform: 'translate(.6px, 11px)', opacity: 0, offset: .51 }, { transform: 'translate(.6px, 11px)', opacity: 1, offset: .82 },
      { transform: 'none', opacity: 1 }]);
    run('.field-mark-arm', [{ transform: 'none' }, { transform: 'rotate(-8deg)', offset: .12 }, { transform: 'rotate(-30deg)', offset: .26 },
      { transform: 'rotate(-20deg)', offset: .4 }, { transform: 'rotate(-30deg)', offset: .54 }, { transform: 'rotate(-26deg)', offset: .7 },
      { transform: 'none' }]);
    run('.field-mark-hop', [{ transform: 'none' }, { transform: 'none', offset: .2 }, { transform: 'translateY(-2.2px)', offset: .3 },
      { transform: 'none', offset: .4 }, { transform: 'translateY(-2.2px)', offset: .5 }, { transform: 'none', offset: .6 }, { transform: 'none' }]);
    run('.field-mark-insight', [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(.6)', offset: .24 },
      { opacity: 1, transform: 'scale(1.12)', offset: .34 }, { opacity: 1, transform: 'none', offset: .75 }, { opacity: 0, transform: 'none' }]);
  }, [celebrate]);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const previous = shown.current;
    shown.current = busy;
    const pages = [...svg.querySelectorAll<SVGGElement>('.field-mark-page')];
    const arm = svg.querySelector<SVGGElement>('.field-mark-arm');
    const from = { pages: pages.map(el => getComputedStyle(el).transform), arm: arm ? getComputedStyle(arm).transform : 'none' };
    svg.classList.toggle('field-mark-busy', busy);
    if (previous !== true || busy) return;
    const tucked = 'translate(.6px, 11px)';
    pages.forEach((el, i) => el.animate?.([{ transform: from.pages[i] }, { transform: tucked, offset: .25 }, { transform: tucked, offset: .8 }, { transform: 'none' }],
      { duration: 2800, easing: 'ease-in-out' }));
    arm?.animate?.([{ transform: from.arm }, { transform: 'rotate(27deg)', offset: .25 }, { transform: 'rotate(27deg)', offset: .8 }, { transform: 'none' }],
      { duration: 2800, easing: 'ease-in-out' });
    svg.querySelector('.field-mark-insight')?.animate?.([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(.6)', offset: .22 },
      { opacity: 1, transform: 'scale(1.1)', offset: .34 }, { opacity: 1, transform: 'none', offset: .78 }, { opacity: 0, transform: 'none' }],
      { duration: 2800, easing: 'ease-out' });
  }, [busy]);
  const m = BRAND_MARK;
  return <svg ref={ref} className="field-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
    <defs>
      <mask id={`${id}-folder`} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="white" />
        <g className="field-mark-page"><path d={m.pageShape} fill="black" /></g>
        <path d={m.frontShape} fill="black" />
      </mask>
      <mask id={`${id}-page`} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="white" /><path d={m.frontShape} fill="black" />
      </mask>
    </defs>
    <g fill="currentColor" fillRule="evenodd">
      <path d={m.back} mask={`url(#${id}-folder)`} />
      <g mask={`url(#${id}-page)`}><g className="field-mark-page"><path d={m.page} />
        <g className="field-mark-lines">{m.pageLines.map(d => <path key={d} d={d} />)}</g>
        <g className="field-mark-lines-next">{m.nextPageLines.map(d => <path key={d} d={d} />)}</g>
      </g></g>
      <path d={m.front} />
      <g className="field-mark-hop"><path d={m.head} /><path d={m.body} /></g>
      {/* The arm shares the page's mask, so a hand reaching into the folder goes behind its front. */}
      <g mask={`url(#${id}-page)`}><g className="field-mark-arm"><path d={m.arm} /></g></g>
      <g className="field-mark-insight">{m.insight.map(d => <path key={d} d={d} />)}</g>
    </g>
  </svg>;
}

export function FieldScene({ className = '', at }: { className?: string; at?: Date }) {
  return <figure className={`field-scene ${className}`}><FieldIllustration at={at} />
    <figcaption aria-label="what-the-repo"><BrandWordmark /></figcaption>
  </figure>;
}

/** Front view at a laptop, with a chair back behind. At rest the hands are on the keyboard behind the lid; while the
 * agent works the learner folds their arms behind their head; when something fails they scratch their head. Now and
 * then they do some small thing (field-motion.ts). */
function FieldDesk({ pose, className, ownRepository, at, draft, motionRef }: {
  pose: FieldPose; className: string; ownRepository: boolean; at?: Date; draft?: string; motionRef?: MutableRefObject<FieldMotionHandle | null>;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const id = `field-desk-${useId().replace(/:/g, '')}`;
  useDeskMotion(ref, pose, ownRepository, draft, at, motionRef);
  const season = seasonOf(at ?? new Date());
  return <svg ref={ref} className={`field-illustration field-illustration-small field-${pose} ${className}`} viewBox="0 0 240 150" aria-hidden="true" focusable="false"
    data-season={season}>
    {/* A small patch of light behind the figure, the same two discs as the bench scene's glow. */}
    <path d={DESK_HALO[0]} fill="var(--paint-halo-outer)" /><path d={DESK_HALO[1]} fill="var(--paint-halo)" />
    {/* Nested jointed groups, moved only by the motion controller (field-motion.ts): the chair leans back with the
        body, the body rocks, stretches and leans in, the head turns on its own, and the arms bend at shoulder and
        elbow. The hands are hidden only by what is drawn over them: the head and the lid. */}
    <g className="field-pull"><g className="field-drift"><g className="field-sway"><g className="field-lean"><g className="field-rock">
      <Ink points={[[86,22],[114,19],[142,22],[150,50],[151,104],[79,104],[80,50]]} width={3.2} closed fill="var(--chat-bg, var(--bg))"
        paint="var(--paint-chair)" />
      {/* The padded top of the chair back catches the light: a lighter band along the upper edge, in register with the
          shifted paint, and two short shine strokes at its upper left. Flat colour, the same in every season. */}
      <g className="field-chair-sheen" fill="none" strokeLinecap="round">
        <path d="M87 26 Q112 20 138 25 L139 31 Q112 27 87 32 Z" fill="var(--paint-chair-sheen)" />
        <path d="M86 37 Q84 50 85 64" stroke="var(--paint-chair-sheen)" strokeWidth={4} />
        <path d="M91 25.5 Q99 23 108 22.5" stroke="var(--paint-chair-shine)" strokeWidth={2.2} />
      </g>
      <g className="field-stretch-body"><g className="field-breath">
      {/* Arms bent into a heart over the head, shown only at the top of the heart gesture. Like the jointed arms they
          are drawn outline first and filling second, so the body's outline never shows across the shoulders. */}
      <g className="field-heart-arms" fill="none" strokeLinecap="round">
        <path d={HEART_ARMS_UP} data-up={HEART_ARMS_UP} data-heart={HEART_ARMS} stroke="currentColor" strokeWidth={16.6} />
      </g>
      <Silhouette pass="stroke" season={season} />
      <g className="field-heart-arms" fill="none" strokeLinecap="round">
        {HEART_PIECES.map(([piece, up, heart]) => <path key={up} className={piece || undefined} d={up} data-up={up} data-heart={heart}
          stroke="var(--paint-sweater)" strokeWidth={10} strokeLinecap={piece === 'field-bare' ? 'butt' : undefined} />)}
      </g>
      <Silhouette pass="fill" season={season} />
      <g className="field-head"><g className="field-head-drift"><g className="field-head-sway">
        <Ink points={[[111,29,.85],[101,33,1.2],[97,42,1.1],[100,52,.9],[111,56,1.15],[123,53,.85],[127,43,1.2],[123,33,.9]]} width={3.6} closed fill="var(--chat-bg, var(--bg))"
          paint="var(--paint-skin)" shift={[-1.6, -1.1]} />
        {season === 'winter' && <DeskHat />}
      </g></g></g>
      {/* A hand at the face comes in front of it (shown only then). */}
      <FrontHand side="l" id={id} /><FrontHand side="r" id={id} />
      {/* The heart's hands meet on top of the head, so they come after it. */}
      <g className="field-heart-arms">
        {HEART_HANDS.map(([ux, uy, hx, hy]) => <g key={ux} className="field-heart-hand" data-up={`${ux}px, ${uy}px`} data-heart={`${hx}px, ${hy}px`}>
          <Mitten cx={0} cy={0} className="field-heart-mitten" /></g>)}
      </g>
      </g></g>
    </g></g></g></g></g>
    {/* A small hand-written question mark, only while puzzled. */}
    <g className="field-puzzle-mark">
      <Ink points={[[161,22],[164,16],[171,15],[174,20],[170,25],[168,30]]} width={2.6} />
      <circle cx="168" cy="36" r="1.7" fill="currentColor" />
    </g>
    {/* We see the plain back of the lid and its thin bottom edge, not the screen or keyboard. */}
    <Ink points={[[69,79,.85],[86,80,1.2],[149,79,.9],[171,81,1.1],[169,98,.85],[166,120,1.2],[148,121,.9],[91,120,1.15],[74,119,.85],[71,98,1.1]]} width={3.3} closed fill="var(--chat-bg, var(--bg))"
      paint="var(--paint-screen)" shift={[-1.8, -1.2]} />
    <Ink points={[[70,122,.85],[89,125,1.1],[149,126,.9],[171,123,1.1]]} width={2.6} />
    {/* Shown only during the heart gesture for our own repository. */}
    <path className="field-heart" d="M184 40 C175 33 174 25 179 23 C182 22 184 24 184 27 C184 24 186 22 189 23 C194 25 193 33 184 40 Z"
      fill="#e58a9c" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
  </svg>;
}

/**
 * Tonight's moon for the dark-mode sky, drawn in SVG user units. The whole disc stays faintly drawn, so a new
 * moon still leaves a trace; the lit part follows the date, with a few faint craters only where the light falls.
 */
export function NightMoon({ cx = 452, cy = 130, r = 24, phase }: { cx?: number; cy?: number; r?: number; phase?: number }) {
  const clip = `field-moon-${useId().replace(/:/g, '')}`;
  const lit = litMoonPath(cx, cy, r, phase ?? moonPhase());
  const at = (dx: number, dy: number) => ({ cx: cx + dx * r / 24, cy: cy + dy * r / 24 });
  return <g color="var(--moon)">
    <circle className="field-moon-disc" cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={1.6} />
    {lit && <>
      <clipPath id={clip}><path d={lit} /></clipPath>
      <path d={lit} fill="color-mix(in srgb, var(--moon) 42%, var(--bg))" />
      <g clipPath={`url(#${clip})`} className="field-moon-craters" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle {...at(-8, -8)} r={4.2 * r / 24} /><circle {...at(8, 9)} r={3 * r / 24} /><circle {...at(-5, 13)} r={1.8 * r / 24} />
      </g>
      <path d={lit} fill="none" stroke="currentColor" strokeWidth={2.9} strokeLinejoin="round" />
    </>}
  </g>;
}

/**
 * At night the glow's inner disc becomes tonight's moon: the whole disc stays faintly there, the lit part follows the
 * date like NightMoon's, with a few very faint craters where the light falls. Shown by the stylesheet at night.
 */
function HaloMoon({ at: [cx, cy, r], phase }: { at: [number, number, number]; phase: number }) {
  const id = `field-halo-moon-${useId().replace(/:/g, '')}`;
  const lit = litMoonPath(cx, cy, r, phase);
  const crater = (dx: number, dy: number, size: number) => <circle cx={round(cx + dx * r)} cy={round(cy + dy * r)} r={round(size * r)} />;
  return <g className="field-sky-moon">
    <circle cx={cx} cy={cy} r={r} fill="var(--paint-moon-unlit)" />
    {lit && <>
      {/* Moonlight: a soft bloom round the lit part, so a crescent glows as well as a full moon. It never moves, so the
          blur is drawn once. */}
      <filter id={`${id}-bloom`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation={round(r * .07)} /></filter>
      <path className="field-moon-bloom" d={lit} fill="var(--paint-moon-bloom)" filter={`url(#${id}-bloom)`} />
      <clipPath id={id}><path d={lit} /></clipPath>
      <path d={lit} fill="var(--paint-moon-lit)" />
      <g clipPath={`url(#${id})`} fill="var(--paint-moon-crater)">
        {crater(.3, -.38, .13)}{crater(.5, .2, .09)}{crater(-.32, .3, .11)}{crater(-.1, -.12, .06)}{crater(.12, .55, .05)}
      </g>
    </>}
  </g>;
}

/** The crown's outline, uneven on purpose; it overshoots where it starts and ends. */
const CANOPY: PenPoint[] = [[134,262],[104,267],[72,258],[48,240],[36,214],[42,193],[31,171],[29,145],[42,121],[61,109],[67,86],[86,65],
  [110,57],[127,40],[152,29],[180,31],[201,42],[214,57],[238,58],[259,73],[271,95],[268,117],[283,135],[289,160],[279,183],
  [265,196],[270,219],[257,241],[234,252],[208,253],[187,262],[160,266]];
const BREEZE: PenPoint[][] = [[[396,139,.7],[417,135,1.1],[437,138,.8]], [[413,151,.7],[443,148,1.1],[462,151,.75]]];

/**
 * On April Fools' Day the sky side takes the other theme's ink, which is weak on the page itself where a line leaves
 * the island's small sky disc (the crown's left edge, a star, the breeze). There a border of the page's own ink runs
 * under the line, masked to outside the disc; the stylesheet shows it only then.
 */
function Edge({ d, width, mask }: { d: string; width: number; mask: string }) {
  return <path className="field-edge" d={d} fill="none" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" mask={`url(#${mask})`} />;
}

/** `at` shows the scene as on another date and time (the gallery uses it); the page itself always shows now. */
/** `draft` (compact figure only) is the chat composer's text: while the user types a question the figure leans in.
 * `motionRef` lets the private gallery trigger each action; the product never passes it. */
export function FieldIllustration({ compact = false, pose = 'rest', className = '', at, ownRepository = false, draft, motionRef }: {
  compact?: boolean; pose?: FieldPose; className?: string; at?: Date; ownRepository?: boolean; draft?: string;
  motionRef?: MutableRefObject<FieldMotionHandle | null>;
}) {
  if (compact) return <FieldDesk pose={pose} className={className} ownRepository={ownRepository} at={at} draft={draft} motionRef={motionRef} />;
  return <FieldBench className={className} at={at} />;
}

function FieldBench({ className, at }: { className: string; at?: Date }) {
  const phase = useDayPhase(at);
  const glow = `field-glow-${useId().replace(/:/g, '')}`, edges = `${glow}-edges`;
  const now = at ?? new Date();
  const season = seasonOf(now), occasion = occasionOf(now), moon = moonPhase(now);
  // One thing at a time beside the learner: a festival dish, else the season's drink, else tea after dark.
  const benchItem = occasion === 'winter-solstice' ? <Dumplings /> : occasion === 'lantern-festival' ? <Tangyuan />
    : occasion === 'april-fools' ? <Tea upsideDown /> : season === 'summer' ? <IcedDrink /> : <Tea hot={season === 'winter'} />;
  return <svg className={`field-illustration ${className}`} viewBox="0 0 600 440" aria-hidden="true" focusable="false"
    data-season={season} data-phase={phase} data-occasion={occasion ?? undefined}>
    {/* Flat paint behind everything, as in the promo film: a glow of two discs, a lawn with soft shoulders and flat
        contact shadows. Standing alone the lawn is a closed island; on the login page it runs off the page. */}
    <g className="field-backdrop field-backdrop-island">
      <g className="field-turn">
        <path d={HALO_ISLAND[0]} fill="var(--paint-halo-outer)" /><path className="field-sky-sun" d={HALO_ISLAND[1]} fill="var(--paint-halo)" />
        <HaloMoon at={MOON_ISLAND} phase={moon} />
      </g>
      <path className="field-lawn" d={LAWN_ISLAND} fill="var(--paint-lawn)" />
    </g>
    <g className="field-backdrop field-backdrop-open">
      <g className="field-turn">
        <path d={HALO_OPEN[0]} fill="var(--paint-halo-outer)" /><path className="field-sky-sun" d={HALO_OPEN[1]} fill="var(--paint-halo)" />
        <HaloMoon at={MOON_OPEN} phase={moon} />
      </g>
      <path className="field-lawn" d={LAWN_OPEN} fill="var(--paint-lawn)" />
    </g>
    <g fill="var(--paint-lawn-shade)">
      <ellipse cx={146} cy={383} rx={76} ry={6} /><ellipse cx={347} cy={387} rx={112} ry={6.5} />
    </g>
    {/* Everything standing in the sky, as against the ground: on April Fools' Day it takes the other theme's paint and
        ink, while the lawn, the shadows, the ground lines and the grass keep the page's. */}
    <g className="field-turn">
    {/* An open-air study spot: a big, loosely drawn tree, a long park bench and a little breeze.
        The canopy is uneven on purpose, and its line overshoots where it starts and ends. */}
    <g className="field-canopy">
      <Edge d={smoothPath(CANOPY)} width={8} mask={edges} />
      <Ink points={CANOPY} width={4.4} color="var(--accent)"
        fill="color-mix(in srgb, var(--accent-soft) 30%, var(--bg))" paint="var(--paint-canopy)" shift={[-4, -3]} />
      {/* A few different doodles in the crown, never the same mark twice. */}
      <g className="field-doodles">
        <Ink points={[[70,158],[80,146],[94,142],[90,154],[70,158]]} width={3} color="var(--accent)" closed />
        <Ink points={[[70,158],[84,150]]} width={2.4} color="var(--accent)" />
        <Ink points={[[110,96],[118,86],[128,84],[134,90],[128,96]]} width={3} color="var(--accent)" />
        <Ink points={[[200,112],[208,100],[212,90]]} width={2.8} color="var(--accent)" />
        <Ink points={[[208,100],[200,94],[196,86],[204,88],[208,98]]} width={2.8} color="var(--accent)" closed />
        <Ink points={[[210,94],[218,88],[226,88],[222,95],[211,96]]} width={2.8} color="var(--accent)" closed />
        <g className="field-doodle-dots" fill="var(--accent)"><circle cx="232" cy="182" r="3.2" /><circle cx="241" cy="186" r="3" /><circle cx="234" cy="192" r="2.8" /></g>
        <Ink points={[[56,216],[64,206],[70,214]]} width={2.8} color="var(--accent)" />
      </g>
      <CrownSeason season={season} />
    </g>
    {/* A wobbly, slightly leaning trunk that forks into the crown, outlined in brown ink. */}
    <g fill="var(--paint-trunk)" stroke="color-mix(in srgb, var(--fg) 80%, var(--warn) 20%)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round">
      <path d="M126 373 Q121 346 128 312 Q133 284 131 250 L161 250 Q158 284 163 314 Q170 346 168 373" />
      <path className="field-branches" d="M131 256 Q129 238 116 222 Q104 208 90 200 Q84 195 92 194 Q108 199 126 214 Q136 224 139 230
        Q140 196 141 162 Q142 132 146 118 Q150 112 152 120 Q154 150 154 196 Q168 178 186 160 Q198 150 204 154 Q206 160 196 168
        Q174 190 162 218 Q160 238 161 256" />
    </g>
    {season === 'winter' && <BranchSnow />}
    <OccasionScenery occasion={occasion} />
    {/* After dark the laptop lights the learner: one soft warm glow, the only gradient in the scene. */}
    {/* Where the island's sky disc is not: the April Fools edges (Edge) show only out there. */}
    <mask id={edges} maskUnits="userSpaceOnUse" x={-100} y={-100} width={800} height={640}>
      <rect x={-100} y={-100} width={800} height={640} fill="white" /><path d={HALO_ISLAND[0]} fill="black" />
    </mask>
    <radialGradient id={glow}>
      <stop offset="0" style={{ stopColor: 'var(--paint-screen-glow)' }} />
      <stop offset=".55" style={{ stopColor: 'var(--paint-screen-glow)', stopOpacity: .45 }} />
      <stop offset="1" style={{ stopColor: 'var(--paint-screen-glow)', stopOpacity: 0 }} />
    </radialGradient>
    <ellipse className="field-screen-glow" cx={306} cy={262} rx={124} ry={104} fill={`url(#${glow})`} />
    {/* Bench and learner sit a little smaller than the tree. */}
    <g transform="translate(345 373) scale(.86) translate(-345 -373)">
    {/* The bench remains one simple background shape, with clear space below the seat. */}
    <Ink points={[[246,207,.85],[308,209,1.1],[371,206,.9],[443,208,1.15],[444,231,.85],[367,230,1.15],[305,233,.9],[245,230,1.1]]} width={3.8} closed
      fill="var(--bg)" paint="var(--paint-bench)" />
    {season === 'winter' && <BenchSnow />}
    <Ink points={[[256,233,.8],[257,288,1.1]]} width={3.3} />
    <Ink points={[[430,231,.8],[427,290,1.1]]} width={3.3} />
    <Ink points={[[232,291,.85],[295,290,1.1],[365,293,.9],[457,291,1.15],[459,304,.85],[379,307,1.1],[296,304,.9],[232,305,1.1]]} width={3.8} closed
      fill="var(--bg)" paint="var(--paint-bench)" />
    <Ink points={[[253,308,.8],[250,339,1.1],[253,373,.75]]} width={3.8} />
    <Ink points={[[435,308,.8],[435,340,1.1],[438,373,.75]]} width={3.8} />
    {/* Broad sleeves and roomy trouser shapes, without narrow wrists or separate shoes. */}
    <Ink points={[[345,288,.85],[375,301,1.15],[385,325,.9],[386,347,1.1],[382,368,.85],[364,371,1.1],[343,368,.9],[341,344,1.15],[334,316,.85]]} width={5.2} closed
      fill="var(--bg)" paint="var(--paint-trousers)" />
    <Ink points={[[297,291,.85],[323,298,1.15],[336,313,.9],[334,338,1.1],[331,369,.85],[312,372,1.15],[289,369,.9],[285,345,1.1],[280,322,.85],[279,308,1.15]]} width={5.4} closed
      fill="var(--bg)" paint="var(--paint-trousers)" />
    <Ink points={[[305,196,.85],[283,212,1.15],[268,240,.9],[272,272,1.2],[298,293,.85],[352,300,1.1],[381,289,.9],[395,263,1.2],[389,233,.85],[369,211,1.1],[344,198,.9]]} width={5.5} closed
      fill="var(--bg)" paint="var(--paint-sweater)" />
    <SeasonTop season={season} />
    {/* The head stays a blank shape. */}
    <Ink points={[[313,147,.85],[297,150,1.2],[289,162,1.1],[291,178,.9],[304,188,1.2],[323,187,.85],[338,178,1.1],[339,165,1.2],[328,150,.85]]} width={4.8} closed
      fill="var(--bg)" paint="var(--paint-skin)" />
    {season === 'winter' && <WinterScarf />}
    {occasion === 'christmas' ? <SantaHat /> : <SeasonHat season={season} />}
    <Ink points={[[291,221,.85],[280,244,1.15],[285,260,.9]]} width={4.6} />
    {/* The left hand (on our right) keeps only its inner edge; the torso already draws its outside. */}
    <Ink points={[[350,232,.9],[358,250,1.1],[352,261,.85],[332,260,1.15],[327,276,.9],[337,286,1.1],[366,290,.85],[380,287,.9]]} width={5.1} />
    {/* The plain rear of the lid faces us; the screen and hands are on the person's side. */}
    <Ink points={[[247,239,.85],[273,241,1.1],[309,243,.9],[343,245,1.2],[343,263,.85],[339,287,1.1],[309,288,.9],[264,284,1.2],[258,266,.85],[252,252,1.1]]} width={4.2} closed
      fill="var(--panel)" paint="var(--paint-screen)" />
    <Ink points={[[258,289,.85],[298,293,1.1],[341,292,.85]]} width={3.1} />
    {benchItem}
    </g>
    {/* By day a breeze; at night (always in dark mode) the same corner holds tonight's moon and a few stars instead. */}
    <g className="field-day">
      {BREEZE.map((points, i) => <g key={i} className={i ? 'field-breeze field-breeze-second' : 'field-breeze'}>
        <Edge d={smoothPath(points)} width={5.2} mask={edges} />
        <Ink points={points} width={2.4} color="var(--accent)" />
      </g>)}
    </g>
    {/* The moon is the glow behind the scene (HaloMoon); the night corner keeps the stars. */}
    <g className="field-night" color="var(--moon)">
      {occasion === 'qixi' && <MilkyWay />}
      <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
        <path className="field-star field-star-twinkle" d="M401 118 L401.5 128 M396 123.3 L406.5 122.8" />
        <Edge d="M497 118 L497.3 124 M494 121.2 L500.4 121" width={5} mask={edges} />
        <path className="field-star" d="M497 118 L497.3 124 M494 121.2 L500.4 121" />
        <path className="field-star field-star-late" d="M418 160 L418.2 166 M415 163.1 L421.3 162.8" />
      </g>
    </g>
    {/* Now and then a leaf lets go of the crown and drifts down with the breeze. Falling, swaying sideways and
        rocking are separate layers, so the leaf never stops in mid-air while it changes direction. */}
    <g transform="translate(186 258)"><g className="field-leaf-fall"><g className="field-leaf-drift"><g className="field-leaf-swing">
      <FallingThing season={season} occasion={occasion} />
    </g></g></g></g>
    <g transform="translate(74 250)"><g className="field-leaf-fall field-leaf-fall-second"><g className="field-leaf-drift field-leaf-drift-second"><g className="field-leaf-swing field-leaf-swing-second">
      <FallingThing season={season} occasion={occasion} second />
    </g></g></g></g>
    </g>
    <Ink className="field-grass" points={[[484,346,.75],[493,363,1.1],[501,345,.8]]} width={3} color="var(--accent)" />
    <Ink className="field-grass" points={[[88,355,.7],[98,371,1.1],[105,355,.75]]} width={3} color="var(--accent)" />
    <Ink points={[[101,379,.7],[170,377,1.15],[222,379,.85],[269,378,.7]]} width={2.6} />
    <Ink points={[[290,381,.75],[365,379,1.1],[433,381,.85],[508,377,.7]]} width={2.6} />
    {season === 'winter' && <GroundSnow />}
    {/* The animals come last, in front of the bench, the grass and the snow they hop past. */}
    <g className="field-turn">
      {occasion === 'mid-autumn' && <MoonRabbit />}
      {occasion === 'qixi' && <Magpie />}
    </g>
  </svg>;
}
