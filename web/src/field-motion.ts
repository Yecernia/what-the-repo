/**
 * The small desk figure's motion (FieldDesk in FieldIllustration.tsx). Two layers:
 *
 * - An ambient base that never stops (wrapper groups of their own): breathing, a slow irregular drift of the head, and
 *   while waiting the old unhurried lean, rock and head loops. Each is a looping Web Animation; when the state changes
 *   a loop eases back to rest from wherever it is before the next one starts.
 * - Actions on the jointed parts, played by one controller per figure: each move is a set of Web Animations created
 *   together, starting from wherever the parts are and ending in a defined pose. A new move first reads the parts where
 *   they are, writes that inline and cancels what ran, all in one task, so no frame can show a pose off the path.
 *
 * Actions follow one another like a person's would (see nextIdle): real durations, short gaps, and some chained (after
 * a long lean back the figure often stretches). Nothing in the stylesheet animates these parts.
 */
import { between } from './field-wander';
import { phaseOf, seasonOf, type Season } from './occasions';

export type FieldPose = 'rest' | 'waiting' | 'puzzled';

/** The jointed groups, outermost first; each arm and forearm exists twice (outline pass and filling pass). `lean`
 * reclines the figure and chair together about the hips (the backrest reclines with the body). A `wrist` turns the
 * mitten about the end of its forearm; `cup` turns the cup in the hand about the mitten (it keeps the cup upright). */
const PARTS = ['lean', 'rock', 'stretch-body', 'head', 'upper-l', 'fore-l', 'wrist-l', 'upper-r', 'fore-r', 'wrist-r', 'cup'] as const;
type Part = typeof PARTS[number];
/** A part's transform: translate (px), then rotate (deg) and scale (`sy` squashes it vertically on top), about the
 * transform-origin the stylesheet gives it. */
interface Turn { x: number; y: number; r: number; s: number; sy: number }
type Pose = Record<Part, Turn>;
/** A pose given by the parts that differ from the default; a number is a turn. */
type Shape = Partial<Record<Part, number | Partial<Turn>>>;
/** A step of a move: where it is (0–1 of the move), what the parts do there, and the easing of the way there. */
type Key = [at: number, shape: Shape, easing?: string];
/** A hand shown in front of the face during a move: its front copy appears at `on` and goes at `off` (0–1 of the move),
 * both moments where the hand is behind the lid or beside the head, so the switch cannot be seen. It fades in and out
 * over `ramp` (0–1 of the move), FRONT_FADE_MS unless said. `whole`: the copy is
 * drawn whole, down to the elbow, instead of fading out towards it, while the elbow is behind the lid: all the while
 * (true), or from `on` to `off` (0–1 of the move), both moments where the two differ only behind the lid. */
interface Front { side: 'l' | 'r'; on: number; off: number; ramp?: number; whole?: true | { on: number; off: number } }
/** A move: its steps, then back to its end pose (the base pose of the state unless said otherwise). `cup` lists the
 * moments (0–1) the cup changes hands: taken from the desk (true) or set down there (false). `puffs` are the moments a
 * breath puff leaves the hands. `calm` stills the waiting drift and rock for the move (a cup is handled steadily). */
interface Motion { ms: number; keys: Key[]; end?: string; fronts?: Front[]; cup?: Array<[at: number, held: boolean]>; puffs?: number[]; calm?: true; away?: Away[] }
/** A forearm left out of the drawing from `on` to `off` (0–1 of the move): it turns over behind the lid, which the
 * flat drawing could only show poking up above the lid's top. Both moments are where all of it is behind the lid, so
 * nothing visible changes. */
interface Away { side: 'l' | 'r'; on: number; off: number }

/** How long a front copy fades in or out (ms) where its move gives no `ramp` of its own: a few frames, however long
 * the move. */
export const FRONT_FADE_MS = 40;
/** How long both copies of the cup show when it changes hands (ms), in the gripping pose where they lie on each other:
 * longer than the hand's front copy (which carries the cup in the hand) takes to fade in, so the cup in the hand is
 * whole before the desk cup goes. */
export const CUP_OVERLAP_MS = 60;

const STILL: Turn = { x: 0, y: 0, r: 0, s: 1, sy: 1 };
function pose(shape: Shape): Pose {
  return Object.fromEntries(PARTS.map(part => [part, change(STILL, shape[part])])) as Pose;
}
function change(turn: Turn, value: Shape[Part]): Turn {
  return value === undefined ? turn : typeof value === 'number' ? { ...turn, r: value } : { ...turn, ...value };
}

/** At the keyboard: upper arms down behind the lid, forearms reaching forward to the keys, hands low behind the lid. */
const REST_ARMS: Shape = { 'upper-l': -120, 'fore-l': 104, 'upper-r': 120, 'fore-r': -104 };
/** Waiting is relaxed: a little reclined, hands folded behind the head (the drawing itself). */
const WAIT_LEAN = .97;
const BASE: Record<FieldPose, Pose> = {
  rest: pose(REST_ARMS),
  waiting: pose({ lean: { sy: WAIT_LEAN } }),
  // One hand behind the head (it scratches there), the other at the keyboard, head tilted.
  puzzled: pose({ head: 5, 'upper-r': 120, 'fore-r': -104 }),
};
/** While the composer holds a question (at rest), the chair is pulled in to the laptop: figure and chair come closer
 * (bigger), on a group of their own (`.field-pull`), so every action plays on at that distance. */
const PULLED_IN = 1.09;
/** Arms straight up beside the head (where the drawn heart arms take over). */
export const ARMS_UP: Shape = { 'upper-l': 19, 'fore-l': -114, 'upper-r': -19, 'fore-r': 114 };
/** On the way between the keyboard and the head: elbows out to the sides, hands beside the face. */
const ELBOWS_OUT: Shape = { 'upper-l': -61, 'fore-l': 25, 'upper-r': 61, 'fore-r': -25 };
/** On the way from the keyboard up overhead: hands out wide, then up. */
const REACH_LOW: Shape = { 'upper-l': -90, 'fore-l': 20, 'upper-r': 90, 'fore-r': -20 };
const REACH_HIGH: Shape = { 'upper-l': -30, 'fore-l': -60, 'upper-r': 30, 'fore-r': 60 };

/** The arm's joints in the drawing (FOREARMS and Mitten in FieldIllustration.tsx, the pivots in index.css): shoulder,
 * elbow and the centre of the mitten, with the arm as drawn (hands behind the head). */
const JOINTS = {
  l: { shoulder: [97, 72], elbow: [70, 42], hand: [108.9, 37] },
  r: { shoulder: [129, 72], elbow: [156, 42], hand: [117.1, 37] },
} as const;
const turned = ([x, y]: readonly number[], deg: number): [number, number] => {
  const a = deg * Math.PI / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};
/** Where a mitten's centre is with its arm turned so (drawing units, before the body's own moves); `short` is how far
 * the upper arm is foreshortened (its forearm scaled back by as much, so only the upper arm is shorter). */
export function handAt(which: 'l' | 'r', upper: number, fore: number, short = 1): [number, number] {
  const { shoulder: s, elbow: e, hand: h } = JOINTS[which];
  const [ex, ey] = turned([(e[0] - s[0]) * short, (e[1] - s[1]) * short], upper), [hx, hy] = turned([h[0] - e[0], h[1] - e[1]], upper + fore);
  return [s[0] + ex + hx, s[1] + ey + hy];
}
/** How a forearm group (with its hand) lies with its arm turned so: turned by `r` degrees and shifted by `x`, `y`, so
 * a point p of the drawing goes to R(r)·p + (x, y). For copies drawn elsewhere that must lie exactly on it. */
export function armTurn(which: 'l' | 'r', upper: number, fore: number): { r: number; x: number; y: number } {
  const { shoulder: s, elbow: e } = JOINTS[which];
  const [ex, ey] = turned([e[0] - s[0], e[1] - s[1]], upper), [rx, ry] = turned([e[0], e[1]], upper + fore);
  return { r: upper + fore, x: s[0] + ex - rx, y: s[1] + ey - ry };
}
/** The drinking arm (upper, fore and, if it is foreshortened, how short the upper arm is), the cup in its hand kept
 * upright (or tilted by `tilt`): turned back by as much as the arm turns it. The scale is always named, so a step
 * that does not shorten the arm brings it back to its length. */
const cupArm = ([upper, fore, short = 1]: readonly number[], tilt = 0): Shape =>
  ({ 'upper-r': { r: upper, s: short }, 'fore-r': { r: fore, s: 1 / short }, cup: tilt - upper - fore });

const side = <T extends Shape>(shape: T, which: 'l' | 'r'): Partial<T> =>
  Object.fromEntries(Object.entries(shape).filter(([part]) => part.endsWith(`-${which}`))) as Partial<T>;
/** The same shape for the other side: arms swap and every turn and sideways shift reverses. */
function mirror(shape: Shape): Shape {
  const out: Shape = {};
  for (const [part, value] of Object.entries(shape) as Array<[Part, Shape[Part]]>) {
    const other = (part.endsWith('-l') ? part.replace(/-l$/, '-r') : part.endsWith('-r') ? part.replace(/-r$/, '-l') : part) as Part;
    out[other] = typeof value === 'number' ? -value : value && { ...value, ...(value.r !== undefined && { r: -value.r }), ...(value.x !== undefined && { x: -value.x }) };
  }
  return out;
}
const mirrored = (motion: Motion, flip: boolean): Motion => flip ? {
  ...motion, keys: motion.keys.map(([at, shape, easing]) => [at, mirror(shape), easing]),
  fronts: motion.fronts?.map(front => ({ ...front, side: front.side === 'l' ? 'r' : 'l' })),
  away: motion.away?.map(span => ({ ...span, side: span.side === 'l' ? 'r' : 'l' })),
} : motion;
/** The arms as they are in a pose, to keep them there through a step. */
const armsOf = (now: Pose): Shape => Object.fromEntries((['upper-l', 'fore-l', 'upper-r', 'fore-r'] as const).map(part => [part, now[part].r]));
const armDown = (now: Pose, which: 'l' | 'r') => which === 'l' ? now['upper-l'].r < -85 : now['upper-r'].r > 85;

/** A move written as a list of steps, each with the time it takes to get there (ms), then `back` ms to the end pose.
 * `at(i)` gives where step i ends (0–1), for the moments a front hand comes and goes. */
type Step = [ms: number, shape: Shape, easing?: string];
function timeline(steps: Step[], back: number, end = 'ease-in-out') {
  const ms = steps.reduce((sum, [step]) => sum + step, 0) + back;
  let t = 0;
  const keys = steps.map(([step, shape, easing]): Key => { t += step; return [t / ms, shape, easing]; });
  return { ms, keys, end, at: (i: number) => keys[i][0], time: (msAt: number) => msAt / ms };
}

export type IdleAction = 'chin' | 'lean-back' | 'lean-back-left' | 'lean-back-right' | 'nod' | 'look-aside' | 'stretch'
  | 'yawn' | 'rub-eye' | 'rock' | 'drink' | 'rub-hands';
/** What the gallery can ask for: every idle action and gesture; `chin-long` is the full chin hold, `chin` a short one. */
export type FieldCue = IdleAction | 'chin-long' | 'wave' | 'lean-in' | 'heart';
/** The drink beside the laptop (FieldIllustration.tsx): iced in summer, tea otherwise, and `hot` while it steams. */
export type DeskDrink = 'iced' | 'tea' | 'hot';

/** The small things the figure does, by state. Weights are relative; night-only ones need the local night (phaseOf,
 * 19–05), seasonal ones the season the outfit shows. Waiting is boring, so leaning back in the chair (three ways)
 * dominates there. At rest about one action in six is a sip from the cup, and in winter one in ten warming the hands. */
