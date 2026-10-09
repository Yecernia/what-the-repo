import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { BRAND_MARK } from './brand-mark';
import { BrandWordmark } from './BrandWordmark';
import { handOutline, smoothPath, type PenPoint } from './pen-path';
import { loginLawnPath, loginMeadowPath, type LawnFrame } from './login-lawn';
import { litMoonPath, moonPhase } from './moon-phase';
import { Ink } from './field-ink';
import { BenchSnow, BranchSnow, CrownSeason, DeskDrink, Dumplings, FallingThing, GroundSnow, IcedDrink, Magpie, MilkyWay, MoonRabbit,
  OccasionScenery, SantaHat, SeasonHat, SeasonTop, Tangyuan, Tea, WinterScarf } from './FieldOccasions';
import { occasionOf, phaseOf, seasonOf, type DayPhase, type Season } from './occasions';
import { FriendBehind, FriendFront } from './FieldFriend';

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
 * down off the bottom near the far edge of that text. Its outer edges lie well outside any page. The login page
 * measures itself and draws loginLawnPath (login-lawn.ts) instead; this fixed shape is only for before that. */
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
/** The desk halo's paint (outer disc, inner disc) for each pose: the analysis state tints it (tokens in index.css). */
const DESK_HALO_PAINT: Record<FieldPose, [string, string]> = {
  rest: ['--paint-halo-outer', '--paint-halo'],
  waiting: ['--paint-halo-waiting-outer', '--paint-halo-waiting'],
  puzzled: ['--paint-halo-puzzled-outer', '--paint-halo-puzzled'],
};

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
function Silhouette({ pass, season, heart }: { pass: 'stroke' | 'fill'; season: Season; heart?: ReactNode }) {
  const fill = pass === 'fill';
  const paint = fill ? { fill: 'var(--paint-sweater)' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 6.6, strokeLinejoin: 'round' as const };
  const shape = (points: PenPoint[], className?: string) => <path className={className} d={smoothPath(points, true)} />;
  const bare = season === 'summer';
  const forearm = (side: 'l' | 'r', outline = !fill) => <g className={`field-fore-${side}`}>
    <Forearm side={side} a={FOREARMS[side][0]} b={FOREARMS[side][1]} fill={!outline} bare={bare} /></g>;
  const shoulders: Array<['l' | 'r', PenPoint, PenPoint]> = [['l', SHOULDERS.l, [70,42]], ['r', SHOULDERS.r, [156,42]]];
  // The filling of the heart's drawn arms (`heart`) lies where the jointed arms' does, over the body and the outfit at
  // the neck, so the two can take over from each other unseen.
  if (!bare) return <g {...paint}>
    {shape(TORSO)}
    {fill && <><DeskTop season={season} />{heart}</>}
    {shoulders.map(([side, a, b]) => <g key={side} className={`field-upper-${side}`}>{forearm(side)}{shape(limb(a, b, 5.5))}</g>)}
  </g>;
  // A short sleeve (summer) ends halfway down the visible upper arm: below its hem the arm is bare to the elbow.
  const arms = shoulders.map(([side, a, b]) => ({ side, ...shortSleeve(a, b) }));
  if (!fill) return <g {...paint}>
    {shape(TORSO)}
    {arms.map(({ side, sleeve, arm }) => <g key={side} className={`field-upper-${side}`}>{forearm(side)}<path d={sleeve} /><path d={arm} /></g>)}
  </g>;
  // Over the body a bare arm keeps its line (a sleeve merges into the body, a bare arm does not), so the filling pass
  // outlines the bare parts again. Both sleeves come first, so an arm across the chest is in front of the other's
  // shoulder; then for each arm the bare upper arm's line (from its colour's flat end, so it lies on the hem's edge and
  // never on the sleeve) and the forearm's line, the forearm with its hand, and last the bare upper arm's colour, over
  // the forearm's line at the elbow, so no seam shows there.
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 6.6, strokeLinejoin: 'round' as const };
  return <g {...paint}>
    {shape(TORSO)}
    <DeskTop season={season} />
    {heart}
    {arms.map(({ side, sleeve }) => <g key={side} className={`field-upper-${side}`}><path d={sleeve} /></g>)}
    {arms.map(({ side, skin, hem }) => <g key={side} className={`field-upper-${side}`}>
      <g {...line}><path d={skin} /><path d={hem} strokeWidth={HEM_EDGE} />{forearm(side, true)}</g>
      {forearm(side)}
      <path d={skin} fill="var(--paint-skin)" />
    </g>)}
  </g>;
}

/** A forearm from the elbow `a` to the wrist `b`. The filling pass gives it its hand: the mitten first, then the cuff's
 * edge, then the sleeve closing over the wrist, as in the promo film. Inside the forearm group the hand turns with the
 * arm (and on its own at the wrist), and the head and the lid, drawn later, still cover it. */
function Forearm({ side, a, b, fill, inset = 0, bare = false }: { side: 'l' | 'r'; a: PenPoint; b: PenPoint; fill: boolean; inset?: number; bare?: boolean }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, r = 5;
  // A bare forearm (summer) and its hand are one piece: the arm runs on past the wrist and ends in a rounded tip a
  // little wider than itself, outlined and filled like the rest of the arm (two passes), so no line parts them.
  if (bare) {
    const paint = fill ? { fill: 'var(--paint-skin)' } : {};
    return <><path className="field-forearm" d={smoothPath(limb(a, b, BARE), true)} {...paint} />
      <g className={`field-wrist-${side}`}><path className="field-hand" d={handTip(b, [dx, dy])} {...paint} /></g></>;
  }
  if (!fill) return <path d={smoothPath(limb(a, b, 5), true)} />;
  const hand = <g className={`field-wrist-${side}`}><Mitten cx={round(b[0] + dx * 8)} cy={round(b[1] + dy * 8)} inset={inset} /></g>;
  return <>
    {hand}
    <path className="field-cuff" d={cuff(b, [dx, dy], r)} fill="none" stroke="currentColor" strokeWidth={6.6} strokeLinecap="round" />
    <path className="field-forearm" d={smoothPath(limb(a, b, r), true)} />
  </>;
}
/** The cuff's edge round the hand side of the wrist `b` (the forearm pointing along `d`): the line of the sleeve's
 * round end. */
const cuff = (b: PenPoint, [dx, dy]: [number, number], r: number) =>
  `M${round(b[0] - dy * r)} ${round(b[1] + dx * r)}A${r} ${r} 0 0 0 ${round(b[0] + dy * r)} ${round(b[1] - dx * r)}`;

