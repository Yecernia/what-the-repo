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
import { phaseOf } from './occasions';

export type FieldPose = 'rest' | 'waiting' | 'puzzled';

/** The jointed groups, outermost first; each arm and forearm exists twice (outline pass and filling pass). `lean`
 * reclines the figure and chair together about the hips (the backrest reclines with the body). */
const PARTS = ['lean', 'rock', 'stretch-body', 'head', 'upper-l', 'fore-l', 'upper-r', 'fore-r'] as const;
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
 * both moments where the hand is behind the lid or beside the head, so the switch cannot be seen. */
interface Front { side: 'l' | 'r'; on: number; off: number; ramp?: number }
/** A move: its steps, then back to its end pose (the base pose of the state unless said otherwise). */
interface Motion { ms: number; keys: Key[]; end?: string; fronts?: Front[] }

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
const ARMS_UP: Shape = { 'upper-l': 19, 'fore-l': -114, 'upper-r': -19, 'fore-r': 114 };
/** On the way between the keyboard and the head: elbows out to the sides, hands beside the face. */
const ELBOWS_OUT: Shape = { 'upper-l': -61, 'fore-l': 25, 'upper-r': 61, 'fore-r': -25 };
/** On the way from the keyboard up overhead: hands out wide, then up. */
const REACH_LOW: Shape = { 'upper-l': -90, 'fore-l': 20, 'upper-r': 90, 'fore-r': -20 };
const REACH_HIGH: Shape = { 'upper-l': -30, 'fore-l': -60, 'upper-r': 30, 'fore-r': 60 };

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
  | 'yawn' | 'rub-eye' | 'rock';
/** What the gallery can ask for: every idle action and gesture; `chin-long` is the full chin hold, `chin` a short one. */
export type FieldCue = IdleAction | 'chin-long' | 'wave' | 'lean-in' | 'heart';

/** The small things the figure does, by state. Weights are relative; night-only ones need the local night (phaseOf,
 * 19–05). Waiting is boring, so leaning back in the chair (three ways) dominates there. */
export const IDLE_ACTIONS: Record<'rest' | 'waiting', Array<{ id: IdleAction; weight: number; night?: true }>> = {
  rest: [
    { id: 'chin', weight: 5 }, { id: 'look-aside', weight: 5 }, { id: 'lean-back', weight: 2 },
    { id: 'lean-back-left', weight: 1 }, { id: 'lean-back-right', weight: 1 }, { id: 'nod', weight: 3 }, { id: 'stretch', weight: 1 },
    { id: 'yawn', weight: 2, night: true }, { id: 'rub-eye', weight: 1.5, night: true },
  ],
  waiting: [
    { id: 'lean-back', weight: 5 }, { id: 'lean-back-left', weight: 4 }, { id: 'lean-back-right', weight: 4 }, { id: 'rock', weight: 3 },
    { id: 'look-aside', weight: 3 }, { id: 'stretch', weight: 1 }, { id: 'yawn', weight: 2, night: true },
  ],
};
/** What sometimes comes next, and how often: after a long lean back the figure sits up and stretches; after a stretch
 * it leans back; at night a yawn is followed by rubbing an eye. A follow-up comes after a natural pause (chainGap). */