export const IDLE_ACTIONS: Record<'rest' | 'waiting', Array<{ id: IdleAction; weight: number; night?: true; season?: Season }>> = {
  rest: [
    { id: 'chin', weight: 5 }, { id: 'look-aside', weight: 5 }, { id: 'lean-back', weight: 2 },
    { id: 'lean-back-left', weight: 1 }, { id: 'lean-back-right', weight: 1 }, { id: 'nod', weight: 3 }, { id: 'stretch', weight: 1 },
    { id: 'yawn', weight: 2, night: true }, { id: 'rub-eye', weight: 1.5, night: true },
    { id: 'drink', weight: 3.6 }, { id: 'rub-hands', weight: 2.4, season: 'winter' },
  ],
  waiting: [
    { id: 'lean-back', weight: 5 }, { id: 'lean-back-left', weight: 4 }, { id: 'lean-back-right', weight: 4 }, { id: 'rock', weight: 3 },
    { id: 'look-aside', weight: 3 }, { id: 'stretch', weight: 1 }, { id: 'yawn', weight: 2, night: true },
    { id: 'drink', weight: 1 }, { id: 'rub-hands', weight: .8, season: 'winter' },
  ],
};
/** What sometimes comes next, and how often: after a long lean back the figure sits up and stretches; after a stretch
 * it leans back; at night a yawn is followed by rubbing an eye; cold hands warmed, a sip of the hot tea. A follow-up
 * comes after a natural pause (chainGap). */
export const FOLLOW_UPS: Record<'rest' | 'waiting', Partial<Record<IdleAction, Array<[IdleAction, number]>>>> = {
  rest: {
    'lean-back': [['stretch', .22]], 'lean-back-left': [['stretch', .22]], 'lean-back-right': [['stretch', .22]],
    stretch: [['lean-back', .2]], yawn: [['rub-eye', .3]], chin: [['nod', .1]], 'rub-hands': [['drink', .2]],
  },
  waiting: {
    stretch: [['lean-back', .2]], yawn: [['lean-back', .15]],
    'lean-back': [['rock', .1]], 'lean-back-left': [['rock', .1]], 'lean-back-right': [['rock', .1]], 'rub-hands': [['drink', .2]],
  },
};
const family = (id: IdleAction) => id.startsWith('lean-back') ? 'lean-back' : id;

/** Still for 2–3 s after appearing (or settling into a new state), before the first small action. */
export const firstPause = (random: () => number = Math.random) => between(2000, 3000, random);
/** Between one action's end and the next one's start. At rest 8–16 s, mostly 8–12 s (65%); waiting is restless,
 * 3–8 s. */
export function idleGap(state: 'rest' | 'waiting', random: () => number = Math.random) {
  if (state === 'waiting') return between(3000, 8000, random);
  return random() < .65 ? between(8000, 12_000, random) : between(12_000, 16_000, random);
}
/** The natural pause before a chained follow-up. */
export const chainGap = (random: () => number = Math.random) => between(1500, 3000, random);
/** Puzzled: short bursts of scratching the head, a few seconds apart. */
const scratchGap = (random: () => number) => between(1800, 4200, random);

/** The next action and the wait before it: sometimes the natural follow-up of the last one, otherwise a weighted pick.
 * Night-only actions only at night, seasonal ones only in their season; never the same action (or lean) twice in a
 * row. While the chair is pulled in (`pulled`) the cup stays where it is. */
export function nextIdle(state: 'rest' | 'waiting', { night, season, pulled = false, last, random = Math.random }:
  { night: boolean; season?: Season; pulled?: boolean; last: IdleAction | null; random?: () => number }): { id: IdleAction; gap: number } {
  const allowed = (id: IdleAction) => {
    const action = IDLE_ACTIONS[state].find(item => item.id === id);
    return Boolean(action) && (night || !action!.night) && (!action!.season || action!.season === season)
      && !(pulled && id === 'drink') && (!last || family(id) !== family(last));
  };
  if (last) {
    let roll = random();
    for (const [id, odds] of FOLLOW_UPS[state][last] ?? []) {
      if ((roll -= odds) < 0) {
        if (allowed(id)) return { id, gap: chainGap(random) };
        break;
      }
    }
  }
  const choices = IDLE_ACTIONS[state].filter(action => allowed(action.id));
  let roll = random() * choices.reduce((sum, action) => sum + action.weight, 0);
  let id = choices[choices.length - 1].id;
  for (const action of choices) if ((roll -= action.weight) < 0) { id = action.id; break; }
  return { id, gap: idleGap(state, random) };
}

/** The heart for our own repository: always the first time this browser shows the figure for it, after that about
 * one opening in three. */
export const HEART_SEEN_KEY = 'what-the-repo.desk-heart-seen';
export const HEART_ODDS = 1 / 3;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function greetAtOpening(storage: Store | null, random: () => number = Math.random): boolean {
  let seen = true;
  try { seen = storage ? storage.getItem(HEART_SEEN_KEY) === '1' : true; } catch { /* unreadable storage: treat as seen */ }
  if (!seen) {
    try { storage?.setItem(HEART_SEEN_KEY, '1'); } catch { /* the heart still plays this once */ }
    return true;
  }
  return random() < HEART_ODDS;
}

export interface FigureState { pose: FieldPose; own: boolean }
/** The figure appears for our project: it is shown for it (mounted, or the project changed to it), or an analysis
 * starts for it. A failed analysis is no moment for a heart; any other change is not an opening. */
export function isOpening(was: FigureState | null, now: FigureState): boolean {
  if (!now.own || now.pose === 'puzzled') return false;
  if (!was || !was.own) return true;
  return now.pose === 'waiting' && was.pose !== 'waiting';
}

/**
 * The left hand at the face (mirrored for the right), in front of it. `visit` is the time at the face, where the
 * forearm comes up from an elbow low on its own side behind the lid. From the keyboard the hand rises from behind the
 * lid (by way of `lead`), where its front copy is switched on unseen, and goes back there (by way of `leave`) before it
 * is switched off; the copy is drawn whole, down to the elbow, which stays behind the lid all the way. From behind the
 * head it first comes out beside the head, clear of it, where the copy is switched on (over a few frames), then down
 * beside the jaw, the elbow dropping behind the lid, and in from there; the copy fades towards the elbow while the
 * elbow shows and is drawn whole from beside the jaw. Either way the hand stays on its own side of the face.
 */
function faceMotion(fromKeyboard: boolean, visit: Step[], back = 900,
  { lead = [[300, leftArm(LOW), 'ease-in']], leave = [[350, leftArm(LOW), 'ease-in-out']] }: { lead?: Step[]; leave?: Step[] } = {}): Motion {
  // Every step names how long the upper arm is drawn (its full length unless said), so an arm drawn shorter never
  // carries over into a step that does not say so.
  const full = (shape: Shape): Shape => Object.fromEntries(Object.entries(shape).map(([part, value]) =>
    [part, typeof value === 'number' && (part === 'upper-l' || part === 'fore-l') ? { r: value, s: 1 } : value]));
  // The hand stays at the face for the whole visit: every step names the arm (as the last step that moved it left
  // it), so the body and head can finish what they do before the hand goes.
  let arm: Shape = {};
  visit = visit.map(([ms, shape, easing]): Step => {
    arm = { ...arm, ...side(full(shape), 'l') };
    return [ms, { ...full(shape), ...arm }, easing];
  });
  if (fromKeyboard) {
    const line = timeline([...lead.map(([ms, shape, easing]): Step => [ms, full(shape), easing]), ...visit, ...leave], back);
    return { ...line, fronts: [{ side: 'l', on: line.time(30), off: 1 - line.time(60), whole: true }] };
  }
  const out = full(side(HANDS_OUT, 'l')), down = leftArm(BESIDE_JAW);
  const line = timeline([[600, out, 'ease-in'], [550, down, 'linear'], ...visit, [550, down, 'ease-in'], [600, out, 'linear']], 700);
  // Beside the jaw the copy's fading part is behind the lid, so there it turns whole, and back, unseen.
  const steps = visit.length + 4;
  return { ...line, fronts: [{ side: 'l', on: line.at(0), off: line.at(steps - 1), ramp: line.time(260), whole: { on: line.at(1), off: line.at(steps - 2) } }] };
}

/** The right arm on its way with the cup (upper, fore; the mitten's centre in the comment). From the keyboard the hand
 * slides out past the lid's right side at the cup's height (after the forearm turned over unseen, TUCK); lifted, the
 * cup rises beside the lid until it is clear of it and comes in over it, the elbow going out to the right side, so the
 * arm stays on the cup's side and never crosses the chest. */
const CUP_ARM = {
  grip: [103.8, 81.6], // 190, 114: behind the cup's right side, round its handle
  top: [81.4, 47.4], // 191, 67: beside the lid, the cup just clear above its top
  over: [86.7, -4.8], // 160, 58: right of the chest, the elbow low beside the lid
  straw: [80.5, -35], // 139.3, 62.4: the cup tilted towards the face, its straw at the mouth
  // A mug is drunk from with the upper arm pointing at the viewer: from the front it is foreshortened,
  // so the forearm runs from the mug down, leaning a little out, behind the lid's top, where the elbow stays. The
  // flat drawing cannot turn the upper arm towards us, so it is shortened instead (third value; it is all over the
  // body or behind the lid then) and its forearm scaled back by as much.
  near: [131.6, -62.9, .551], // 122, 56: the mug just under the mouth, the elbow at 131.5, 94
  nearSip: [131.4, -62.8, .451], // 121.6, 52: the mug's rim at the mouth, the elbow at 131, 90
} as const;
/** The right hand low behind the lid with the elbow in (upper, fore). Between the keyboard and here the forearm turns
 * over, which the flat drawing could only show above the lid, so it is left out meanwhile (Away); from here the hand
 * slides out past the lid's right side. */
const TUCK = [164.9, 7.7] as const; // 150, 108
/** The left arm (upper, fore, how short the upper arm is drawn) with the mitten's centre at `hand` and the forearm
 * running down from it to an elbow low in front of the body, leaning `slant` degrees from vertical out to the arm's
 * own side. As with the mug (CUP_ARM.near) the upper arm then points at the viewer, so it is drawn shortened to reach
 * that elbow and its forearm scaled back by as much. The turn of the upper arm is the one nearest the keyboard's. */
function handUp(hand: readonly [number, number], slant: number): [number, number, number] {
  const { shoulder: s, elbow: e, hand: h } = JOINTS.l, a = slant * Math.PI / 180;
  const fore = Math.hypot(h[0] - e[0], h[1] - e[1]), elbow = [hand[0] - fore * Math.sin(a), hand[1] + fore * Math.cos(a)];
  const deg = (x: number, y: number) => Math.atan2(y, x) * 180 / Math.PI, near = (value: number, to: number) => value - 360 * Math.round((value - to) / 360);
  const upper = near(deg(elbow[0] - s[0], elbow[1] - s[1]) - deg(e[0] - s[0], e[1] - s[1]), REST_ARMS['upper-l'] as number);
  const short = Math.hypot(elbow[0] - s[0], elbow[1] - s[1]) / Math.hypot(e[0] - s[0], e[1] - s[1]);
  return [upper, near(deg(hand[0] - elbow[0], hand[1] - elbow[1]) - deg(h[0] - e[0], h[1] - e[1]) - upper, 0), short];
}
/** That arm as a shape, `upper` and `fore` degrees off it; the scale is always named (see cupArm). */
const leftArm = ([upper, fore, short]: readonly number[], dUpper = 0, dFore = 0): Shape =>
  ({ 'upper-l': { r: upper + dUpper, s: short }, 'fore-l': { r: fore + dFore, s: 1 / short } });