/** Where each forearm runs in the drawing, elbow to wrist (the hands-behind-head drawing). */
const FOREARMS = { l: [[70, 42], [101, 38]], r: [[156, 42], [125, 38]] } as Record<'l' | 'r', [PenPoint, PenPoint]>;
/** Where the upper arms turn, in the body. */
const SHOULDERS: Record<'l' | 'r', PenPoint> = { l: [97, 72], r: [129, 72] };

/**
 * A second copy of one forearm and its hand, drawn above the head, for the moments the hand is at the face (chin on
 * hand, rubbing an eye, covering a yawn). It sits in the same jointed groups as the arm, so it is always exactly on
 * top of it; the motion controller shows it only while that would change nothing (the hand behind the lid, or beside
 * the head), so the hand never jumps between layers. Towards the elbow the copy fades out, so no seam shows where the
 * forearm meets the upper arm, which stays behind; where the elbow stays behind the lid (chin on hand from the
 * keyboard) the copy is drawn whole instead, so the forearm keeps its line down to the lid.
 */
/** The copy's lines are a hair thinner on their outer side, so their soft edges fall on the arm's own solid lines:
 * drawn over the arm it leaves the picture exactly as it was. */
const FRONT_INSET = .6;
function FrontHand({ side, id, bare, children }: { side: 'l' | 'r'; id: string; bare: boolean; children?: ReactNode }) {
  const [a, b] = FOREARMS[side], at = (k: number) => [round(a[0] + (b[0] - a[0]) * k), round(a[1] + (b[1] - a[1]) * k)];
  const [x1, y1] = at(.45), [x2, y2] = at(.75), mask = `${id}-front-${side}`;
  return <g className={`field-upper-${side} field-front field-front-${side}`}><g className={`field-fore-${side}`}>
    {/* The motion controller turns the dark end white to draw the copy whole (its elbow behind the lid). */}
    <linearGradient id={`${mask}-fade`} className="field-front-fade" gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
      <stop offset="0" stopColor="#000" /><stop offset="1" stopColor="#fff" />
    </linearGradient>
    <mask id={mask} maskUnits="userSpaceOnUse" x="-120" y="-120" width="480" height="400">
      <rect x="-120" y="-120" width="480" height="400" fill={`url(#${mask}-fade)`} />
    </mask>
    <g mask={`url(#${mask})`}>
      <g fill="none" stroke="currentColor" strokeWidth={6.6 - FRONT_INSET} strokeLinejoin="round"><Forearm side={side} a={a} b={b} fill={false} bare={bare} /></g>
      <g fill="var(--paint-sweater)"><Forearm side={side} a={a} b={b} fill inset={FRONT_INSET} bare={bare} /></g>
    </g>
    {children}
  </g></g>;
}