export const FOLLOW_UPS: Record<'rest' | 'waiting', Partial<Record<IdleAction, Array<[IdleAction, number]>>>> = {
  rest: {
    'lean-back': [['stretch', .22]], 'lean-back-left': [['stretch', .22]], 'lean-back-right': [['stretch', .22]],
    stretch: [['lean-back', .2]], yawn: [['rub-eye', .3]], chin: [['nod', .1]],
  },
  waiting: {
    stretch: [['lean-back', .2]], yawn: [['lean-back', .15]],
    'lean-back': [['rock', .1]], 'lean-back-left': [['rock', .1]], 'lean-back-right': [['rock', .1]],
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
 * Night-only actions only at night; never the same action (or lean) twice in a row. */
export function nextIdle(state: 'rest' | 'waiting', { night, last, random = Math.random }: { night: boolean; last: IdleAction | null; random?: () => number }):
  { id: IdleAction; gap: number } {
  const allowed = (id: IdleAction) => (night || !IDLE_ACTIONS[state].find(action => action.id === id)?.night)
    && IDLE_ACTIONS[state].some(action => action.id === id) && (!last || family(id) !== family(last));
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
 * The left hand at the face (mirrored for the right), in front of it. `visit` is the time at the face. From the
 * keyboard the hand rises from behind the lid, where its front copy is switched on unseen, and goes back there before
 * it is switched off; from behind the head it first reaches up and out to the side, clear of head and body, and is
 * switched there (over a few frames).
 */
function faceMotion(fromKeyboard: boolean, visit: Step[], back = 900): Motion {
  // The hand stays at the face for the whole visit: every step names the arm (as the last step that moved it left
  // it), so the body and head can finish what they do before the hand goes.
  let arm: Shape = {};
  visit = visit.map(([ms, shape, easing]): Step => {
    arm = { ...arm, ...side(shape, 'l') };
    return [ms, { ...arm, ...shape }, easing];
  });
  if (fromKeyboard) {
    const line = timeline([[450, { 'upper-l': -160, 'fore-l': 95 }, 'ease-in'], ...visit], back);
    return { ...line, fronts: [{ side: 'l', on: line.time(30), off: 1 - line.time(60) }] };
  }
  const out = side(REACH_HIGH, 'l'), chest: Shape = { 'upper-l': -75, 'fore-l': 45 };
  const line = timeline([[700, out, 'ease-in-out'], [500, chest, 'linear'], ...visit, [600, chest, 'ease-in'], [500, out, 'linear']], 800);
  const steps = visit.length + 4;
  return { ...line, fronts: [{ side: 'l', on: line.at(0), off: line.at(steps - 1), ramp: line.time(260) }] };
}

interface Context { state: FieldPose; flip: boolean; now: Pose; random: () => number; brief: boolean }

/** The actions, with real durations: a chin held for half a minute, a lean back of ten to twenty-five seconds, a
 * short glance or a longer gaze. Big moves start with a little anticipation and end with a gentle overshoot. */
function idleMotion(id: IdleAction, { state, flip, now, random, brief }: Context): Motion {
  const rnd = (low: number, high: number) => between(low, high, random);
  const rest = state !== 'waiting', baseLean = rest ? 1 : WAIT_LEAN;
  const keyboard = armDown(now, flip ? 'r' : 'l');
  switch (id) {
    case 'chin': { // The jaw rests on a mitten a long while: the head tilts now and then, the hand shifts, then sits up.
      const visit: Step[] = [[800, { 'upper-l': -194, 'fore-l': 85, head: { r: -1.5, y: .5 } }, 'ease-out'], [500, { head: { r: -4.5, y: 1.9 } }]];
      for (let left = brief ? rnd(4000, 5000) : rnd(12_000, 30_000); left > 0;) {
        const pause = rnd(2500, 5000);
        visit.push([Math.min(pause, Math.max(left, 1200)), {
          head: { r: -rnd(2, 5.5), y: rnd(1.4, 2.2) }, 'fore-l': 85 + rnd(-1.8, 1.8), ...(random() < .3 && { 'upper-l': -194 + rnd(-2, 2) }),
        }]);
        left -= pause;
      }
      visit.push([650, { head: { r: .5, y: -.6 } }, 'ease-in-out']);
      return mirrored(faceMotion(keyboard, visit, 900), flip);
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
      const hold = rnd(700, 2000);
      if (!rest) { // One arm reaches up, the other out to the side; the chair reclines further; then all fold back.
        return mirrored(timeline([
          [300, { 'stretch-body': { y: .8 }, ...armsOf(now) }, 'ease-out'],
          [1500, { 'upper-l': 19, 'fore-l': -114, 'upper-r': -1, 'fore-r': 140, 'stretch-body': { r: 3.5 }, head: { r: -3, s: .97, sy: 1 / .89 }, lean: { sy: .89 } }, 'ease-in-out'],
          [400, { 'upper-l': 23, 'fore-l': -119, 'upper-r': -4, 'fore-r': 148, 'stretch-body': { r: 4.8 }, head: { r: -3, s: .97, sy: 1 / .875 }, lean: { sy: .875 } }, 'ease-out'],
          [hold, { 'upper-l': 21, 'fore-l': -116, 'upper-r': -2, 'fore-r': 144, 'stretch-body': { r: 4.3 }, head: { r: -2.5, s: .97, sy: 1 / .88 }, lean: { sy: .88 } }],
        ], 1700, 'ease-in-out'), flip);
      }
      // A little hunch first, then both arms up from the keys, out wide and overhead while the person leans back
      // against the backrest (body and chair recline together, as in the lean back); a long reach, and back down.
      const lean = (sy: number) => ({ lean: { sy }, head: { s: .97 + .03 * (sy - .9) / .1, sy: 1 / sy } });
      return timeline([
        [350, { 'stretch-body': { y: 1.2 }, ...lean(1.01), ...armsOf(now) }, 'ease-out'],
        [550, { ...REACH_LOW, 'stretch-body': { y: 0 }, ...lean(.985) }, 'ease-in'],
        [450, { ...REACH_HIGH, ...lean(.95) }, 'linear'],
        [550, { ...ARMS_UP, ...lean(.91) }, 'ease-out'],
        [400, { 'upper-l': 24, 'fore-l': -119, 'upper-r': -24, 'fore-r': 119, ...lean(.895), head: { s: .97, sy: 1 / .895, r: -2 } }],
        [hold, { 'upper-l': 22, 'fore-l': -117, 'upper-r': -22, 'fore-r': 117, ...lean(.9), head: { s: .97, sy: 1 / .9, r: 1 } }],
        [600, { ...REACH_HIGH, ...lean(.95), head: { s: .985, sy: 1 / .95, r: 0 } }, 'ease-in'],
        [450, { ...REACH_LOW, ...lean(1.008) }, 'linear'],
      ], 650, 'ease-out');
    }
    case 'yawn': // Shoulders rise and the head tips back while one mitten covers the mouth; the other arm stays put.
      return mirrored(faceMotion(keyboard, [
        [650, { 'upper-l': -209.5, 'fore-l': 92.5, 'stretch-body': { y: -1.2, sy: 1.025 }, head: { y: -1.4, sy: .95, r: -1 } }, 'ease-out'],
        [1300, { 'fore-l': 91.5, 'stretch-body': { y: -1.9, sy: 1.035 }, head: { y: -2.2, sy: .93, r: -1.5 } }, 'ease-in-out'],
        [700, { 'stretch-body': { y: 0, sy: 1 }, head: { y: -.3, sy: .99, r: .8 } }, 'ease-in-out'],
        [400, { head: { y: .5, sy: 1, r: 0 } }, 'ease-out'],
      ], 800), flip);
    case 'rub-eye': { // A mitten comes up in front of the face to one eye and rubs it in small circles, head tilted into it.
      const visit: Step[] = [[700, { 'upper-l': -227, 'fore-l': 93, head: { r: -3, y: 1 } }, 'ease-out']];
      for (let left = rnd(2000, 4000), i = 0; left > 0; i++) {
        const beat = rnd(170, 230);
        visit.push([beat, i % 2 ? { 'upper-l': -229, 'fore-l': 89 } : { 'upper-l': -225, 'fore-l': 97.5 }]);
        left -= beat;
      }
      visit.push([300, { 'upper-l': -227, 'fore-l': 93, head: { r: 0, y: 0 } }]);
      return mirrored(faceMotion(keyboard, visit, 900), flip);
    }
  }
}

/** For tests: an action's steps (0–1) from the rest or the waiting pose, each naming the parts it moves. */
export function idleSteps(id: IdleAction, state: 'rest' | 'waiting', random: () => number = Math.random) {
  return idleMotion(id, { state, flip: false, now: BASE[state], random, brief: false }).keys
    .map(([at, shape]) => ({ at, parts: Object.fromEntries(Object.entries(shape).map(([part, value]) => [part, change(STILL, value)])) as Partial<Pose> }));
}

/** For tests: how long an action lasts from the rest or the waiting pose. */
export function idleDuration(id: IdleAction, state: 'rest' | 'waiting', random: () => number = Math.random) {
  return idleMotion(id, { state, flip: false, now: BASE[state], random, brief: false }).ms;
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
  const ms = motion.ms + 750, k = 750 / ms, safe: Shape = {};
  for (const which of sides) Object.assign(safe, side(armDown(to, which) ? REST_ARMS : REACH_HIGH, which));
  return {
    ms, end: motion.end,
    keys: [[k, safe, 'ease-in-out'], ...motion.keys.map(([at, shape, easing]): Key => [k + at * (1 - k), shape, easing])],
    fronts: [...(motion.fronts ?? []).map(front => ({ ...front, on: k + front.on * (1 - k), off: k + front.off * (1 - k) })),
      ...sides.map(which => ({ side: which, on: 0, off: k, ramp: armDown(to, which) ? 30 / ms : 260 / ms }))],
  };
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
function ambientFor(state: FieldPose | null): Record<Slot, Loop | null> {
  if (!state) return { breath: null, drift: null, sway: null, 'head-drift': null, 'head-sway': null };
  const waiting = state === 'waiting';
  return { breath: LOOPS.breath, drift: waiting ? LOOPS.waitLean : null, sway: waiting ? LOOPS.waitRock : null,
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
  /** Whose front copy (the hand drawn in front of the face) is showing. */
  private shown = { l: false, r: false };
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
    this.loop?.abort();
    const id: IdleAction = cue === 'chin-long' ? 'chin' : cue;
    this.last = id;
    const motion = idleMotion(id, { state: this.state, flip: this.random() < .5, now: this.current(), random: this.random, brief: cue === 'chin' });
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

  /** Moves the chair in (a question in the composer, at rest) or back, from wherever it is, on its own group: an
   * unhurried pull with a slight overshoot, or straight at once when not animating. */
  private pullTo(animate: boolean) {
    const el = this.svg.querySelector<SVGElement>('.field-pull');
    if (!el) return;
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
  private setAmbient(state: FieldPose | null) {
    const wanted = ambientFor(state && this.lively() ? state : null);
    for (const slot of Object.keys(wanted) as Slot[]) {
      const el = this.svg.querySelector<SVGElement>(`.field-${slot}`);
      const current = this.ambient.get(slot), loop = wanted[slot];
      if (!el || (current && current.loop === loop)) continue;
      if (!loop && !current) continue;
      const from = getComputedStyle(el).transform;
      current?.animation.cancel();
      if (!this.lively()) { this.ambient.delete(slot); continue; }
      const rest = loop ? String(loop.frames[0].transform) : 'none';
      const ease = el.animate([{ transform: from === 'none' ? rest : from }, { transform: rest }], { duration: 1200, easing: 'ease-in-out', fill: 'forwards' });
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
      for (const animation of this.running) animation.cancel();
      this.running = [];
      this.commit(here);
      this.showFront('l', front[0]);
      this.showFront('r', front[1]);
    }
    this.kind = null;
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
    this.setAmbient(null);
    this.pullTo(false);
  }

  private showFront(which: 'l' | 'r', on: boolean) {
    this.shown[which] = on;
    this.svg.querySelectorAll<SVGElement>(`.field-front-${which}`).forEach(el => { el.style.opacity = on ? '1' : ''; });
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
    // for a moment, change by no more than a shade.
    for (const { side: which, on, off, ramp = .01 } of motion.fronts ?? []) {
      const start = this.shown[which] ? 1 : 0;
      const frames: Keyframe[] = [{ opacity: start, offset: 0 }, { opacity: start, offset: on }, { opacity: 1, offset: Math.min(on + ramp, off) },
        { opacity: 1, offset: off }, { opacity: 0, offset: Math.min(off + ramp, 1) }, { opacity: 0, offset: 1 }];
      this.svg.querySelectorAll(`.field-front-${which}`).forEach(el => this.running.push(el.animate(frames, { duration: motion.ms, fill: 'forwards' })));
    }
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
        this.kind = null;
        this.done = null;
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
      let next = nextIdle(state, { night: phaseOf(this.clock()) === 'night', last: this.last, random: this.random });
      await this.sleep(first ? firstPause(this.random) : next.gap, loop.signal);
      for (;;) {
        this.last = next.id;
        const motion = idleMotion(next.id, { state, flip: this.random() < .5, now: this.now, random: this.random, brief: false });
        if (!await this.run(motion, 'idle')) return;
        next = nextIdle(state, { night: phaseOf(this.clock()) === 'night', last: this.last, random: this.random });
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
      const straight = `translate(${hand.dataset.up})`, heart = `translate(${hand.dataset.heart})`;
      out.push(hand.animate(steps([{ transform: straight }, { transform: straight }, { transform: heart }, { transform: heart },
        { transform: straight }, { transform: straight }]), { duration: ms, fill: 'forwards' }));
    });
    animate('.field-heart', [{ opacity: 0, transform: 'translateY(4px) scale(.6)' }, { opacity: 0, transform: 'translateY(4px) scale(.6)', offset: .24 },
      { opacity: 1, transform: 'scale(1.1)', offset: .32 }, { opacity: 1, transform: 'translateY(-3px)', offset: .6 },
      { opacity: 0, transform: 'translateY(-8px) scale(.9)', offset: .74 }, { opacity: 0 }], 'ease-out');
    return out;
  }
}