/** Chin on hand (left arm; the right mirrors): the cheek rests on the mitten at the side of the jaw, on the arm's own
 * side, and the forearm leans down and out from it in front of the chest to the elbow on the desk, behind the lid. */
const CHIN_ARM = handUp([101, 57], 30); // the elbow at 81.4, 91
const chinArm = (upper = 0, fore = 0): Shape => leftArm(CHIN_ARM, upper, fore);
/** A yawn covered by the left mitten (just left of the mouth's middle) and an eye rubbed by it: the forearm comes up
 * from an elbow low on its own side behind the lid, so it never crosses the face. */
export const MOUTH: readonly [number, number] = [111.5, 52.5];
export const EYE: readonly [number, number] = [105.5, 49.5];
const YAWN_ARM = handUp(MOUTH, 18); // the elbow at 99.4, 89.8
const EYE_ARM = handUp(EYE, 17); // the elbow at 94, 87
/** From the keyboard the left hand first goes low behind the lid towards the middle (LOW, hidden), so it comes up on
 * its own side of the face; on the way to the mouth it rises by RISE, the elbow following in. */
const LOW = [-112.5, 87.5, 1] as const; // 112.8, 87.5: the elbow at 79.6, 108.4
const RISE = handUp([112, 68], 34.5); // the elbow at 89.8, 100.3
/** From behind the head the left hand comes down beside the jaw (clear of it), the elbow behind the lid's left part. */
const BESIDE_JAW = handUp([92, 64], 15); // the elbow at 81.9, 101.9
/** The copy of the cup in the hand is drawn this far from the desk cup, so that in the gripping pose it lies exactly on
 * it (FieldIllustration.tsx). The cup stands on the desk right of the laptop and the right arm (the figure's left
 * hand) drinks; the hand takes it from behind, at its right side round the handle, so only the edge of the mitten
 * shows beside it. */
export const HELD_CUP_SHIFT: [number, number] = (() => {
  const [x, y] = handAt('r', ...CUP_ARM.grip);
  return [JOINTS.r.hand[0] - x, JOINTS.r.hand[1] - y];
})();
/** Warming the hands: rubbed together in front of the chest, then cupped at the mouth (left arm; the right mirrors). */
const RUB_ARM = { 'upper-l': -172.5, 'fore-l': 71.5 };
const RUB_UP = { 'upper-l': -178.9, 'fore-l': 73.1 };
const RUB_DOWN = { 'upper-l': -165, 'fore-l': 70.1 };
const BLOW_ARM = { 'upper-l': -197, 'fore-l': 81 };
const BLOW_IN = { 'upper-l': -198.5, 'fore-l': 81.6 };
const both = (shape: Shape): Shape => ({ ...shape, ...mirror(shape) });
/** Both hands out beside the head, clear of it and of the body (77.8, 40.3 and its mirror). */
const HANDS_OUT = both({ 'upper-l': -50, 'fore-l': 0 });

/** A sip from the cup on the desk with the right hand, the other hand staying where it is. Hot tea is blown on first
 * and sipped with the head tipping a little back; iced is sipped through its straw. The body sits up a touch while the
 * cup is up, and is back before the hand sets it down; every step names all it holds. */
function drinkMotion(rest: boolean, drink: DeskDrink, rnd: (low: number, high: number) => number): Motion {
  const other: Shape = rest ? side(REST_ARMS, 'l') : { 'upper-l': 0, 'fore-l': 0 };
  const held = (rise = 0, head: Partial<Turn> = {}): Shape => ({ 'stretch-body': { y: -rise }, head: { y: 0, sy: 1, r: 0, ...head } });
  const at = (arm: readonly number[], tilt = 0, body: Shape = held()): Shape => ({ ...other, ...cupArm(arm, tilt), ...body });
  // A mug is brought up with the elbow low in front of the body (CUP_ARM.near), from the keyboard or from behind the
  // head alike; the elbow is never raised to the face.
  const blow = CUP_ARM.near, sip = CUP_ARM.nearSip;
  // From the keyboard the forearm first turns over unseen behind the lid, then the hand slides out past its side to
  // the cup; from behind the head it comes out beside the face and down beside the lid.
  const reach: Step[] = rest ? [[rnd(380, 440), at(TUCK), 'ease-in-out'], [rnd(480, 560), at(CUP_ARM.grip), 'ease-out']]
    : [[550, at([61, -25]), 'ease-in-out'], [420, at(CUP_ARM.top), 'ease-in'], [320, at(CUP_ARM.grip), 'ease-out']];
  const up = held(1.2);
  const steps: Step[] = [...reach, [140, at(CUP_ARM.grip)],
    [260, at(CUP_ARM.top, 0, up), 'ease-in'], [220, at(CUP_ARM.over, -4, up), 'linear']];
  if (drink === 'iced') {
    steps.push([340, at(CUP_ARM.straw, -24, held(1.2, { y: .5 })), 'ease-out'],
      [rnd(1300, 2100), at(CUP_ARM.straw, -25, held(1.2, { y: .7 }))]);
  } else {
    if (drink === 'hot') steps.push([340, at(blow, -2, held(1.2, { y: .6 })), 'ease-out'], [rnd(450, 650), at(blow, -2, held(1.2, { y: .8 }))]);
    steps.push([drink === 'hot' ? 380 : 440, at(sip, -12, held(1.2, { y: -.9, sy: .97 })), drink === 'hot' ? 'ease-in-out' : 'ease-out'],
      [rnd(drink === 'hot' ? 700 : 1100, drink === 'hot' ? 1300 : 1800), at(sip, -15, held(1.2, { y: -1.1, sy: .965 }))], [350, at(blow, 0, up)]);
  }
  steps.push([320, at(CUP_ARM.over, -4, up), 'ease-in'], [220, at(CUP_ARM.top, 0, held(.4)), 'linear'], [300, at(CUP_ARM.grip), 'ease-out']);
  const give = steps.length - 1;
  steps.push([140, at(CUP_ARM.grip)]);
  // Back the way it came: behind the lid (where the forearm turns over unseen again), or up beside the face.
  steps.push(...(rest ? [[rnd(420, 480), at(TUCK), 'ease-in']] as Step[] : [[380, at(CUP_ARM.top), 'ease-in'], [450, at([61, -25]), 'ease-out']] as Step[]));
  const line = timeline(steps, rest ? 450 : 650);
  const take = reach.length - 1;
  return { ...line, cup: [[line.at(take), true], [line.at(give), false]], fronts: [{ side: 'r', on: line.at(take), off: line.at(give) }],
    ...(rest ? { away: [{ side: 'r', on: 0, off: line.at(0) }, { side: 'r', on: line.at(steps.length - 1), off: 1 }] } : { calm: true }) };
}

/** Winter: cold hands. The shoulders come up, both hands rise in front of the lid and rub together, then cup at the
 * mouth and are blown into (a puff of breath), sometimes twice; the shoulders let go first, then the hands go down.
 * Both hands are drawn in front of the face from where they set off: behind the lid, or out beside the head, clear
 * of it and of the body (HANDS_OUT), where the front copies change nothing and switch at once. */
function rubMotion(rest: boolean, rnd: (low: number, high: number) => number, random: () => number): Motion {
  const hunch = { 'stretch-body': { y: -.8, sy: 1.022 } };
  const steps: Step[] = [];
  // From behind the head both hands first come out beside it, where their front copies switch on.
  if (!rest) steps.push([650, HANDS_OUT, 'ease-in-out']);
  steps.push([rest ? 650 : 450, { ...both(RUB_ARM), ...hunch, head: { y: 1.5 } }, 'ease-out']);
  const puffs: number[] = [];
  for (let round = 0; round < (random() < .5 ? 2 : 1); round++) {
    if (round) steps.push([340, { ...both(RUB_ARM), ...hunch, head: { y: 1.5 } }, 'ease-in-out']);
    const beat = rnd(155, 175);
    for (let left = rnd(1200, 1800), i = 0; left > 0; left -= beat, i++) {
      steps.push([beat, { ...(i % 2 ? { ...RUB_DOWN, ...mirror(RUB_UP) } : { ...RUB_UP, ...mirror(RUB_DOWN) }), ...hunch, head: { y: 1.5 } }]);
    }
    steps.push([380, { ...both(BLOW_ARM), ...hunch, head: { y: 2.4 } }, 'ease-in-out']);
    puffs.push(steps.length);
    steps.push([rnd(800, 1000), { ...both(BLOW_IN), ...hunch, head: { y: 2.6 } }]);
  }
  steps.push([450, { ...both(BLOW_IN), 'stretch-body': { y: 0, sy: 1 }, head: { y: 0 } }, 'ease-in-out']);
  if (!rest) steps.push([650, HANDS_OUT, 'ease-in-out']);
  const line = timeline(steps, rest ? 900 : 750);
  const fronts: Front[] = rest ? (['l', 'r'] as const).map(which => ({ side: which, on: line.time(30), off: 1 - line.time(60) }))
    : (['l', 'r'] as const).map(which => ({ side: which, on: line.at(0), off: line.at(steps.length - 1) }));
  // Each puff leaves the hands a moment after the blowing starts (the step before it ends where the hands are cupped).
  return { ...line, fronts, puffs: puffs.map(i => line.at(i - 1) + line.time(120)) };
}

/** A move written as moments on its own clock (ms from its start), each naming the parts it moves, then `back` ms to
 * the end pose. Between the moments that name it a part moves straight on, so one arm can run a little behind the
 * other and the body keep its own time. */
function tracks(moments: Step[], back: number, end = 'ease-in-out'): Motion {
  const ms = Math.max(...moments.map(([at]) => at)) + back;
  return { ms, end, keys: [...moments].sort((a, b) => a[0] - b[0]).map(([at, shape, easing]): Key => [at / ms, shape, easing]) };
}

/** The stretch at rest, for the left arm reaching over and the body bending to the right (mirrored for the other
 * side); upper and fore turns, with the mitten's centre (drawing units, before the body's own moves). The arms come
 * up past the lid's top beside the body, then beside the head, and meet over it, elbows a little bent; the reaching
 * arm is the straighter. Coming down the reaching arm opens out in a wide arc, nearly straight, and bends as it lowers
 * beside the lid; the other folds down beside the head and the face, the elbow out low. */
const STRETCH = {
  reach: {
    low: [-79.6, 23.2], // 80, 58: beside the body, just over the lid
    high: [-16.4, -33.2], // 84, 18: beside the head
    up: [36.4, -83.3], // 116, 0: over the head, the elbow a little bent
    far: [41.1, -92.8], // 116.5, -2: reaching on through the hold
    open: [12.4, -102.6], // 72, -2: opening out, straight
    wide: [-17.7, -95.8], // 42, 18: opened out wide, nearly straight
    lower: [-86.3, -60.6], // 30, 80: down beside the lid, the elbow bending
  },
  other: {
    low: [-83.4, 29.5], // 83, 61
    high: [-22.8, -26.6], // 82, 22
    up: [34.8, -79.6], // 116, 1: beside the reaching hand, wrists crossed, more bent
    far: [36.4, -83.3], // 116, 0
    // Coming down it does not open out but bends: the hand comes down beside the head and the face, the elbow out low.
    wide: [-30, -20], // 80, 27: beside the head
    lower: [-61, 25], // 86, 54: beside the face
  },
} as const;

/** A real stretch at the desk: a small inhale lifts the shoulders; the arms come up one a moment after the other while
 * body and chair recline and the head tips back; a hold over the head with the body bending a few degrees to one side;
 * then, like a long breath out, the shoulders drop and the arms come down at their own pace and width, one opening out
 * in a wide arc, while the body comes upright; the hands go back behind the lid last. `reachLeads`: the reaching arm (the
 * left, on the side away from the bend) rises first, else the other. */