/** A round mitten of a hand, a little wider than the cuff, with its colour off the line like the rest. */
function Mitten({ cx, cy, className = 'field-hand', inset = 0 }: { cx: number; cy: number; className?: string; inset?: number }) {
  return <g className={className}>
    <circle cx={cx} cy={cy} r={7} fill="var(--chat-bg, var(--bg))" />
    {/* In a front copy (its line a hair thinner outside) the colour, shifted off the line, still fills all inside the
        line and stops short of its outer edge, so the copy covers the hand exactly. */}
    <circle cx={round(cx - 1.1 * (1 - inset / 12))} cy={round(cy - .8 * (1 - inset / 12))} r={7 - inset / 2} fill="var(--paint-skin)" />
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
import { ARMS_UP, armTurn, DeskMotion, greetAtOpening, HELD_CUP_SHIFT, isOpening, type FieldPose, type FieldMotionHandle, type FigureState } from './field-motion';

const exact = (value: number) => Math.round(value * 100) / 100;
/** The jointed arms straight up (ARMS_UP), where the drawn heart arms take over from them and give back: each arm's
 * elbow and wrist, the way its forearm points (degrees), and how the drawn limbs of its upper arm and forearm bow
 * (limb: the middle of a limb lies .04 of its half-width to one side), turned with them. */
const ARMS_RAISED = Object.fromEntries((['l', 'r'] as const).map(side => {
  const upper = ARMS_UP[`upper-${side}`] as number, turn = armTurn(side, upper, ARMS_UP[`fore-${side}`] as number), a = turn.r * Math.PI / 180;
  const at = ([x, y]: PenPoint): PenPoint => [x * Math.cos(a) - y * Math.sin(a) + turn.x, x * Math.sin(a) + y * Math.cos(a) + turn.y];
  const bow = ([px, py]: PenPoint, [qx, qy]: PenPoint, r: number, deg: number): PenPoint => {
    const len = Math.hypot(qx - px, qy - py), [nx, ny] = [-(qy - py) / len * r * .04, (qx - px) / len * r * .04], t = deg * Math.PI / 180;
    return [nx * Math.cos(t) - ny * Math.sin(t), nx * Math.sin(t) + ny * Math.cos(t)];
  };
  const [elbow, wrist] = FOREARMS[side];
  return [side, { elbow: at(elbow), wrist: at(wrist), angle: Math.atan2(wrist[1] - elbow[1], wrist[0] - elbow[0]) * 180 / Math.PI + turn.r,
    upperBow: bow(SHOULDERS[side], elbow, 5.5, upper), foreBow: bow(elbow, wrist, 5, turn.r) }];
})) as Record<'l' | 'r', { elbow: PenPoint; wrist: PenPoint; angle: number; upperBow: PenPoint; foreBow: PenPoint }>;
/** A limb's middle line from `a` to `b`, its middle `bow` to one side (a parabola), written as one cubic per stop
 * (fractions of the way): the same commands as the curve it is to bend into. */
function limbLine(a: PenPoint, b: PenPoint, stops: number[], [bx, by]: PenPoint): string {
  const at = (k: number): PenPoint => [a[0] + (b[0] - a[0]) * k + 4 * bx * k * (1 - k), a[1] + (b[1] - a[1]) * k + 4 * by * k * (1 - k)];
  const slope = (k: number): PenPoint => [b[0] - a[0] + 4 * bx * (1 - 2 * k), b[1] - a[1] + 4 * by * (1 - 2 * k)];
  const text = ([x, y]: PenPoint) => `${exact(x)} ${exact(y)}`;
  let from = 0, path = `M${text(at(0))}`;
  for (const to of stops) {
    const [p, q] = [at(from), at(to)], [dp, dq] = [slope(from), slope(to)], third = (to - from) / 3;
    path += ` C${text([p[0] + dp[0] * third, p[1] + dp[1] * third])} ${text([q[0] - dq[0] * third, q[1] - dq[1] * third])} ${text(q)}`;
    from = to;
  }
  return path;
}
/** Where the heart's hands rest on top of the head: each wrist and the way its forearm points there, so the mittens
 * (8 past the wrists) meet side by side. */
const HEART_WRISTS: Record<'l' | 'r', [x: number, y: number, dx: number, dy: number]> = { l: [104.2, 17.8, .3, .954], r: [121.8, 17.8, -.3, .954] };
/** Where a short sleeve ends along the upper arm, from the shoulder joint (which sits inside the body) to the elbow:
 * about halfway down the part that shows. */
const HEM = .6;
/** Summer's bare arm (its half-width), well inside the loose short sleeve it comes out of (SLEEVE), and its hand: the
 * arm's own rounded tip, a little wider (HAND), centred where a mitten is (8 past the wrist). */
const BARE = 4;
const SLEEVE = 7.5;
const HAND = 5.4;
/** The hand at the end of a bare forearm with its wrist at `b`, pointing along the unit vector `d`: from the arm's
 * width at the wrist it widens smoothly into the round tip. Its back end lies inside the forearm, so drawn with it
 * (outline pass, then filling) the two are one shape. */
function handTip(b: PenPoint, d: [number, number]): string {
  return handOutline(b, d, BARE, HAND);
}
/** Half an outline's width: below the hem the sleeve's line shows this far as its edge before the bare arm's colour. */
const HEM_EDGE = 3.3;
/** Summer's upper arm from the shoulder `a` to the elbow `b`: the short sleeve, round at the shoulder and cut straight
 * at the hem, and the bare arm from the hem down, round at the elbow. Both are outlined (`sleeve`, `arm`); the
 * bare arm's colour (`skin`) starts below the sleeve's line, which so shows right across the hem as its edge (`hem`
 * draws that edge again across the arm where the sleeve is over the body, whose filling covers the outline pass; the
 * rest of the sleeve merges into the body there, as a sleeve does). */
function shortSleeve(a: PenPoint, b: PenPoint): { sleeve: string; arm: string; skin: string; hem: string } {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
  const along = (k: number): PenPoint => [a[0] + dx * k, a[1] + dy * k], at = (p: PenPoint, k: number) => `${round(p[0] - dy * k)} ${round(p[1] + dx * k)}`;
  const piece = (from: PenPoint, r: number) => `M${at(from, r)}L${at(b, r)}A${r} ${r} 0 0 0 ${at(b, -r)}L${at(from, -r)}Z`;
  const hem = along(HEM * len), r = SLEEVE;
  return { sleeve: `M${at(hem, -r)}L${at(a, -r)}A${r} ${r} 0 0 0 ${at(a, r)}L${at(hem, r)}Z`, arm: piece(hem, BARE), skin: piece(along(HEM * len + HEM_EDGE), BARE),
    hem: `M${at(along(HEM * len + HEM_EDGE / 2), BARE + HEM_EDGE)}L${at(along(HEM * len + HEM_EDGE / 2), -BARE - HEM_EDGE)}` };
}
/** The heart the arms make over the head, in pieces, [straight up, heart]: forearms apart from upper arms. Straight up
 * they lie exactly on the jointed arms in ARMS_UP; in the heart they go up and out from each shoulder, round over the
 * two lobes and in to the wrists resting on top of the head. Each piece has the same commands both ways, so one can
 * bend into the other. */
const HEART_FOREARMS: Array<[string, string]> = (['l', 'r'] as const).map((side): [string, string] => {
  const { elbow, wrist, foreBow } = ARMS_RAISED[side], k = side === 'l' ? 1 : -1, x = (value: number) => exact(113 + (value - 113) * k);
  const [wx, wy, dx, dy] = HEART_WRISTS[side];
  return [limbLine(elbow, wrist, [.667, 1], foreBow),
    `M${x(74)} 28 C${x(76)} 14 ${x(92)} 9 ${x(103)} 15 C${x(103 + .878 * 1.2)} ${exact(15 + .479 * 1.2)} ${exact(wx - dx * 1.2)} ${exact(wy - dy * 1.2)} ${wx} ${wy}`];
});
/** The upper arms, bowed as the long sleeves' limbs are, or straight as summer's short sleeves (`flat`). */
const heartUppers = (flat = false): Array<[string, string]> => (['l', 'r'] as const).map((side, i): [string, string] =>
  [limbLine(SHOULDERS[side], ARMS_RAISED[side].elbow, [1], flat ? [0, 0] : ARMS_RAISED[side].upperBow), ['M97 72 C86 58 72 44 74 28', 'M129 72 C140 58 154 44 152 28'][i]]);
const HEART_UPPERS = heartUppers();
/** Long sleeves' heart arms for their filling, [straight up, heart, width, butt]: the forearms, then each upper arm in
 * two at the hem (as the strokes have always been laid), the lower half flat-ended; each as wide as the jointed arm's
 * part (Silhouette: an upper arm 11, a forearm 10). */
const HEART_PIECES: Array<[string, string, number, boolean]> = [...HEART_FOREARMS.map(([up, heart]): [string, string, number, boolean] => [up, heart, 10, false]),
  ...HEART_UPPERS.flatMap(([up, heart]) => {
    const split = (d: string) => splitCubic(d.match(/-?[\d.]+/g)!.map(Number), HEM).map(cubicPath);
    const [upTop, upLow] = split(up), [heartTop, heartLow] = split(heart);
    return [[upTop, heartTop, 11, false], [upLow, heartLow, 11, true]] as Array<[string, string, number, boolean]>;
  })];
/** Their outlines, [straight up, heart, width]: as wide as the jointed arms' outlines (each part's width and the 6.6
 * line). */
const HEART_LINES: Array<[string, string, number]> = [...HEART_UPPERS.map(([up, heart]): [string, string, number] => [up, heart, 17.6]),
  ...HEART_FOREARMS.map(([up, heart]): [string, string, number] => [up, heart, 16.6])];

/** A one-curve path's two control polygons either side of `t` (de Casteljau). */
function splitCubic(c: number[], t: number): [number[], number[]] {
  const mix = (p: number[], i: number) => [p[i] + (p[i + 2] - p[i]) * t, p[i + 1] + (p[i + 3] - p[i + 1]) * t];
  const [a, b, e] = [mix(c, 0), mix(c, 2), mix(c, 4)], [d, f] = [mix([...a, ...b], 0), mix([...b, ...e], 0)], m = mix([...d, ...f], 0);
  return [[c[0], c[1], ...a, ...d, ...m], [...m, ...f, ...e, c[6], c[7]]];
}
/** The piece of a one-curve path between two places along it, each given as a fraction of its length plus drawing
 * units, so it is cut where a straight arm of the same length would be. */
function cubicPiece(path: string, from: [number, number], to: [number, number]): string {
  const c = path.match(/-?[\d.]+/g)!.map(Number), runs = [0];
  const at = (t: number) => [0, 1].map(k => (1 - t) ** 3 * c[k] + 3 * (1 - t) ** 2 * t * c[k + 2] + 3 * (1 - t) * t * t * c[k + 4] + t ** 3 * c[k + 6]);
  for (let i = 1; i <= 100; i++) { const [p, q] = [at((i - 1) / 100), at(i / 100)]; runs.push(runs[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1])); }
  const tOf = ([k, units]: [number, number]) => {
    const s = k * runs[100] + units, i = runs.findIndex(run => run >= s);
    return s <= 0 ? 0 : i < 0 ? 1 : (i - 1 + (s - runs[i - 1]) / (runs[i] - runs[i - 1])) / 100;
  };
  const [t0, t1] = [tOf(from), tOf(to)], head = t1 < 1 ? splitCubic(c, t1)[0] : c;
  return cubicPath(t0 > 0 ? splitCubic(head, t0 / t1)[1] : head);
}
/** A one-curve path written from its control polygon. */
function cubicPath(c: number[]): string {
  const [x, y, ...rest] = c.map(round);
  return `M${x} ${y} C${rest.join(' ')}`;
}
/** Summer's heart forearms, [straight up, heart]: as HEART_FOREARMS, but running on to the middle of the hand, which is
 * the forearm's own tip (handTip). Straight up they lie exactly on the jointed forearm, elbow to hand. In the heart the
 * two hands meet side by side on top of the head, resting just behind its line. */