function restStretch(now: Pose, reachLeads: boolean, rnd: (low: number, high: number) => number): Motion {
  const lag = rnd(150, 250), hold = rnd(1000, 1500);
  const at = { l: reachLeads ? 0 : lag, r: reachLeads ? lag : 0 };
  // An arm's pose given as the left arm's (the right one mirrors it).
  const arm = (which: 'l' | 'r', [upper, fore]: readonly number[]): Shape => which === 'l' ? { 'upper-l': upper, 'fore-l': fore } : mirror({ 'upper-l': upper, 'fore-l': fore });
  const keys = [REST_ARMS['upper-l'], REST_ARMS['fore-l']] as number[];
  const track = { l: STRETCH.reach, r: STRETCH.other };
  // The body, head and chair: the recline about the hips squashes the head, which is kept round (and a touch smaller),
  // then tipped back a little (shorter still, and up).
  const body = (sy: number, lift: { y: number; sy: number }, bend: number, tip = 0, r = 0): Shape => ({
    lean: { sy }, 'stretch-body': { ...lift, r: bend },
    head: { s: .97 + .03 * Math.min(Math.max((sy - .9) / .1, 0), 1), sy: (1 - .05 * tip) / sy, y: -1.3 * tip, r },
  });
  const up = 2100 + lag, release = up + hold;
  const moments: Step[] = [
    // A small inhale, the shoulders lifting; the arms still at the keys.
    [450, { ...body(1.006, { y: -.9, sy: 1.022 }, 0), ...armsOf(now) }, 'ease-out'],
    // Body and chair recline as the arms rise, the head tipping back.
    [up, body(.905, { y: -1.3, sy: 1.03 }, 2, 1, -1), 'ease-in-out'],
    // The hold: the side bend grows a little.
    [release, body(.895, { y: -1.4, sy: 1.032 }, 4.5, 1, -2), 'ease-in-out'],
    // The breath out: the shoulders drop first, then the body comes upright while the arms are still on their way.
    [release + 600, body(.93, { y: .4, sy: .995 }, 3.2, .5, -1), 'ease-out'],
    [release + 1700, body(1.004, { y: 0, sy: 1 }, 0), 'ease-in-out'],
    [release + 2200, body(1, { y: 0, sy: 1 }, 0), 'ease-in-out'],
  ];
  for (const which of ['l', 'r'] as const) {
    const t = at[which], p = track[which];
    moments.push([450 + t, side(armsOf(now), which)],
      [1050 + t, arm(which, p.low), 'ease-in'], [1500 + t, arm(which, p.high), 'linear'], [2100 + t, arm(which, p.up), 'ease-out']);
  }
  // Coming down: the reaching arm opens first, wider and slower; the other a moment later, less wide and more bent.
  moments.push([release, arm('l', STRETCH.reach.far), 'ease-in-out'],
    [release + 650, arm('l', STRETCH.reach.open), 'ease-in'], [release + 1300, arm('l', STRETCH.reach.wide), 'linear'],
    [release + 2100, arm('l', STRETCH.reach.lower), 'linear'],
    [release + 2900, arm('l', keys), 'ease-in-out']);
  moments.push([release + 300, arm('r', STRETCH.other.far), 'ease-in-out'],
    [release + 1050, arm('r', STRETCH.other.wide), 'ease-in'], [release + 1700, arm('r', STRETCH.other.lower), 'linear'],
    [release + 2500, arm('r', keys), 'ease-in-out']);
  return tracks(moments, 250, 'ease-out');
}

interface Context { state: FieldPose; flip: boolean; now: Pose; random: () => number; brief: boolean; drink: DeskDrink }

/** The actions, with real durations: a chin held for half a minute, a lean back of ten to twenty-five seconds, a
 * short glance or a longer gaze. Big moves start with a little anticipation and end with a gentle overshoot. */
function idleMotion(id: IdleAction, { state, flip, now, random, brief, drink }: Context): Motion {
  const rnd = (low: number, high: number) => between(low, high, random);
  const rest = state !== 'waiting', baseLean = rest ? 1 : WAIT_LEAN;
  const keyboard = armDown(now, flip ? 'r' : 'l');
  switch (id) {
    case 'chin': { // The cheek rests on a mitten a long while: the head leans into it, now more, now less, the hand
      // shifts a little, then it sits up. From the keyboard the hand comes straight up from behind the lid.
      const visit: Step[] = [[keyboard ? 1000 : 800, { ...chinArm(), head: { r: -1.5, y: .5 } }, keyboard ? 'ease-in-out' : 'ease-out'],
        [500, { head: { r: -4.5, y: 1.9 } }]];
      let upper = 0;
      for (let left = brief ? rnd(4000, 5000) : rnd(12_000, 30_000); left > 0;) {
        const pause = rnd(2500, 5000);
        if (random() < .3) upper = rnd(-2, 2);
        visit.push([Math.min(pause, Math.max(left, 1200)), { head: { r: -rnd(2, 5.5), y: rnd(1.4, 2.2) }, ...chinArm(upper, rnd(-1.8, 1.8)) }]);
        left -= pause;
      }
      visit.push([650, { head: { r: .5, y: -.6 } }, 'ease-in-out']);
      return mirrored(faceMotion(keyboard, visit, 900, { lead: [], leave: [] }), flip);
    }
    case 'lean-back': case 'lean-back-left': case 'lean-back-right': {
      // Against the backrest, which reclines with the body: from the front it is a turn away about the hips, so body,
      // head and the top of the chair back shorten and come down a little; to one side it also rolls. The head
      // (squashed by the recline) is kept round, a touch smaller, and tilts gently now and then.
      const roll = id === 'lean-back' ? 0 : id === 'lean-back-left' ? -4.5 : 4.5;
      const depth = (id === 'lean-back' ? (rest ? .9 : .86) : (rest ? .91 : .88));
      const head = (r: number) => ({ s: .96, sy: 1 / depth, r });
      const steps: Step[] = [
        [260, { lean: { sy: baseLean + .012 } }, 'ease-out'],
        [1300, { lean: { sy: depth - .012, r: roll * 1.1 }, head: head(roll * .3) }, 'ease-in-out'],
        [500, { lean: { sy: depth, r: roll } }, 'ease-in-out'],
      ];
      for (let left = brief ? rnd(3000, 4000) : rest ? rnd(10_000, 25_000) : rnd(6000, 15_000); left > 0;) {
        const pause = rnd(2500, 5500);
        steps.push([Math.min(pause, Math.max(left, 1200)), { head: head(rnd(-3, 3)), lean: { sy: depth + rnd(-.008, .008), r: roll } }]);
        left -= pause;
      }
      steps.push([1100, { lean: { sy: baseLean + .01, r: 0 }, head: { s: 1, sy: 1, r: 0 } }, 'ease-in-out']);
      return timeline(steps, 450, 'ease-in-out');
    }
    case 'nod': { // Agreeing with what it reads: one nod, sometimes two.
      const steps: Step[] = [[130, { head: { y: -.6 }, 'stretch-body': { y: 0 } }, 'ease-out'], [300, { head: { y: 3.8 }, 'stretch-body': { y: .7 } }, 'ease-in-out'],
        [340, { head: { y: .3 }, 'stretch-body': { y: 0 } }, 'ease-in-out']];
      if (random() < .35) steps.push([260, { head: { y: 3.2 }, 'stretch-body': { y: .5 } }], [300, { head: { y: .2 }, 'stretch-body': { y: 0 } }]);
      return timeline(steps, 380);
    }
    case 'look-aside': { // A glance to one side (2–4 s), sometimes a longer gaze; waiting, it looks one way and the other.
      const turn = rest ? 11 : 8, gaze = random() < .3;
      const steps: Step[] = [[160, { head: { r: -1.2 } }, 'ease-out'], [480, { head: { r: turn * 1.12, x: 3 }, rock: 1.2 }, 'ease-out'],
        [260, { head: { r: turn, x: 2.8 } }, 'ease-in-out']];
      for (let left = gaze ? rnd(2800, 4300) : rnd(900, 2600); left > 0;) {
        const pause = rnd(900, 1800);
        steps.push([Math.min(pause, Math.max(left, 600)), { head: { r: turn + rnd(-2, 1.5), x: 2.8, y: rnd(-.4, .6) }, rock: 1.1 }]);
        left -= pause;
      }
      if (!rest) steps.push([900, { head: { r: -turn, x: -2.6 }, rock: -1 }, 'ease-in-out'], [rnd(900, 1800), { head: { r: -turn + 1, x: -2.4 }, rock: -1 }]);
      return mirrored(timeline(steps, 650), flip);
    }
    case 'rock': { // Gently rocking in the chair, two or three times, easing out.
      const steps: Step[] = [];
      const swings = 4 + Math.floor(random() * 3);
      for (let i = 0; i < swings; i++) {
        const fade = 1 - i / (swings + 1);
        steps.push([rnd(900, 1200), { rock: (i % 2 ? 2.4 : -2.8) * fade, head: (i % 2 ? -1.2 : 1.4) * fade }, 'ease-in-out']);
      }
      return timeline(steps, 900);
    }
    case 'stretch': {
      if (!rest) { // One arm reaches up, the other out to the side; the chair reclines further; then all fold back.
        const hold = rnd(700, 2000);
        return mirrored(timeline([
          [300, { 'stretch-body': { y: .8 }, ...armsOf(now) }, 'ease-out'],
          [1500, { 'upper-l': 19, 'fore-l': -114, 'upper-r': -1, 'fore-r': 140, 'stretch-body': { r: 3.5 }, head: { r: -3, s: .97, sy: 1 / .89 }, lean: { sy: .89 } }, 'ease-in-out'],
          [400, { 'upper-l': 23, 'fore-l': -119, 'upper-r': -4, 'fore-r': 148, 'stretch-body': { r: 4.8 }, head: { r: -3, s: .97, sy: 1 / .875 }, lean: { sy: .875 } }, 'ease-out'],
          [hold, { 'upper-l': 21, 'fore-l': -116, 'upper-r': -2, 'fore-r': 144, 'stretch-body': { r: 4.3 }, head: { r: -2.5, s: .97, sy: 1 / .88 }, lean: { sy: .88 } }],
        ], 1700, 'ease-in-out'), flip);
      }
      return mirrored(restStretch(now, random() < .5, rnd), flip);
    }
    case 'yawn': // Shoulders rise and the head tips back while one mitten covers the mouth; the other arm stays put.
      // From the keyboard the hand comes up the middle of the chest on its own side, the elbow staying behind the lid.
      return mirrored(faceMotion(keyboard, [
        [650, { ...leftArm(YAWN_ARM), 'stretch-body': { y: -1.2, sy: 1.025 }, head: { y: -1.4, sy: .95, r: -1 } }, 'ease-out'],
        [1300, { ...leftArm(YAWN_ARM, 0, -1), 'stretch-body': { y: -1.9, sy: 1.035 }, head: { y: -2.2, sy: .93, r: -1.5 } }, 'ease-in-out'],
        [700, { 'stretch-body': { y: 0, sy: 1 }, head: { y: -.3, sy: .99, r: .8 } }, 'ease-in-out'],
        [400, { head: { y: .5, sy: 1, r: 0 } }, 'ease-out'],
      ], 450, { lead: [[260, leftArm(LOW), 'ease-in'], [300, leftArm(RISE), 'linear']], leave: [[350, leftArm(RISE), 'ease-in'], [260, leftArm(LOW), 'linear']] }), flip);
    case 'rub-eye': { // A mitten comes up in front of the face to the eye on its side and rubs it in small circles, head
      // tilted into it.
      const visit: Step[] = [[700, { ...leftArm(EYE_ARM), head: { r: -3, y: 1 } }, 'ease-out']];
      for (let left = rnd(2000, 4000), i = 0; left > 0; i++) {
        const beat = rnd(170, 230);
        visit.push([beat, i % 2 ? leftArm(EYE_ARM, -2, -4) : leftArm(EYE_ARM, 2, 4.5)]);
        left -= beat;
      }
      visit.push([300, { ...leftArm(EYE_ARM), head: { r: 0, y: 0 } }]);
      return mirrored(faceMotion(keyboard, visit, 500), flip);
    }
    case 'drink': return drinkMotion(rest, drink, rnd);
    case 'rub-hands': return rubMotion(rest, rnd, random);
  }
}