const BARE_HEART_FOREARMS: Array<[string, string]> = [
  ['M81.2 34.8 C79.8 28.5 78.5 22.1 77.1 15.7 C75.7 9.3 74.3 2.9 72.9 -3.5', 'M74 28 C76 14 92 9 103 15 C105.5 16.5 107.2 19 108 22'],
  ['M144.8 34.8 C146.2 28.5 147.5 22.1 148.9 15.7 C150.3 9.3 151.7 2.9 153.1 -3.5', 'M152 28 C150 14 134 9 123 15 C120.5 16.5 118.8 19 118 22'],
];
/** The bare hands at the ends of those forearms, [straight up, heart]: where each hand's middle is and the way its
 * forearm points into it. */
const BARE_HEART_HANDS: Array<[[number, number, number, number], [number, number, number, number]]> = [
  [[72.9, -3.5, -8.37, -38.31], [108, 22, .8, 3]], [[153.1, -3.5, 8.37, -38.31], [118, 22, -.8, 3]],
];
/** A bare heart hand's shape at one of those places, drawn about its middle (its group is moved there). */
const bareHeartHand = ([, , dx, dy]: [number, number, number, number]) => {
  const len = Math.hypot(dx, dy), d: [number, number] = [dx / len, dy / len];
  return handTip([round(-d[0] * 8), round(-d[1] * 8)], d);
};
type HeartStroke = [string, string, number, string, 'round' | 'butt'];
/** Summer's heart arms as strokes, [straight up, heart, width, paint, cap], the lines first and then the filling: each
 * upper arm cut where the jointed arm's short sleeve is (shortSleeve), the sleeve's line running on past the hem as
 * its edge and the bare arm's colour starting below that edge, then the forearm (BARE_HEART_FOREARMS). */
const HEART_BARE: { lines: HeartStroke[]; fills: HeartStroke[] } = (() => {
  const piece = (arm: [string, string], from: [number, number], to: [number, number]) => arm.map(path => cubicPiece(path, from, to)) as [string, string];
  const [top, hem, edge, end]: Array<[number, number]> = [[0, 0], [HEM, 0], [HEM, HEM_EDGE], [1, 0]], line = 2 * HEM_EDGE;
  const lines: HeartStroke[] = [], fills: HeartStroke[] = [];
  heartUppers(true).forEach((arm, i) => {
    lines.push([...piece(arm, top, edge), 2 * SLEEVE + line, 'currentColor', 'butt'], [...piece(arm, hem, end), 2 * BARE + line, 'currentColor', 'round'],
      [...BARE_HEART_FOREARMS[i], 2 * BARE + line, 'currentColor', 'round']);
    fills.push([...piece(arm, top, hem), 2 * SLEEVE, 'var(--paint-sweater)', 'butt'], [...piece(arm, edge, end), 2 * BARE, 'var(--paint-skin)', 'butt'],
      [...BARE_HEART_FOREARMS[i], 2 * BARE, 'var(--paint-skin)', 'round']);
  });
  return { lines, fills };
})();
/** Where a heart hand's group puts it, [straight up, heart]: its wrist at the end of its forearm and turned the way
 * that points. Straight up exactly as the jointed hand is; on the way the left hand turns clockwise with its arm,
 * the right one the other way. */
const HEART_HAND_PLACES = Object.fromEntries((['l', 'r'] as const).map(side => {
  const { wrist, angle } = ARMS_RAISED[side], [wx, wy, dx, dy] = HEART_WRISTS[side], k = side === 'l' ? 1 : -1;
  let bent = Math.atan2(dy, dx) * 180 / Math.PI;
  while ((bent - angle) * k < 0) bent += 360 * k;
  while ((bent - angle) * k > 360) bent -= 360 * k;
  const place = (x: number, y: number, deg: number) => `translate(${exact(x)}px, ${exact(y)}px) rotate(${exact(deg)}deg)`;
  return [side, [place(wrist[0], wrist[1], angle), place(wx, wy, bent)]];
})) as Record<'l' | 'r', [string, string]>;
/** A heart hand: the mitten, the cuff's edge and the sleeve's round end closing over it, exactly as the jointed
 * forearm draws them (Forearm), about the wrist with the forearm pointing along x. Only the sleeve's end past the wrist
 * is drawn (`clip`); the rest of the forearm is the drawn arm's. */