/** For tests: an action's steps (0–1) from the rest or the waiting pose, each naming the parts it moves, and the
 * moments the cup changes hands, a front hand shows, a puff leaves, or a forearm is left out. */
export function idleSteps(id: IdleAction, state: 'rest' | 'waiting', random: () => number = Math.random, drink: DeskDrink = 'hot') {
  const motion = idleMotion(id, { state, flip: false, now: BASE[state], random, brief: false, drink });
  return Object.assign(motion.keys
    .map(([at, shape]) => ({ at, parts: Object.fromEntries(Object.entries(shape).map(([part, value]) => [part, change(STILL, value)])) as Partial<Pose> })),
  { cup: motion.cup ?? [], fronts: motion.fronts ?? [], puffs: motion.puffs ?? [], away: motion.away ?? [], calm: Boolean(motion.calm), ms: motion.ms });
}

/** For tests: how long an action lasts from the rest or the waiting pose. */
export function idleDuration(id: IdleAction, state: 'rest' | 'waiting', random: () => number = Math.random, drink: DeskDrink = 'hot') {
  return idleMotion(id, { state, flip: false, now: BASE[state], random, brief: false, drink }).ms;
}

/** Waves hello: one hand comes up beside the head and waves a few times. */
function waveMotion(state: FieldPose): Motion {
  const waves: Key[] = [[.45, { 'upper-r': 31.5, 'fore-r': 42 }], [.54, { 'upper-r': 31.5, 'fore-r': 14 }], [.63, { 'upper-r': 31.5, 'fore-r': 40 }],
    [.72, { 'upper-r': 31.5, 'fore-r': 18 }], [.8, { 'upper-r': 31.5, 'fore-r': 27, head: 0 }]];
  if (state === 'waiting') return { ms: 2700, keys: [[.32, { 'upper-r': 31.5, 'fore-r': 27, head: 2 }, 'ease-out'], ...waves] };
  return { ms: 3000, keys: [
    [.2, { 'upper-r': 75, 'fore-r': -20 }, 'ease-in'], [.34, { 'upper-r': 31.5, 'fore-r': 27, head: 2 }, 'ease-out'],
    ...waves, [.9, { 'upper-r': 75, 'fore-r': -20, head: 0 }, 'ease-in'],
  ], end: 'ease-out' };
}

/** Puzzled: a short burst of scratching behind the head. */
const SCRATCH: Motion = { ms: 1650, keys: [[.167, { 'fore-l': -9 }], [.333, { 'fore-l': 3 }], [.5, { 'fore-l': -9 }], [.667, { 'fore-l': 3 }], [.833, { 'fore-l': -9 }]] };

/** From wherever the figure is to a state's base pose. An arm that goes between the keyboard and the head passes
 * the elbows-out pose (the hand beside the face), so a hand never slides across the face. Finishing the wait, the
 * figure first has one slow stretch. */
function transitionMotion(from: Pose, to: Pose, finishing: boolean): Motion {
  if (finishing && !armDown(from, 'l') && !armDown(from, 'r')) {
    return { ms: 4200, keys: [
      [.26, { 'upper-l': 19, 'fore-l': -114, 'upper-r': -1, 'fore-r': 140, 'stretch-body': 3.5, head: -3, lean: { sy: .9 } }],
      [.42, { 'upper-l': 22, 'fore-l': -118, 'upper-r': -3, 'fore-r': 146, 'stretch-body': 4.5, head: -3, lean: { sy: .89 } }],
      [.62, { ...ELBOWS_OUT, 'stretch-body': 1, head: 0, lean: { sy: .99 } }, 'cubic-bezier(.42, 0, .8, .6)'],
      [.9, { lean: { sy: 1.008 } }, 'ease-out'],
    ], end: 'cubic-bezier(.2, .4, .58, 1)' };
  }
  const via: Shape = {};
  for (const which of ['l', 'r'] as const) if (armDown(from, which) !== armDown(to, which)) Object.assign(via, side(ELBOWS_OUT, which));
  // Settling into the wait, the chair gives a little further before it rests.
  const settle: Key[] = to.lean.sy < 1 ? [[.82, { lean: { sy: to.lean.sy - .012 } }]] : [];
  return Object.keys(via).length ? { ms: 1900, keys: [[.45, via, 'ease-in'], ...settle], end: 'ease-out' } : { ms: 1300, keys: settle };
}

/** A move that starts with a hand still in front of the face (another move was cut short there): first the hand goes
 * where its front copy can be dropped unseen (behind the lid if it ends there, else up and out beside the head), then
 * the move. */
function release(motion: Motion, sides: Array<'l' | 'r'>, to: Pose): Motion {
  // About three quarters of a second for the hand to get there, however long the move after it is.
  const safe: Shape = {};
  for (const which of sides) Object.assign(safe, side(armDown(to, which) ? REST_ARMS : REACH_HIGH, which));
  const { keys, motion: next } = before(motion, [[750, safe, 'ease-in-out']]);
  return { ...next, fronts: [...next.fronts ?? [], ...sides.map(which => ({ side: which, on: 0, off: keys[0][0], ramp: (armDown(to, which) ? 30 : 260) / next.ms }))] };
}

/** Steps put in front of a move, which then plays on from where they end: its moments (0–1) are moved along. */
function before(motion: Motion, way: Step[]) {
  const pre = way.reduce((sum, [step]) => sum + step, 0), ms = motion.ms + pre, k = pre / ms;
  let t = 0;
  const keys = way.map(([step, shape, easing]): Key => { t += step; return [t / ms, shape, easing]; });
  const after = (at: number) => k + at * (1 - k);
  return {
    keys,
    motion: {
      ...motion, ms,
      keys: [...keys, ...motion.keys.map(([at, shape, easing]): Key => [after(at), shape, easing])],
      fronts: (motion.fronts ?? []).map(front => ({ ...front, on: after(front.on), off: after(front.off),
        ...(front.ramp !== undefined && { ramp: front.ramp * (1 - k) }) })),
      cup: (motion.cup ?? []).map(([at, held]): [number, boolean] => [after(at), held]),
      away: (motion.away ?? []).map(span => ({ ...span, on: after(span.on), off: after(span.off) })),
      ...(motion.puffs && { puffs: motion.puffs.map(after) }),
    } as Motion,
  };
}

/** A move that starts with the cup still in the hand (a sip was cut short): first the cup goes back on the desk the
 * way it came up, out right of the chest and down beside the lid, the body and head settling meanwhile and the other
 * arm staying put; there it is set down and the hand's front copy dropped (beside the lid, where that changes
 * nothing). If the move ends with the hand at the keyboard, the hand goes back behind the lid there first (its
 * forearm turning over unseen), and a change of state no longer moves that arm; then the move. */
function cupDown(motion: Motion, from: Pose, to: Pose, transition: boolean): Motion {
  const [x, y] = handAt('r', from['upper-r'].r, from['fore-r'].r, from['upper-r'].s);
  const stay: Shape = { 'upper-l': from['upper-l'].r, 'fore-l': from['fore-l'].r };
  const way: Step[] = [];
  const reach = (arm: readonly number[]): Shape => ({ ...stay, ...cupArm(arm) });
  if (x < 158) way.push([380, reach(CUP_ARM.over), 'ease-in-out']);
  if (y < 100) way.push([way.length ? 220 : 380, reach(CUP_ARM.top), way.length ? 'linear' : 'ease-in-out']);
  way.push([way.length ? 300 : 450, { ...reach(CUP_ARM.grip), 'stretch-body': { y: 0, sy: 1 }, head: { y: 0, sy: 1, r: 0, x: 0 } }, 'ease-out'], [140, reach(CUP_ARM.grip)]);
  const give = way.length - 2, home = armDown(to, 'r');
  if (home) way.push([450, reach(TUCK), 'ease-in'], [420, { ...stay, ...side(REST_ARMS, 'r'), cup: 0 }, 'ease-in-out']);
  if (home && transition) motion = { ...motion, keys: motion.keys.map(([at, shape, easing]): Key => [at, Object.fromEntries(Object.entries(shape)
    .filter(([part]) => !part.endsWith('-r') && part !== 'cup')), easing]) };
  const { keys, motion: next } = before(motion, way);
  return {
    ...next,
    fronts: [{ side: 'r', on: 0, off: keys[give][0] }, ...next.fronts ?? []],
    cup: [[keys[give][0], false], ...next.cup ?? []],
    away: [...home ? [{ side: 'r' as const, on: keys[way.length - 2][0], off: keys[way.length - 1][0] }] : [], ...next.away ?? []],
  };
}

/** A move that starts with a forearm left out (Away; something cut the turn short): first that arm goes on to the
 * keyboard behind the lid, where the forearm is drawn again; then the move. */
function backIn(motion: Motion, sides: Array<'l' | 'r'>, from: Pose): Motion {
  const stay: Shape = { ...armsOf(from) };
  for (const which of sides) Object.assign(stay, side(REST_ARMS, which));
  const { keys, motion: next } = before(motion, [[400, stay, 'ease-in-out']]);
  return { ...next, away: [...sides.map(which => ({ side: which, on: 0, off: keys[0][0] })), ...next.away ?? []] };
}

const css = ({ x, y, r, s, sy }: Turn) =>
  `translate(${+x.toFixed(2)}px, ${+y.toFixed(2)}px) rotate(${+r.toFixed(2)}deg) scale(${+s.toFixed(4)}, ${+(s * sy).toFixed(4)})`;
const same = (a: Pose, b: Pose) => PARTS.every(part => css(a[part]) === css(b[part]));

/** Reads a part's transform back from its computed matrix (translate · rotate · scale); `near` picks the turn's
 * winding, as the matrix only knows it modulo 360°. */
function readTurn(el: Element, near: [number, number]): Turn {
  const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
  if (!m) return { ...STILL };
  const [a, b, c, d, e, f] = m[1].split(',').map(Number);
  let r = Math.atan2(b, a) * 180 / Math.PI;
  const mid = (near[0] + near[1]) / 2;
  while (r < mid - 180) r += 360;
  while (r > mid + 180) r -= 360;
  const s = Math.hypot(a, b);
  return { x: e, y: f, r, s, sy: (a * d - b * c) / (s * s) };
}

/**
 * The ambient layer, on wrapper groups of its own, so it runs under every action: breathing (chest and shoulders,
 * about 1.4% over 4.5 s), a slow irregular head drift on two unrelated periods, and while waiting the old drift
 * (lean 17 s, rock 11 s, head 7.3 s), the lean now a recline about the hips. Every loop starts and ends at rest.
 */