function HeartHand({ side, clip }: { side: 'l' | 'r'; clip: string }) {
  const [a, b] = FOREARMS[side], len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, r = 5;
  const past = (along: number, out: number) => `${exact(b[0] + dx * along - dy * out)} ${exact(b[1] + dy * along + dx * out)}`;
  return <g transform={`rotate(${exact(-Math.atan2(dy, dx) * 180 / Math.PI)}) translate(${-b[0]} ${-b[1]})`}>
    <clipPath id={clip}><path d={`M${past(-1.2, 20)}L${past(20, 20)}L${past(20, -20)}L${past(-1.2, -20)}Z`} /></clipPath>
    <Mitten cx={round(b[0] + dx * 8)} cy={round(b[1] + dy * 8)} className="field-heart-mitten" />
    <path d={cuff(b, [dx, dy], r)} fill="none" stroke="currentColor" strokeWidth={6.6} />
    <path d={smoothPath(limb(a, b, r), true)} fill="var(--paint-sweater)" clipPath={`url(#${clip})`} />
  </g>;
}

const heartStroke = ([up, heart, width, paint, cap]: HeartStroke) => <path key={`${up} ${width}`} d={up} data-up={up} data-heart={heart}
  stroke={paint} strokeWidth={width} strokeLinecap={cap} />;
/** Summer's two hands with the heart's arms, outline (`fill` false) or filling: each the tip of its forearm. */
const bareHeartHands = (fill: boolean) => BARE_HEART_HANDS.map(([up, heart]) => {
  const [straight, bent] = [bareHeartHand(up), bareHeartHand(heart)];
  return <g key={up[0]} className="field-heart-hand" data-up={`translate(${up[0]}px, ${up[1]}px)`} data-heart={`translate(${heart[0]}px, ${heart[1]}px)`}>
    <path d={straight} data-up={straight} data-heart={bent}
      {...fill ? { fill: 'var(--paint-skin)' } : { stroke: 'currentColor', strokeWidth: 6.6, strokeLinejoin: 'round' as const }} />
  </g>;
});

/** Runs the desk figure's motion controller (field-motion.ts) and tells it what happens: the state, our project
 * opening (the heart), and the user typing a question (`draft`, the composer's text). The controller holds the
 * drawing's jointed parts, and a change of season draws other ones (summer's bare arms), so then it starts afresh in
 * the new drawing (without greeting again). */
function useDeskMotion(ref: RefObject<SVGSVGElement | null>, pose: FieldPose, own: boolean, draft: string | undefined,
  at: Date | undefined, season: Season, handle?: MutableRefObject<FieldMotionHandle | null>) {
  const motion = useRef<DeskMotion | null>(null);
  const clock = useRef(at);
  clock.current = at;
  const seen = useRef<FigureState | null>(null);
  const greet = useRef(false);
  const dressed = useRef<Season | null>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // Whatever the last controller left written inline on parts this drawing kept goes (it starts from the keyboard).
    svg.querySelectorAll<SVGElement>('.field-front, .field-held-cup, .field-desk-cup, .field-heart-arms, .field-upper-l, .field-upper-r, .field-fore-l, .field-fore-r')
      .forEach(el => { el.style.opacity = ''; });
    svg.querySelectorAll<SVGElement>('.field-front-fade stop').forEach(el => { el.style.stopColor = ''; });
    const created = new DeskMotion(svg, { clock: () => clock.current ?? new Date() });
    motion.current = created;
    if (handle) handle.current = { play: cue => created.play(cue), speed: rate => created.speed(rate) };
    return () => {
      created.destroy();
      motion.current = null;
      if (handle) handle.current = null;
    };
  }, [ref, handle, season]);
  // While the composer holds a question the chair is pulled in to the laptop; it goes back once the text is gone.
  // (Before the state is applied, so a figure that appears with text already there starts pulled in.)
  const attentive = Boolean(draft?.trim());
  useLayoutEffect(() => { motion.current?.setAttentive(attentive); }, [attentive, season]);
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
    // A new drawing for the season sits down in the state it had (React's second run of a mount keeps the greeting).
    const redressed = dressed.current !== null && dressed.current !== season;
    dressed.current = season;
    if (!controller.isStarted) controller.start(pose, greet.current && !redressed);
    else if (changed && (was?.pose !== pose || greet.current)) controller.setPose(pose, greet.current);
  }, [pose, own, season]);
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

/** `friend`: a learning route was finished today, so the friend from the promo film joins the learner (home only). */
/** `lawn` (login page) is where the page's lawn must reach, measured by useLoginLawn. */
export function FieldScene({ className = '', at, friend = false, lawn }: { className?: string; at?: Date; friend?: boolean; lawn?: LawnFrame | null }) {
  return <figure className={`field-scene ${className}`}><FieldIllustration at={at} friend={friend} lawn={lawn} />
    <figcaption aria-label="what-the-repo"><BrandWordmark /></figcaption>
  </figure>;
}

/** Where the desk drink stands: the bottom left of its cup, on the desk right of the laptop, clear of the lid. */
const DESK_CUP: [number, number] = [173, 123.5];

/** Front view at a laptop, with a chair back behind. At rest the hands are on the keyboard behind the lid; while the
 * agent works the learner folds their arms behind their head; when something fails they scratch their head. Now and
 * then they do some small thing (field-motion.ts). */
/** Whether the halo is easing to a new analysis state. Only those changes ease, not a change of theme: the flag is set
 * during the render that brings the new colour, so both reach the page together, and clears once the ease is over. */
function useHaloEasing(pose: FieldPose) {
  const [shown, setShown] = useState(pose);
  const [easing, setEasing] = useState(false);
  if (pose !== shown) { setShown(pose); setEasing(true); }
  useEffect(() => {
    if (!easing) return;
    const timer = window.setTimeout(() => setEasing(false), 1500);
    return () => window.clearTimeout(timer);
  }, [easing, pose]);
  return easing;
}