type Slot = 'breath' | 'drift' | 'sway' | 'head-drift' | 'head-sway';
interface Loop { frames: Keyframe[]; ms: number; direction?: PlaybackDirection }
const keyed = (values: Array<[number, string]>): Keyframe[] => values.map(([offset, transform]) => ({ offset, transform, easing: 'ease-in-out' }));
const LOOPS: Record<string, Loop> = {
  breath: { frames: [{ transform: 'scale(1, 1)', easing: 'ease-in-out' }, { transform: 'scale(1.005, 1.014)' }], ms: 2250, direction: 'alternate' },
  headDrift: { frames: keyed([[0, 'rotate(0deg)'], [.22, 'rotate(1.3deg)'], [.48, 'rotate(-.5deg)'], [.7, 'rotate(-1.2deg)'], [.88, 'rotate(.6deg)'], [1, 'rotate(0deg)']]), ms: 9700 },
  headSway: { frames: keyed([[0, 'rotate(0deg)'], [.3, 'rotate(-.9deg)'], [.62, 'rotate(.8deg)'], [1, 'rotate(0deg)']]), ms: 6300 },
  waitLean: { frames: keyed([[0, 'scale(1, 1)'], [.14, 'scale(1, 1)'], [.22, 'scale(1, .965)'], [.36, 'scale(1, .965)'], [.44, 'scale(1, 1)'],
    [.7, 'scale(1, 1)'], [.76, 'scale(1, .98)'], [.88, 'scale(1, .98)'], [.94, 'scale(1, 1)'], [1, 'scale(1, 1)']]), ms: 17_000 },
  waitRock: { frames: keyed([[0, 'rotate(0deg)'], [.2, 'rotate(0deg)'], [.3, 'rotate(-1.6deg)'], [.4, 'rotate(-1.1deg)'], [.5, 'rotate(0deg)'],
    [.64, 'rotate(0deg)'], [.72, 'rotate(1.3deg)'], [.8, 'rotate(0deg)'], [1, 'rotate(0deg)']]), ms: 11_000 },
  waitHead: { frames: keyed([[0, 'rotate(0deg)'], [.3, 'rotate(0deg)'], [.36, 'rotate(-4deg)'], [.5, 'rotate(-4deg)'], [.56, 'rotate(0deg)'],
    [.76, 'rotate(0deg)'], [.82, 'rotate(3deg)'], [.88, 'rotate(3deg)'], [.94, 'rotate(0deg)'], [1, 'rotate(0deg)']]), ms: 7300 },
};
function ambientFor(state: FieldPose | null, calm = false): Record<Slot, Loop | null> {
  if (!state) return { breath: null, drift: null, sway: null, 'head-drift': null, 'head-sway': null };
  const waiting = state === 'waiting', drifting = waiting && !calm;
  return { breath: LOOPS.breath, drift: drifting ? LOOPS.waitLean : null, sway: drifting ? LOOPS.waitRock : null,
    'head-drift': waiting ? LOOPS.waitHead : LOOPS.headDrift, 'head-sway': LOOPS.headSway };
}

/** The heart, while the jointed arms are straight up: drawn arms of exactly that shape take over (the two overlap for
 * a moment each way, so a frame can never land with neither), bend into a heart over the head, hold, and straighten;
 * a small heart pops up beside the head. */
const HEART_MS = 3000;
const HEART_STEPS = [0, .08, .3, .64, .88, 1];

interface Sleeper { pause(): void; resume(): void; rescale(factor: number): void }
export interface FieldMotionHandle { play(cue: FieldCue): void; speed(rate: number): void }

export class DeskMotion {
  private parts: Record<Part, Element[]>;
  private now: Pose = BASE.rest;
  private running: Animation[] = [];
  /** The span of turns each part of the running move goes through (only parts that move are listed). */
  private ranges: Partial<Record<Part, [number, number]>> = {};
  private done: ((finished: boolean) => void) | null = null;
  private kind: 'idle' | 'gesture' | 'transition' | null = null;
  private state: FieldPose = 'rest';
  private attentive = false;
  private started = false;
  private hearting = false;
  private dead = false;
  private hidden = false;
  /** Playback speed (the gallery reviews long holds at 4×). */
  private rate = 1;
  private loop: AbortController | null = null;
  private sleepers = new Set<Sleeper>();
  private last: IdleAction | null = null;
  private lastWave = -Infinity;
  /** Whose front copy (the hand drawn in front of the face) is showing, and whose is drawn whole (Front). */
  private shown = { l: false, r: false };
  private whole = { l: false, r: false };
  /** Whose forearm is left out of the drawing (Away). */
  private away = { l: false, r: false };
  /** The cup is in the hand (its copy there shows, the desk cup does not). */
  private cupHeld = false;
  /** The running move takes or sets down the cup; the chair is not pulled in or back meanwhile (`pullWaiting`). */
  private cupMoving = false;
  private pullWaiting = false;
  /** The waiting drift and rock are stilled for the running move. */
  private calm = false;
  /** The chair being pulled in or back. */
  private pulling: Animation | null = null;
  /** The ambient loops by slot, and what each is playing. */
  private ambient = new Map<Slot, { loop: Loop | null; animation: Animation }>();
  private reducedQuery: MediaQueryList | null;
  private readonly random: () => number;
  private readonly clock: () => Date;
  private readonly svg: SVGSVGElement;

  constructor(svg: SVGSVGElement, { random = Math.random, clock = () => new Date() }: { random?: () => number; clock?: () => Date } = {}) {
    this.svg = svg;
    this.random = random;
    this.clock = clock;
    this.parts = Object.fromEntries(PARTS.map(part => [part, [...svg.querySelectorAll(`.field-${part}`)]])) as Record<Part, Element[]>;
    this.reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedQuery?.addEventListener?.('change', this.onReduced);
    this.hidden = document.visibilityState === 'hidden';
    document.addEventListener('visibilitychange', this.onVisibility);
    svg.addEventListener('pointerenter', this.onPointer);
    this.commit(BASE.rest);
  }

  get isStarted() { return this.started; }

  destroy() {
    this.dead = true;
    this.loop?.abort();
    this.halt();
    for (const { animation } of this.ambient.values()) animation.cancel();
    this.ambient.clear();
    this.reducedQuery?.removeEventListener?.('change', this.onReduced);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.svg.removeEventListener('pointerenter', this.onPointer);
  }

  /** The figure appears: it starts seated at the keyboard and moves into its state from there (or greets first). */
  start(state: FieldPose, greet: boolean) {
    this.started = true;
    this.state = state;
    this.pullTo(false);
    if (!this.lively()) { this.commit(this.base()); return; }
    this.setAmbient(state);
    if (greet && state !== 'puzzled') { void this.heart(); return; }
    if (state === 'rest') this.idle(true);
    else void this.run(transitionMotion(this.now, this.base(), false), 'transition').then(ok => ok && this.resume(true));
  }

  /** A new state (the analysis started, ended or failed), or our project opening again: move there from wherever the
   * figure is. During the heart the arms come down into the new state when it ends. */
  setPose(state: FieldPose, greet = false) {
    if (!this.started) { this.start(state, greet); return; }
    const was = this.state;
    if (state === was && !greet) return;
    this.state = state;
    if (!this.lively()) { this.still(this.base()); return; }
    this.setAmbient(state);
    this.pullTo(true);
    if (this.hearting) return;
    this.loop?.abort();
    if (greet && state !== 'puzzled') { void this.heart(); return; }
    void this.run(transitionMotion(this.current(), this.base(), was === 'waiting' && state === 'rest'), 'transition').then(ok => ok && this.resume(true));
  }

  /** The composer holds a question (at rest): the chair is pulled in to the laptop and stays there, whatever the
   * figure does, until the text is gone. Only the chair comes closer; the figure goes on as before. */
  setAttentive(on: boolean) {
    if (on === this.attentive) return;
    this.attentive = on;
    this.pullTo(this.started);
  }

  /** For the private gallery: play one action or gesture now, from wherever the figure is. */
  play(cue: FieldCue) {
    if (!this.started || this.hearting || !this.lively()) return;
    if (cue === 'heart') { this.loop?.abort(); void this.heart(); return; }
    if (cue === 'wave') { this.wave(true); return; }
    if (cue === 'lean-in') {
      this.setAttentive(true);
      setTimeout(() => this.setAttentive(false), 6000 / this.rate);
      return;
    }
    if (cue === 'drink' && this.pulledIn()) return;
    this.loop?.abort();
    const id: IdleAction = cue === 'chin-long' ? 'chin' : cue;
    this.last = id;
    const motion = idleMotion(id, { state: this.state, flip: this.random() < .5, now: this.current(), random: this.random, brief: cue === 'chin', drink: this.drink() });
    void this.run(motion, 'idle').then(ok => ok && this.resume(false));
  }

  /** For the private gallery: play everything faster (long holds reviewed at 4×). */
  speed(rate: number) {
    const factor = this.rate / rate;
    this.rate = rate;
    for (const animation of this.everything()) animation.playbackRate = rate;
    for (const sleeper of this.sleepers) sleeper.rescale(factor);
  }

  private onPointer = (event: PointerEvent) => { if (event.pointerType === 'mouse') this.wave(false); };

  private wave(forced: boolean) {
    const at = performance.now();
    if (!this.started || this.hearting || !this.lively() || this.state === 'puzzled' || this.kind === 'transition' || this.kind === 'gesture') return;
    if (!forced && at - this.lastWave < 8000) return;
    this.lastWave = at;
    this.loop?.abort();
    void this.run(waveMotion(this.state), 'gesture').then(ok => ok && this.resume(false));
  }

  private onReduced = () => {
    if (this.lively()) { this.setAmbient(this.state); this.resume(true); return; }
    this.loop?.abort();
    this.hearting = false;
    this.still(this.base());
  };

  private onVisibility = () => {
    this.hidden = document.visibilityState === 'hidden';
    for (const animation of this.everything()) {
      if (this.hidden) animation.pause();
      else if (animation.playState === 'paused') animation.play();
    }
    for (const sleeper of this.sleepers) if (this.hidden) sleeper.pause(); else sleeper.resume();
  };

  private everything(): Animation[] {
    return [...this.running, ...[...this.ambient.values()].map(item => item.animation), ...(this.pulling ? [this.pulling] : [])];
  }

  private lively() {
    return !this.dead && typeof this.svg.animate === 'function' && !this.reducedQuery?.matches;
  }

  private base(): Pose {
    return BASE[this.state];
  }

  /** The chair is pulled in to the laptop (a question in the composer, at rest). */
  private pulledIn() {
    return this.state === 'rest' && this.attentive && this.started;
  }

  /** What is in the cup by the laptop: iced in summer (the season the outfit shows), else tea, hot while it steams. */
  private drink(): DeskDrink {
    if (seasonOf(this.clock()) === 'summer') return 'iced';
    const steam = this.svg.querySelector('.field-desk-cup .field-steam');
    return steam && getComputedStyle(steam).display !== 'none' ? 'hot' : 'tea';
  }

  /** Moves the chair in (a question in the composer, at rest) or back, from wherever it is, on its own group: an
   * unhurried pull with a slight overshoot, or straight at once when not animating. */
  private pullTo(animate: boolean) {
    const el = this.svg.querySelector<SVGElement>('.field-pull');
    if (!el) return;
    // The cup is being taken or set down: the chair waits until that is done.
    if (animate && this.cupMoving) { this.pullWaiting = true; return; }
    this.pullWaiting = false;
    const target = this.state === 'rest' && this.attentive && this.started ? PULLED_IN : 1;
    const scale = (k: number) => `scale(${k}, ${k})`;
    const from = getComputedStyle(el).transform;
    this.pulling?.cancel();
    this.pulling = null;
    if (!animate || !this.lively()) { el.style.transform = target === 1 ? '' : scale(target); return; }
    const over = target + (target > 1 ? .006 : -.004);
    const pull = el.animate([{ transform: from === 'none' ? scale(1) : from }, { transform: scale(over), offset: .75 }, { transform: scale(target) }],
      { duration: 1700, easing: 'ease-in-out', fill: 'forwards' });
    this.tune(pull);
    this.pulling = pull;
    void pull.finished.then(() => {
      if (this.pulling !== pull) return;
      el.style.transform = target === 1 ? '' : scale(target);
      pull.cancel();
      this.pulling = null;
    }, () => undefined);
  }