function FieldDesk({ pose, className, ownRepository, at, draft, motionRef }: {
  pose: FieldPose; className: string; ownRepository: boolean; at?: Date; draft?: string; motionRef?: MutableRefObject<FieldMotionHandle | null>;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const id = `field-desk-${useId().replace(/:/g, '')}`;
  const season = seasonOf(at ?? new Date()), bare = season === 'summer';
  useDeskMotion(ref, pose, ownRepository, draft, at, season, motionRef);
  const easing = useHaloEasing(pose);
  // The tea steams after dark in spring and autumn (the dark theme is always night, see index.css).
  const night = useDayPhase(at) === 'night';
  return <svg ref={ref} className={`field-illustration field-illustration-small field-${pose}${easing ? ' field-desk-easing' : ''} ${className}`} viewBox="0 0 240 150" aria-hidden="true" focusable="false"
    data-season={season} data-night={night || undefined}>
    {/* A small patch of light behind the figure, the same two discs as the bench scene's glow. Its colour follows the
        analysis: soft green while it runs, quiet grey when it failed, the warm glow when done (eased in index.css). */}
    <path className="field-desk-halo" d={DESK_HALO[0]} fill={`var(${DESK_HALO_PAINT[pose][0]})`} />
    <path className="field-desk-halo" d={DESK_HALO[1]} fill={`var(${DESK_HALO_PAINT[pose][1]})`} />
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
        {bare ? <>{HEART_BARE.lines.map(heartStroke)}{bareHeartHands(false)}</>
          : HEART_LINES.map(([up, heart, width]) => <path key={up} d={up} data-up={up} data-heart={heart} stroke="currentColor" strokeWidth={width} />)}
      </g>
      <Silhouette pass="stroke" season={season} />
      <Silhouette pass="fill" season={season} heart={<g className="field-heart-arms" fill="none" strokeLinecap="round">
        {bare ? <>{HEART_BARE.fills.map(heartStroke)}{bareHeartHands(true)}</>
          : HEART_PIECES.map(([up, heart, width, butt]) => <path key={up} d={up} data-up={up} data-heart={heart} stroke="var(--paint-sweater)"
            strokeWidth={width} strokeLinecap={butt ? 'butt' : undefined} />)}
      </g>} />
      <g className="field-head"><g className="field-head-drift"><g className="field-head-sway">
        <Ink points={[[111,29,.85],[101,33,1.2],[97,42,1.1],[100,52,.9],[111,56,1.15],[123,53,.85],[127,43,1.2],[123,33,.9]]} width={3.6} closed fill="var(--chat-bg, var(--bg))"
          paint="var(--paint-skin)" shift={[-1.6, -1.1]} />
        {season === 'winter' && <DeskHat />}
      </g></g></g>
      {/* A hand at the face comes in front of it (shown only then). The right one carries the copy of the cup that is
          in the hand while drinking: in the gripping pose it lies exactly on the desk cup, kept upright at the mitten.
          While the cup is carried the whole forearm is in front, up to the elbow (the arm folds with it, its forearm
          over the upper arm); it comes and goes with the cup, where the elbow is behind the lid. */}
      <FrontHand side="l" id={id} bare={bare} />
      <FrontHand side="r" id={id} bare={bare}>
        <g className="field-held-cup">
          <g fill="none" stroke="currentColor" strokeWidth={6.6 - FRONT_INSET} strokeLinejoin="round"><Forearm side="r" a={FOREARMS.r[0]} b={FOREARMS.r[1]} fill={false} bare={bare} /></g>
          <g fill="var(--paint-sweater)"><Forearm side="r" a={FOREARMS.r[0]} b={FOREARMS.r[1]} fill inset={FRONT_INSET} bare={bare} /></g>
          <g className="field-cup"><g transform={`translate(${HELD_CUP_SHIFT.map(v => round(v * 100) / 100).join(' ')})`}>
            <DeskDrink season={season} at={DESK_CUP} />
          </g></g>
        </g>
      </FrontHand>
      {/* Warm breath blown into cold hands: a small puff that leaves the side of the cupped hands at the mouth, rises
          and drifts a little while it swells and fades (winter, field-motion.ts). */}
      <g transform="translate(122.5 57) scale(1.1) translate(-118 -47)">
        <path className="field-puff" d="M121 46 C118 46.2 117.2 42.6 119.8 41.8 C119.8 38.8 123.6 37.8 125.2 39.9 C127.2 38 130.6 39.6 129.6 42.6 C132 43.6 131 47 128.4 46.8 C127 48.2 123 48.2 121 46 Z"
          fill="var(--paint-breath)" stroke="currentColor" strokeWidth={1.05} strokeLinejoin="round" />
      </g>
      {/* The heart's mittens meet on top of the head, so they come after it, each with its sleeve's end closing over it
          as on the jointed arm (summer's bare hands are their arms' tips, drawn with the arms). */}
      {!bare && <g className="field-heart-arms">
        {(['l', 'r'] as const).map(side => <g key={side} className="field-heart-hand" data-up={HEART_HAND_PLACES[side][0]} data-heart={HEART_HAND_PLACES[side][1]}
          style={{ transform: HEART_HAND_PLACES[side][0] }}>
          <HeartHand side={side} clip={`${id}-heart-cuff-${side}`} /></g>)}
      </g>}
      </g></g>
    </g></g></g></g></g>
    {/* At night (dark theme) the screen behind the lid lights the face and chest, as on the bench. */}
    <ScreenLight id={`${id}-light`} cx={113} cy={58} rx={40} ry={38} />
    {/* A small hand-written question mark, only while puzzled. */}
    <g className="field-puzzle-mark">
      <Ink points={[[161,22],[164,16],[171,15],[174,20],[170,25],[168,30]]} width={2.6} />
      <circle cx="168" cy="36" r="1.7" fill="currentColor" />
    </g>
    {/* We see the plain back of the lid and its thin bottom edge, not the screen or keyboard. */}
    <Ink points={[[69,79,.85],[86,80,1.2],[149,79,.9],[171,81,1.1],[169,98,.85],[166,120,1.2],[148,121,.9],[91,120,1.15],[74,119,.85],[71,98,1.1]]} width={3.3} closed fill="var(--chat-bg, var(--bg))"
      paint="var(--paint-screen)" shift={[-1.8, -1.2]} />
    <Ink points={[[70,122,.85],[89,125,1.1],[149,126,.9],[171,123,1.1]]} width={2.6} />
    {/* The drink on the desk beside the laptop; while it is in the hand only the copy there shows. */}
    <g className="field-desk-cup"><DeskDrink season={season} at={DESK_CUP} /></g>
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

/**
 * The laptop screen's light on the learner, laid over the face and chest under the lid: brightest just above the lid
 * and fading upwards. Its colour is --paint-screen-light, transparent unless the dark theme's night sets it.
 */
function ScreenLight({ id, cx, cy, rx, ry }: { id: string; cx: number; cy: number; rx: number; ry: number }) {
  return <>
    <radialGradient id={id} cx=".5" cy=".85" r=".62">
      <stop offset="0" style={{ stopColor: 'var(--paint-screen-light)' }} />
      <stop offset=".5" style={{ stopColor: 'var(--paint-screen-light)', stopOpacity: .5 }} />
      <stop offset="1" style={{ stopColor: 'var(--paint-screen-light)', stopOpacity: 0 }} />
    </radialGradient>
    <ellipse className="field-screen-light" cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#${id})`} />
  </>;
}

/** The bench learner's head and sweater (bench drawing). */
const BENCH_HEAD: PenPoint[] = [[313,147,.85],[297,150,1.2],[289,162,1.1],[291,178,.9],[304,188,1.2],[323,187,.85],[338,178,1.1],[339,165,1.2],[328,150,.85]];
const BENCH_SWEATER: PenPoint[] = [[305,196,.85],[283,212,1.15],[268,240,.9],[272,272,1.2],[298,293,.85],[352,300,1.1],[381,289,.9],[395,263,1.2],[389,233,.85],[369,211,1.1],[344,198,.9]];
/** The light leaving the bench laptop's whole screen: as wide as the lid's top edge where it leaves it, then opening
 * out over both arms and up past the face. Its foot is hidden behind the lid. */
const BENCH_SCREEN_FAN = 'M236 282 L238 240 L212 118 L424 118 L404 240 L404 282 Z';
/** The same light in the air just above the lid: as wide as the lid where it leaves it, opening a little round the
 * shoulders and head and fading out above them. */
const BENCH_SCREEN_AIR = 'M252 262 L246 240 L220 124 L382 124 L346 244 L340 262 Z';
/** The rear of the bench laptop's lid, which faces us. */
const BENCH_LID: PenPoint[] = [[247,239,.85],[273,241,1.1],[309,243,.9],[343,245,1.2],[343,263,.85],[339,287,1.1],[309,288,.9],[264,284,1.2],[258,266,.85],[252,252,1.1]];
/** Turns the drawn learner into where light can land: its flat colour white, its dark ink line and the empty sky black
 * (luminance above about .25, in sRGB; the ink is about .2, every paint of the learner well above). */
const PAINT_ONLY = '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.551 8.582 .866 0 -2.6';
const BENCH_LIGHT_BOX = { x: 180, y: 90, width: 280, height: 230 };

/**
 * At night the bench laptop's screen, facing the learner, lights them as the desk figure's does (ScreenLight): from
 * the whole width of the lid, brightest just above its top edge and fading with distance, over the face, the chest
 * and both arms. It lands only on the learner's flat colour (`learner` is the id of the drawn learner), so the ink
 * lines stay dark; BenchScreenAir adds the faint light in the air round the lid. Its colour is --paint-screen-light,
 * transparent unless the dark theme's night sets it. Nothing here moves, so it is drawn once.
 */
function BenchScreenLight({ id, learner }: { id: string; learner: string }) {
  const box = BENCH_LIGHT_BOX;
  return <g className="field-screen-light">
    <radialGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" cx={300} cy={246} r={120}
      gradientTransform="translate(300 246) scale(1.3 1.05) translate(-300 -246)">
      <stop offset="0" stopColor="white" />
      <stop offset=".35" stopColor="white" stopOpacity={.72} />
      <stop offset=".7" stopColor="white" stopOpacity={.3} />
      <stop offset="1" stopColor="white" stopOpacity={0} />
    </radialGradient>
    <filter id={`${id}-soft`} filterUnits="userSpaceOnUse" {...box}><feGaussianBlur stdDeviation={12} /></filter>
    <filter id={`${id}-paint`} filterUnits="userSpaceOnUse" {...box} colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values={PAINT_ONLY} />
    </filter>
    <mask id={`${id}-fan`} maskUnits="userSpaceOnUse" {...box}>
      <path d={BENCH_SCREEN_FAN} fill={`url(#${id}-fade)`} filter={`url(#${id}-soft)`} />
    </mask>
    <mask id={`${id}-learner`} maskUnits="userSpaceOnUse" {...box}>
      <use href={`#${learner}`} filter={`url(#${id}-paint)`} />
    </mask>
    <g mask={`url(#${id}-learner)`}><rect {...box} fill="var(--paint-screen-light)" mask={`url(#${id}-fan)`} /></g>
  </g>;
}

/** The bench screen's light in the air round the lid, behind the learner: a faint band rising from the lid's top edge
 * as wide as it, seen beside the shoulders and head and on the bench back, gone well before the far sky. */
function BenchScreenAir({ id }: { id: string }) {
  const box = BENCH_LIGHT_BOX;
  return <g className="field-screen-light">
    <radialGradient id={`${id}-air-fade`} gradientUnits="userSpaceOnUse" cx={298} cy={246} r={120}>
      <stop offset="0" stopColor="white" stopOpacity={.85} />
      <stop offset=".5" stopColor="white" stopOpacity={.42} />
      <stop offset="1" stopColor="white" stopOpacity={0} />
    </radialGradient>
    <filter id={`${id}-air-soft`} filterUnits="userSpaceOnUse" {...box}><feGaussianBlur stdDeviation={9} /></filter>
    <mask id={`${id}-air`} maskUnits="userSpaceOnUse" {...box}>
      <path d={BENCH_SCREEN_AIR} fill={`url(#${id}-air-fade)`} filter={`url(#${id}-air-soft)`} />
    </mask>
    <rect {...box} fill="var(--paint-screen-light)" mask={`url(#${id}-air)`} />
  </g>;
}

/** `at` shows the scene as on another date and time (the gallery uses it); the page itself always shows now. */
/** `draft` (compact figure only) is the chat composer's text: while the user types a question the figure leans in.
 * `motionRef` lets the private gallery trigger each action; the product never passes it. */
export function FieldIllustration({ compact = false, pose = 'rest', className = '', at, ownRepository = false, draft, motionRef, friend = false, lawn }: {
  compact?: boolean; pose?: FieldPose; className?: string; at?: Date; ownRepository?: boolean; draft?: string;
  motionRef?: MutableRefObject<FieldMotionHandle | null>; friend?: boolean; lawn?: LawnFrame | null;
}) {
  if (compact) return <FieldDesk pose={pose} className={className} ownRepository={ownRepository} at={at} draft={draft} motionRef={motionRef} />;
  return <FieldBench className={className} at={at} friend={friend} lawn={lawn} />;
}

function FieldBench({ className, at, friend, lawn }: { className: string; at?: Date; friend: boolean; lawn?: LawnFrame | null }) {
  const phase = useDayPhase(at);
  const glow = `field-glow-${useId().replace(/:/g, '')}`, edges = `${glow}-edges`;
  const now = at ?? new Date();
  const season = seasonOf(now), occasion = occasionOf(now), moon = moonPhase(now);
  // One thing at a time beside the learner: a festival dish, else the season's drink, else tea after dark.
  const benchItem = occasion === 'winter-solstice' ? <Dumplings /> : occasion === 'lantern-festival' ? <Tangyuan />
    : occasion === 'april-fools' ? <Tea upsideDown /> : season === 'summer' ? <IcedDrink /> : <Tea hot={season === 'winter'} />;
  return <svg className={`field-illustration ${className}`} viewBox="0 0 600 440" aria-hidden="true" focusable="false"
    data-season={season} data-phase={phase} data-occasion={occasion ?? undefined} data-friend={friend || undefined}>
    {/* Flat paint behind everything, as in the promo film: a glow of two discs, a lawn with soft shoulders and flat
        contact shadows. Standing alone the lawn is a closed island; on the login page it runs off the page, as a
        small hill in front of a paler far meadow. */}
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
      {lawn && <path className="field-meadow" d={loginMeadowPath(lawn)} fill="var(--paint-meadow)" />}
      <path className="field-lawn" d={lawn ? loginLawnPath(LAWN_MIDDLE, lawn) : LAWN_OPEN} fill="var(--paint-lawn)" />
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
    {/* The light theme's night keeps a soft pale glow round the learner (--paint-screen-glow); the dark night has none,
        its screen lights only the learner (BenchScreenLight). */}
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
    {/* On the day a route was finished, the friend stands behind the bench (FieldFriend.tsx). */}
    {friend && <FriendBehind season={season} />}
    {/* The bench remains one simple background shape, with clear space below the seat. */}
    <Ink points={[[246,207,.85],[308,209,1.1],[371,206,.9],[443,208,1.15],[444,231,.85],[367,230,1.15],[305,233,.9],[245,230,1.1]]} width={3.8} closed
      fill="var(--bg)" paint="var(--paint-bench)" />
    {season === 'winter' && <BenchSnow />}
    {friend && <FriendFront season={season} />}
    <Ink points={[[256,233,.8],[257,288,1.1]]} width={3.3} />
    <Ink points={[[430,231,.8],[427,290,1.1]]} width={3.3} />
    <Ink points={[[232,291,.85],[295,290,1.1],[365,293,.9],[457,291,1.15],[459,304,.85],[379,307,1.1],[296,304,.9],[232,305,1.1]]} width={3.8} closed
      fill="var(--bg)" paint="var(--paint-bench)" />
    <Ink points={[[253,308,.8],[250,339,1.1],[253,373,.75]]} width={3.8} />
    <Ink points={[[435,308,.8],[435,340,1.1],[438,373,.75]]} width={3.8} />
    {/* At night the screen's light in the air round the lid, behind the learner. */}
    <BenchScreenAir id={`${glow}-light`} />
    {/* The learner round the lid, which the screen's light falls on (BenchScreenLight). */}
    <g id={`${glow}-learner`}>
    {/* Broad sleeves and roomy trouser shapes, without narrow wrists or separate shoes. */}
    <Ink points={[[345,288,.85],[375,301,1.15],[385,325,.9],[386,347,1.1],[382,368,.85],[364,371,1.1],[343,368,.9],[341,344,1.15],[334,316,.85]]} width={5.2} closed
      fill="var(--bg)" paint="var(--paint-trousers)" />
    <Ink points={[[297,291,.85],[323,298,1.15],[336,313,.9],[334,338,1.1],[331,369,.85],[312,372,1.15],[289,369,.9],[285,345,1.1],[280,322,.85],[279,308,1.15]]} width={5.4} closed
      fill="var(--bg)" paint="var(--paint-trousers)" />
    {/* Summer's tee (SeasonTop) has a body and arms of its own. */}
    {season !== 'summer' && <Ink points={BENCH_SWEATER} width={5.5} closed fill="var(--bg)" paint="var(--paint-sweater)" />}
    <SeasonTop season={season} />
    {/* The head stays a blank shape. */}
    <Ink points={BENCH_HEAD} width={4.8} closed fill="var(--bg)" paint="var(--paint-skin)" />
    {season === 'winter' && <WinterScarf />}
    {occasion === 'christmas' ? <SantaHat /> : <SeasonHat season={season} />}
    {season !== 'summer' && <>
      <Ink points={[[291,221,.85],[280,244,1.15],[285,260,.9]]} width={4.6} />
      {/* The left hand (on our right) keeps only its inner edge; the torso already draws its outside. */}
      <Ink points={[[350,232,.9],[358,250,1.1],[352,261,.85],[332,260,1.15],[327,276,.9],[337,286,1.1],[366,290,.85],[380,287,.9]]} width={5.1} />
    </>}
    </g>
    {/* At night (dark theme) the screen, on the person's side of the lid, lights their face and chest. */}
    <BenchScreenLight id={`${glow}-light`} learner={`${glow}-learner`} />
    {/* The plain rear of the lid faces us; the screen and hands are on the person's side. */}
    <Ink points={BENCH_LID} width={4.2} closed fill="var(--panel)" paint="var(--paint-screen)" />
    <Ink points={[[258,289,.85],[298,293,1.1],[341,292,.85]]} width={3.1} />
    {benchItem}
    </g>
    {/* By day a breeze; at night (always in dark mode) the same corner holds tonight's moon and a few stars instead. */}
    {/* The friend's head stands where the breeze and the lowest star are, so with the friend they move up and right. */}
    <g className="field-day" transform={friend ? 'translate(36 -32)' : undefined}>
      {BREEZE.map((points, i) => <g key={i} className={i ? 'field-breeze field-breeze-second' : 'field-breeze'}>
        <Edge d={smoothPath(points)} width={5.2} mask={edges} />
        <Ink points={points} width={2.4} color="var(--accent)" />
      </g>)}
    </g>
    {/* The moon is the glow behind the scene (HaloMoon); the night corner keeps the stars. */}
    <g className="field-night" color="var(--moon)">
      {occasion === 'qixi' && <MilkyWay />}
      <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" transform={friend ? 'translate(30 -20)' : undefined}>
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
      {occasion === 'qixi' && <Magpie benchTaken={friend} />}
    </g>
  </svg>;
}