  /** Starts the ambient loops for a state (none: all stop). A loop that changes eases back to rest from where it is
   * (read and replaced in one task) before the new one starts; a loop that stays the same keeps running. */
  private setAmbient(state: FieldPose | null, easeMs = 1200) {
    const wanted = ambientFor(state && this.lively() ? state : null, this.calm);
    for (const slot of Object.keys(wanted) as Slot[]) {
      const el = this.svg.querySelector<SVGElement>(`.field-${slot}`);
      const current = this.ambient.get(slot), loop = wanted[slot];
      if (!el || (current && current.loop === loop)) continue;
      if (!loop && !current) continue;
      const from = getComputedStyle(el).transform;
      current?.animation.cancel();
      if (!this.lively()) { this.ambient.delete(slot); continue; }
      const rest = loop ? String(loop.frames[0].transform) : 'none';
      const ease = el.animate([{ transform: from === 'none' ? rest : from }, { transform: rest }], { duration: easeMs, easing: 'ease-in-out', fill: 'forwards' });
      this.tune(ease);
      const item = { loop, animation: ease };
      this.ambient.set(slot, item);
      void ease.finished.then(() => {
        if (this.ambient.get(slot) !== item) return;
        if (!loop) { ease.cancel(); this.ambient.delete(slot); return; }
        const looping = el.animate(loop.frames, { duration: loop.ms, iterations: Infinity, direction: loop.direction ?? 'normal' });
        this.tune(looping);
        ease.cancel();
        item.animation = looping;
      }, () => undefined);
    }
  }

  /** New animations run at the current speed, and paused while the tab is hidden. */
  private tune(animation: Animation) {
    animation.playbackRate = this.rate;
    if (this.hidden) animation.pause();
  }

  /** Where the parts are this moment. */
  private current(): Pose {
    if (!this.running.length) return this.now;
    return Object.fromEntries(PARTS.map(part => {
      const el = this.parts[part][0];
      const range = this.ranges[part];
      return [part, el && range ? readTurn(el, range) : this.now[part]];
    })) as Pose;
  }

  /** Stops whatever moves: the parts stay exactly where they are (written inline in the same task). */
  private halt() {
    if (this.running.length) {
      const here = this.current();
      const front = (['l', 'r'] as const).map(which => {
        const el = this.svg.querySelector(`.field-front-${which}`);
        return el ? Number(getComputedStyle(el).opacity) > .5 : false;
      });
      const whole = (['l', 'r'] as const).map(which => {
        const stop = this.fades(which)[0];
        return stop ? /^(#fff|white|rgb\(255, 255, 255\))/.test(getComputedStyle(stop).stopColor) : false;
      });
      const cup = this.svg.querySelector('.field-held-cup');
      const held = cup ? Number(getComputedStyle(cup).opacity) > .5 : false;
      const away = (['l', 'r'] as const).map(which => {
        const el = this.forearms(which)[0];
        return el ? Number(getComputedStyle(el).opacity) < .5 : false;
      });
      for (const animation of this.running) animation.cancel();
      this.running = [];
      this.commit(here);
      this.showFront('l', front[0]);
      this.showFront('r', front[1]);
      if (front[0]) this.drawWhole('l', whole[0]);
      if (front[1]) this.drawWhole('r', whole[1]);
      this.showCup(held);
      this.leaveOut('l', away[0]);
      this.leaveOut('r', away[1]);
    }
    this.kind = null;
    this.cupMoving = false;
    const done = this.done;
    this.done = null;
    done?.(false);
  }

  /** Stops and puts the figure in `pose` at once, every hand behind and no ambient motion (reduced motion, or no Web
   * Animations). */
  private still(pose: Pose) {
    this.halt();
    this.commit(pose);
    this.showFront('l', false);
    this.showFront('r', false);
    this.showCup(false);
    this.leaveOut('l', false);
    this.leaveOut('r', false);
    this.calm = false;
    this.setAmbient(null);
    this.pullTo(false);
  }

  /** The cup in the hand, or on the desk (written inline, as the end of a move leaves it). */
  private showCup(held: boolean) {
    this.cupHeld = held;
    this.svg.querySelectorAll<SVGElement>('.field-held-cup').forEach(el => { el.style.opacity = held ? '1' : ''; });
    this.svg.querySelectorAll<SVGElement>('.field-desk-cup').forEach(el => { el.style.opacity = held ? '0' : ''; });
  }

  /** The jointed forearm and hand of one side (both passes), not their front copy. */
  private forearms(which: 'l' | 'r'): SVGElement[] {
    return [...this.svg.querySelectorAll<SVGElement>(`.field-fore-${which}`)].filter(el => !el.closest('.field-front'));
  }

  /** Leaves a forearm out of the drawing, or draws it again (written inline, as the end of a move leaves it). */
  private leaveOut(which: 'l' | 'r', out: boolean) {
    this.away[which] = out;
    for (const el of this.forearms(which)) el.style.opacity = out ? '0' : '';
  }

  private showFront(which: 'l' | 'r', on: boolean) {
    this.shown[which] = on;
    this.svg.querySelectorAll<SVGElement>(`.field-front-${which}`).forEach(el => { el.style.opacity = on ? '1' : ''; });
    if (!on) this.drawWhole(which, false);
  }

  /** The dark end of a front copy's fade towards the elbow: turned white, the copy is drawn whole. */
  private fades(which: 'l' | 'r'): SVGElement[] {
    return [...this.svg.querySelectorAll<SVGElement>(`.field-front-${which} .field-front-fade stop:first-child`)];
  }

  /** Draws a front copy whole, or fading towards the elbow again (written inline, as the end of a move leaves it). */
  private drawWhole(which: 'l' | 'r', on: boolean) {
    this.whole[which] = on;
    for (const el of this.fades(which)) el.style.stopColor = on ? '#fff' : '';
  }

  private commit(next: Pose) {
    this.now = next;
    for (const part of PARTS) for (const el of this.parts[part]) (el as SVGElement).style.transform = css(next[part]);
  }

  /** Plays a move from where the figure is to `to` (the state's base pose unless given); true once it got there,
   * false if something else took over first. */
  private run(motion: Motion, kind: 'idle' | 'gesture' | 'transition', to: Pose = this.base(), extra?: (ms: number) => Animation[]): Promise<boolean> {
    this.halt();
    if (!this.lively()) { this.still(to); return Promise.resolve(false); }
    const out = (['l', 'r'] as const).filter(which => this.away[which]);
    if (out.length) motion = backIn(motion, out, this.now);
    if (this.cupHeld) motion = cupDown(motion, this.now, to, kind === 'transition');
    const lingering = (['l', 'r'] as const).filter(which => this.shown[which] && !motion.fronts?.some(front => front.side === which));
    if (lingering.length) motion = release(motion, lingering, to);
    const from = this.now;
    this.ranges = {};
    const easing = (i: number) => i < motion.keys.length ? motion.keys[i][2] ?? 'ease-in-out' : motion.end ?? 'ease-in-out';
    for (const part of PARTS) {
      // Only the steps that name this part make keyframes for it: between them it moves straight on, so a pose named
      // for other parts (a lean settling, a head turn) never holds this one still. Each stretch eases as the step it
      // ends on says.
      let turn = from[part];
      const named = motion.keys.map((key, i) => [key, i] as const).filter(([[, shape]]) => shape[part] !== undefined);
      const frames: Keyframe[] = [{ offset: 0, transform: css(turn), easing: easing(named[0]?.[1] ?? motion.keys.length) }];
      const turns = [turn.r];
      named.forEach(([[at, shape]], k) => {
        turn = change(turn, shape[part]);
        turns.push(turn.r);
        frames.push({ offset: at, transform: css(turn), easing: easing(named[k + 1]?.[1] ?? motion.keys.length) });
      });
      frames.push({ offset: 1, transform: css(to[part]) });
      turns.push(to[part].r);
      if (frames.every(frame => frame.transform === frames[0].transform)) continue;
      this.ranges[part] = [Math.min(...turns), Math.max(...turns)];
      for (const el of this.parts[part]) this.running.push(el.animate(frames, { duration: motion.ms, fill: 'forwards' }));
    }
    // A hand's front copy comes and goes at moments where it is hidden or beside the head; it always ends hidden.
    // Out in the open (beside the head) it fades over a few frames, so even the soft edges of its lines, drawn twice
    // for a moment, change by no more than a shade. One animation per hand, however often it comes and goes.
    for (const which of ['l', 'r'] as const) {
      const spans = (motion.fronts ?? []).filter(front => front.side === which).sort((a, b) => a.on - b.on);
      if (!spans.length) continue;
      const start = this.shown[which] ? 1 : 0, frames: Keyframe[] = [{ opacity: start, offset: 0 }];
      let value = start, last = 0;
      const step = (offset: number, opacity: number) => {
        last = Math.min(Math.max(offset, last), 1);
        frames.push({ opacity, offset: last });
        value = opacity;
      };
      for (const { on, off, ramp = FRONT_FADE_MS / motion.ms } of spans) {
        step(on, value);
        step(Math.min(on + ramp, off), 1);
        step(off, 1);
        step(off + ramp, 0);
      }
      step(1, value);
      this.svg.querySelectorAll(`.field-front-${which}`).forEach(el => this.running.push(el.animate(frames, { duration: motion.ms, fill: 'forwards' })));
      // Drawn whole from the moment it shows (behind the lid), or from and to moments while it shows where that changes
      // nothing (Front); fading towards the elbow again once it is gone.
      if (!this.whole[which] && !spans.some(span => span.whole)) continue;
      let whole = this.whole[which], at = 0;
      const paint = (on: boolean) => on ? '#fff' : '#000';
      const fade: Keyframe[] = [{ stopColor: paint(whole), offset: 0 }];
      const turn = (offset: number, on: boolean) => {
        at = Math.min(Math.max(offset, at), 1);
        fade.push({ stopColor: paint(whole), offset: at }, { stopColor: paint(on), offset: Math.min(at + .0005, 1) });
        at = Math.min(at + .0005, 1);
        whole = on;
      };
      for (const { on, off, ramp = FRONT_FADE_MS / motion.ms, whole: drawn } of spans) {
        if (drawn === true) turn(on, true);
        else if (drawn) { turn(drawn.on, true); turn(drawn.off, false); }
        turn(off + ramp, false);
      }
      fade.push({ stopColor: paint(whole), offset: 1 });
      for (const el of this.fades(which)) this.running.push(el.animate(fade, { duration: motion.ms, fill: 'forwards' }));
    }
    // A forearm turning over behind the lid is left out of the drawing, from and to moments where all of it is behind
    // the lid (so the switch changes nothing visible).
    const tucked = motion.away ?? [];
    for (const which of ['l', 'r'] as const) {
      const spans = tucked.filter(span => span.side === which).sort((a, b) => a.on - b.on);
      if (!spans.length) continue;
      let value = this.away[which] ? 0 : 1, last = 0;
      const frames: Keyframe[] = [{ opacity: value, offset: 0 }];
      const mark = (offset: number, opacity: number) => { last = Math.min(Math.max(offset, last), 1); frames.push({ opacity, offset: last }); value = opacity; };
      for (const { on, off } of spans) {
        mark(on, value);
        mark(on + .0005, 0);
        mark(off, 0);
        mark(off + .0005, 1);
      }
      mark(1, value);
      for (const el of this.forearms(which)) this.running.push(el.animate(frames, { duration: motion.ms, fill: 'forwards' }));
    }
    // The cup changes hands in the gripping pose, where its two copies lie on each other: the one that comes is whole
    // by the moment of the switch (when the hand's front copy, which carries the cup in the hand, starts to fade in or
    // out) and the other goes a few frames later, so the cup is never missing or see-through for a frame.
    const switches = motion.cup ?? [];
    let held = this.cupHeld;
    if (switches.length) {
      const gap = CUP_OVERLAP_MS / motion.ms, snap = .0005;
      const copy = (desk: boolean) => {
        let on = desk ? !this.cupHeld : this.cupHeld, last = 0;
        const frames: Keyframe[] = [{ opacity: on ? 1 : 0, offset: 0 }];
        for (const [at, inHand] of switches) {
          const wanted = desk ? !inHand : inHand;
          if (wanted === on) continue;
          const when = Math.min(Math.max(wanted ? at - snap : at + gap, last), 1);
          last = Math.min(when + snap, 1);
          frames.push({ opacity: on ? 1 : 0, offset: when }, { opacity: wanted ? 1 : 0, offset: last });
          on = wanted;
        }
        frames.push({ opacity: on ? 1 : 0, offset: 1 });
        return frames;
      };
      this.svg.querySelectorAll('.field-held-cup').forEach(el => this.running.push(el.animate(copy(false), { duration: motion.ms, fill: 'forwards' })));
      this.svg.querySelectorAll('.field-desk-cup').forEach(el => this.running.push(el.animate(copy(true), { duration: motion.ms, fill: 'forwards' })));
      // Lifted, the tea's steam thins away (it would only cross the face), and comes back as the cup is set down. The
      // steam is see-through, so it is never drawn twice: the copy in the hand takes it over in the same instant the
      // desk cup goes, and gives it back in the same instant the desk cup comes.
      const fade = 400 / motion.ms, steam: Keyframe[] = [{ opacity: 0, offset: 0 }];
      let last = 0;
      const mark = (offset: number, opacity: number) => { last = Math.min(Math.max(offset, last), 1); steam.push({ opacity, offset: last }); };
      for (const [at, inHand] of switches) {
        if (inHand) { mark(at + gap, 0); mark(at + gap + snap, 1); mark(at + gap + fade, 0); } else { mark(at - snap - fade, 0); mark(at - snap, 1); mark(at, 0); }
      }
      mark(1, 0);
      this.svg.querySelectorAll('.field-held-cup .field-steam').forEach(el => this.running.push(el.animate(steam, { duration: motion.ms, fill: 'forwards' })));
      held = switches[switches.length - 1][1];
    }
    // A puff of breath leaves the side of the hands at the mouth, rises and drifts a little, swells and fades over
    // about 1.2 s.
    if (motion.puffs?.length) {
      const d = 1200 / motion.ms, gone = 'translate(5px, -3.4px) scale(1.12)';
      const frames: Keyframe[] = [{ opacity: 0, transform: 'scale(.35)', offset: 0 }];
      for (const start of motion.puffs) {
        const at = (k: number) => Math.min(start + d * k, 1);
        frames.push({ opacity: 0, transform: 'translate(0px, 0px) scale(.35)', offset: at(0), easing: 'ease-out' },
          { opacity: 1, transform: 'translate(1.2px, -.8px) scale(.75)', offset: at(.22) },
          { opacity: .85, transform: 'translate(3.2px, -2px) scale(1)', offset: at(.6), easing: 'ease-in' },
          { opacity: 0, transform: gone, offset: at(1) });
      }
      frames.push({ opacity: 0, transform: gone, offset: 1 });
      this.svg.querySelectorAll('.field-puff').forEach(el => this.running.push(el.animate(frames, { duration: motion.ms, fill: 'forwards' })));
    }
    // A cup handled steadily: the waiting drift and rock ease to rest before the hand reaches it.
    if (Boolean(motion.calm) !== this.calm) {
      this.calm = Boolean(motion.calm);
      this.setAmbient(this.state, 700);
    }
    this.cupMoving = switches.length > 0;
    if (!this.cupMoving && this.pullWaiting) this.pullTo(true);
    const fronts = motion.fronts ?? [];
    if (extra) this.running.push(...extra(motion.ms));
    this.kind = kind;
    if (!this.running.length) { this.commit(to); this.kind = null; return Promise.resolve(true); }
    for (const animation of this.running) this.tune(animation);
    const mine = this.running;
    return new Promise(resolve => {
      this.done = resolve;
      void Promise.all(mine.map(animation => animation.finished)).then(() => {
        if (this.running !== mine) return;
        // Every animation holds its last frame until this point; the same frame goes inline as they are dropped.
        for (const animation of mine) animation.cancel();
        this.running = [];
        this.commit(to);
        for (const front of fronts) this.showFront(front.side, false);
        for (const span of tucked) this.leaveOut(span.side, false);
        if (switches.length) this.showCup(held);
        this.kind = null;
        this.done = null;
        if (this.calm) {
          this.calm = false;
          this.setAmbient(this.state);
        }
        if (this.cupMoving) {
          this.cupMoving = false;
          if (this.pullWaiting) this.pullTo(true);
        }
        resolve(true);
      }, () => undefined);
    });
  }

  /** After a gesture or a change: settle into the base pose if it changed meanwhile, then sit and idle. */
  private resume(first: boolean) {
    if (!this.started || !this.lively() || this.hearting) return;
    if (!same(this.now, this.base())) {
      void this.run({ ms: 1200, keys: [] }, 'transition').then(ok => ok && this.resume(false));
      return;
    }
    this.idle(first);
  }

  /** Sits and breathes, now and then doing something, one thing leading to the next. */
  private idle(first: boolean) {
    this.loop?.abort();
    if (!this.lively()) return;
    const loop = new AbortController();
    this.loop = loop;
    const state = this.state;
    void (async () => {
      if (state === 'puzzled') {
        await this.sleep(first ? 1000 : scratchGap(this.random), loop.signal);
        for (;;) {
          if (!await this.run(SCRATCH, 'idle')) return;
          await this.sleep(scratchGap(this.random), loop.signal);
        }
      }
      const pick = () => nextIdle(state, { night: phaseOf(this.clock()) === 'night', season: seasonOf(this.clock()), pulled: this.pulledIn(),
        last: this.last, random: this.random });
      let next = pick();
      await this.sleep(first ? firstPause(this.random) : next.gap, loop.signal);
      for (;;) {
        // The chair was pulled in meanwhile: the cup stays on the desk, something else instead.
        if (next.id === 'drink' && this.pulledIn()) next = pick();
        this.last = next.id;
        const motion = idleMotion(next.id, { state, flip: this.random() < .5, now: this.now, random: this.random, brief: false, drink: this.drink() });
        if (!await this.run(motion, 'idle')) return;
        next = pick();
        await this.sleep(next.gap, loop.signal);
      }
    })().catch(() => undefined);
  }

  /** A wait that stands still while the tab is hidden (and runs faster at review speed); rejects when the loop is
   * aborted. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      let left = ms / this.rate, since = 0, timer: ReturnType<typeof setTimeout> | undefined;
      const sleeper: Sleeper = {
        pause: () => { if (timer === undefined) return; clearTimeout(timer); timer = undefined; left -= performance.now() - since; },
        resume: () => { if (timer !== undefined) return; since = performance.now(); timer = setTimeout(wake, Math.max(left, 0)); },
        rescale: factor => { const running = timer !== undefined; sleeper.pause(); left *= factor; if (running) sleeper.resume(); },
      };
      const wake = () => { this.sleepers.delete(sleeper); resolve(); };
      signal.addEventListener('abort', () => { clearTimeout(timer); this.sleepers.delete(sleeper); reject(signal.reason); }, { once: true });
      this.sleepers.add(sleeper);
      if (!this.hidden) sleeper.resume();
    });
  }

  /** The greeting heart: arms up from wherever they are, the heart over the head, and down into the state's base
   * pose (the state as it is by then). Nothing interrupts the first two parts. */
  private async heart() {
    this.loop?.abort();
    this.hearting = true;
    const from = this.current();
    const up: Pose = { ...this.base(), ...side(pose(ARMS_UP), 'l'), ...side(pose(ARMS_UP), 'r') } as Pose;
    const down = armDown(from, 'l') || armDown(from, 'r');
    const raise: Motion = down
      ? { ms: 1250, keys: [[.32, REACH_LOW, 'ease-in'], [.62, REACH_HIGH, 'linear']], end: 'ease-out' }
      : { ms: 950, keys: [] };
    const hold: Motion = { ms: HEART_MS, keys: [[.35, { head: 2.5 }], [.55, { head: -1.5 }], [.8, { head: 0 }]] };
    if (!await this.run(raise, 'gesture', up) || !this.hearting) return;
    if (!await this.run(hold, 'gesture', up, ms => this.heartAnimations(ms)) || !this.hearting) return;
    this.hearting = false;
    const target = this.base(), lowering = armDown(target, 'l')
      ? { ms: 1350, keys: [[.34, REACH_HIGH, 'ease-in'], [.66, REACH_LOW, 'linear']], end: 'ease-out' } as Motion
      : { ms: 1000, keys: [] };
    if (await this.run(lowering, 'gesture', target)) this.resume(true);
  }

  private heartAnimations(ms: number): Animation[] {
    const out: Animation[] = [];
    const animate = (selector: string, frames: Keyframe[], easing = 'linear') =>
      this.svg.querySelectorAll(selector).forEach(el => out.push(el.animate(frames, { duration: ms, easing, fill: 'forwards' })));
    const steps = (values: Record<string, string>[]) => values.map((value, i) => ({ ...value, offset: HEART_STEPS[i], easing: 'ease-in-out' }));
    // Jointed arms out while the drawn ones are fully there, and back before those go.
    animate('.field-upper-l:not(.field-front), .field-upper-r:not(.field-front)', [{ opacity: 1 }, { opacity: 1, offset: .03 }, { opacity: 0, offset: .04 },
      { opacity: 0, offset: .95 }, { opacity: 1, offset: .96 }, { opacity: 1 }]);
    animate('.field-heart-arms', [{ opacity: 0 }, { opacity: 1, offset: .02 }, { opacity: 1, offset: .97 }, { opacity: 0, offset: .98 }, { opacity: 0 }]);
    this.svg.querySelectorAll<SVGPathElement>('.field-heart-arms path[data-up]').forEach(path => {
      const straight = `path("${path.dataset.up}")`, heart = `path("${path.dataset.heart}")`;
      out.push(path.animate(steps([{ d: straight }, { d: straight }, { d: heart }, { d: heart }, { d: straight }, { d: straight }]), { duration: ms, fill: 'forwards' }));
    });
    this.svg.querySelectorAll<SVGGElement>('.field-heart-hand').forEach(hand => {
      const straight = hand.dataset.up!, heart = hand.dataset.heart!;
      out.push(hand.animate(steps([{ transform: straight }, { transform: straight }, { transform: heart }, { transform: heart },
        { transform: straight }, { transform: straight }]), { duration: ms, fill: 'forwards' }));
    });
    animate('.field-heart', [{ opacity: 0, transform: 'translateY(4px) scale(.6)' }, { opacity: 0, transform: 'translateY(4px) scale(.6)', offset: .24 },
      { opacity: 1, transform: 'scale(1.1)', offset: .32 }, { opacity: 1, transform: 'translateY(-3px)', offset: .6 },
      { opacity: 0, transform: 'translateY(-8px) scale(.9)', offset: .74 }, { opacity: 0 }], 'ease-out');
    return out;
  }
}
