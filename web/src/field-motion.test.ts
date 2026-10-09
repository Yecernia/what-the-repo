import { describe, expect, it } from 'vitest';
import { ARMS_UP, armTurn, CUP_OVERLAP_MS, EYE, FOLLOW_UPS, firstPause, FRONT_FADE_MS, greetAtOpening, handAt, HEART_SEEN_KEY, IDLE_ACTIONS, idleDuration, idleGap, idleSteps, isOpening, MOUTH, nextIdle,
  type IdleAction } from './field-motion';

/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

describe('desk figure idle scheduler', () => {
  it('sits still for 2–3 s when it appears', () => {
    expect(firstPause(() => 0)).toBe(2000);
    expect(firstPause(() => .999)).toBeLessThan(3000);
  });

  it('waits 8–16 s from the end of one action to the start of the next at rest, mostly 8–12 s', () => {
    const random = seeded(2), gaps = Array.from({ length: 4000 }, () => idleGap('rest', random));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8000);
    expect(Math.max(...gaps)).toBeLessThan(16_000);
    expect(gaps.filter(ms => ms < 12_000).length / gaps.length).toBeCloseTo(.65, 1);
  });

  it('waits 3–8 s between actions while waiting', () => {
    const random = seeded(3), gaps = Array.from({ length: 2000 }, () => idleGap('waiting', random));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3000);
    expect(Math.max(...gaps)).toBeLessThan(8000);
  });

  it('never repeats an action (or leans back twice) in a row', () => {
    const lean = (id: IdleAction) => id.startsWith('lean-back');
    for (const state of ['rest', 'waiting'] as const) {
      const random = seeded(4);
      let last: IdleAction | null = null;
      for (let i = 0; i < 3000; i++) {
        const { id } = nextIdle(state, { night: i % 2 === 0, last, random });
        if (last) expect(id === last || (lean(id) && lean(last))).toBe(false);
        last = id;
      }
    }
  });

  it('has no typing action any more', () => {
    for (const actions of Object.values(IDLE_ACTIONS)) expect(actions.map(action => action.id as string)).not.toContain('typing');
  });

  it('only yawns or rubs an eye at night', () => {
    const nightOnly = new Set(['yawn', 'rub-eye']);
    for (const state of ['rest', 'waiting'] as const) {
      const random = seeded(5), byDay = new Set<IdleAction>(), byNight = new Set<IdleAction>();
      let day: IdleAction | null = null, night: IdleAction | null = null;
      for (let i = 0; i < 3000; i++) {
        day = nextIdle(state, { night: false, last: day, random }).id;
        night = nextIdle(state, { night: true, last: night, random }).id;
        byDay.add(day);
        byNight.add(night);
      }
      expect([...byDay].filter(id => nightOnly.has(id))).toEqual([]);
      expect([...byNight].some(id => nightOnly.has(id))).toBe(true);
    }
  });

  it('sometimes chains actions after a natural pause: a stretch after leaning back, a lean after a stretch', () => {
    const after = (state: 'rest' | 'waiting', last: IdleAction, night = false) => {
      const random = seeded(6), counts = new Map<IdleAction, number>(), gaps: number[] = [];
      for (let i = 0; i < 4000; i++) {
        const next = nextIdle(state, { night, last, random });
        counts.set(next.id, (counts.get(next.id) ?? 0) + 1);
        gaps.push(next.gap);
      }
      return { share: (id: IdleAction) => (counts.get(id) ?? 0) / 4000, gaps };
    };
    const leaned = after('rest', 'lean-back');
    expect(leaned.share('stretch')).toBeGreaterThan(.22);
    expect(leaned.share('stretch')).toBeLessThan(.4);
    expect(after('rest', 'stretch').share('lean-back')).toBeGreaterThan(.2);
    expect(after('rest', 'yawn', true).share('rub-eye')).toBeGreaterThan(.3);
    // A follow-up comes after a pause of 1.5–3 s, the rest after a full gap; nothing comes sooner.
    expect(leaned.gaps.some(ms => ms >= 1500 && ms < 3000)).toBe(true);
    expect(Math.min(...leaned.gaps)).toBeGreaterThanOrEqual(1500);
    expect(FOLLOW_UPS.rest['lean-back']?.[0]).toEqual(['stretch', .22]);
    for (const follows of Object.values(FOLLOW_UPS.rest)) for (const [, odds] of follows ?? []) expect(odds).toBeLessThanOrEqual(.3);
  });

  it('while waiting, leans back far more often than anything else', () => {
    const random = seeded(7), counts = new Map<string, number>();
    let last: IdleAction | null = null;
    for (let i = 0; i < 6000; i++) {
      last = nextIdle('waiting', { night: false, last, random }).id;
      const key = last.startsWith('lean-back') ? 'lean' : last;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const lean = counts.get('lean')! / 6000;
    expect(lean).toBeGreaterThan(.38);
    for (const [key, count] of counts) if (key !== 'lean') expect(count / 6000).toBeLessThan(lean / 1.4);
    const waiting = IDLE_ACTIONS.waiting, rest = IDLE_ACTIONS.rest, weight = (list: typeof rest, id: string) => list.find(item => item.id === id)!.weight;
    expect(weight(waiting, 'lean-back-left')).toBeGreaterThan(weight(rest, 'lean-back-left'));
  });

  it('gives each action a real duration', () => {
    const random = seeded(8);
    const range = (id: IdleAction, state: 'rest' | 'waiting') => {
      const all = Array.from({ length: 200 }, () => idleDuration(id, state, random));
      return [Math.min(...all), Math.max(...all)];
    };
    const within = ([low, high]: number[], min: number, max: number) => { expect(low).toBeGreaterThanOrEqual(min); expect(high).toBeLessThanOrEqual(max); };
    within(range('chin', 'rest'), 12_000, 36_000);             // held 12–30 s, plus the hand coming up and going back
    within(range('lean-back', 'rest'), 10_000, 31_000);        // held 10–25 s, plus reclining and sitting up
    within(range('lean-back-left', 'waiting'), 6000, 21_000);  // held 6–15 s while waiting
    within(range('nod', 'rest'), 1000, 2200);                  // about 1.5 s, sometimes two nods
    within(range('look-aside', 'rest'), 2000, 7000);           // a 2–4 s glance or a 4–6 s gaze
    within(range('stretch', 'rest'), 5000, 7000);             // a calm 5–7 s: up, a 1–1.5 s hold, a long breath out
    within(range('yawn', 'rest'), 3500, 5500);                 // about 3.5 s at the mouth
    within(range('rub-eye', 'rest'), 3500, 7000);              // 2–4 s of rubbing, plus the hand's way
  });
});

describe('desk figure stretch at rest', () => {
  type Steps = ReturnType<typeof idleSteps>;
  type Step = Steps[number];
  const SHOULDER = { l: [97, 72], r: [129, 72] } as const, ELBOW = { l: [70, 42], r: [156, 42] } as const;
  const REST = { l: -120, r: 120 } as const;
  const named = (steps: Steps, which: 'l' | 'r') => steps.filter(step => step.parts[`upper-${which}`] && step.parts[`fore-${which}`]);
  const hand = (step: Step, which: 'l' | 'r') => handAt(which, step.parts[`upper-${which}`]!.r, step.parts[`fore-${which}`]!.r);
  /** The elbow's inside angle (180: the arm straight). */
  const inside = (step: Step, which: 'l' | 'r') => {
    const [sx, sy] = SHOULDER[which], [ex, ey] = ELBOW[which], a = step.parts[`upper-${which}`]!.r * Math.PI / 180;
    const elbow = [sx + (ex - sx) * Math.cos(a) - (ey - sy) * Math.sin(a), sy + (ex - sx) * Math.sin(a) + (ey - sy) * Math.cos(a)];
    const [hx, hy] = hand(step, which), up = [sx - elbow[0], sy - elbow[1]], down = [hx - elbow[0], hy - elbow[1]];
    return Math.acos((up[0] * down[0] + up[1] * down[1]) / Math.hypot(up[0], up[1]) / Math.hypot(down[0], down[1])) * 180 / Math.PI;
  };
  /** The top of each arm's way: its highest hand. */
  const top = (steps: Steps, which: 'l' | 'r') => named(steps, which).reduce((best, step) => hand(step, which)[1] < hand(best, which)[1] ? step : best);
  const pick = seeded(99), seeds = Array.from({ length: 24 }, () => Math.floor(pick() * 2 ** 32));

  it('one arm rises 150–250 ms ahead of the other, either arm first, each staying at the keys until it goes', () => {
    const leads = new Set<string>();
    for (const seed of seeds) {
      const steps = idleSteps('stretch', 'rest', seeded(seed));
      const rises = (['l', 'r'] as const).map(which => {
        const way = named(steps, which), first = way.findIndex(step => step.parts[`upper-${which}`]!.r !== REST[which]);
        // Named at the keys (so it stays there) up to the moment it sets off.
        expect(first).toBeGreaterThan(0);
        expect(way[first - 1].parts[`upper-${which}`]!.r).toBe(REST[which]);
        return way[first - 1].at * steps.ms;
      });
      const gap = rises[1] - rises[0];
      expect(Math.abs(gap)).toBeGreaterThanOrEqual(150);
      expect(Math.abs(gap)).toBeLessThanOrEqual(250);
      leads.add(gap > 0 ? 'l' : 'r');
    }
    expect([...leads].sort()).toEqual(['l', 'r']);
  });

  it('holds 1–1.5 s with the hands meeting over the head, the elbows a little bent, the arms unlike and the body bent to one side', () => {
    for (const seed of seeds) {
      const steps = idleSteps('stretch', 'rest', seeded(seed));
      const [l, r] = [top(steps, 'l'), top(steps, 'r')], [hl, hr] = [hand(l, 'l'), hand(r, 'r')];
      // Over the head (its top at 29), the hands meeting or nearly so; not straight up beside it (the heart's pose).
      expect(Math.max(hl[1], hr[1])).toBeLessThan(10);
      expect(Math.hypot(hl[0] - hr[0], hl[1] - hr[1])).toBeLessThan(10);
      for (const [step, which] of [[l, 'l'], [r, 'r']] as const) {
        expect(inside(step, which)).toBeGreaterThan(120);
        expect(inside(step, which)).toBeLessThan(165);
      }
      // The two arms differ: one reaches straighter.
      expect(Math.abs(inside(l, 'l') - inside(r, 'r'))).toBeGreaterThan(5);
      // Reclined with the chair, the head tipped back, and at the end of the hold the body bent a few degrees.
      const body = steps.filter(step => step.parts['stretch-body']);
      const bent = body.reduce((most, step) => Math.abs(step.parts['stretch-body']!.r) > Math.abs(most.parts['stretch-body']!.r) ? step : most);
      expect(Math.abs(bent.parts['stretch-body']!.r)).toBeGreaterThanOrEqual(3);
      expect(Math.abs(bent.parts['stretch-body']!.r)).toBeLessThanOrEqual(6);
      expect(bent.parts.lean!.sy).toBeLessThan(.92);
      expect(bent.parts.head!.y).toBeLessThan(0);
      // The hold: from both hands over the head to the end of the bend, where the release starts.
      const over = (which: 'l' | 'r') => named(steps, which).find(step => hand(step, which)[1] < 10)!.at;
      const hold = (bent.at - Math.max(over('l'), over('r'))) * steps.ms;
      expect(hold).toBeGreaterThanOrEqual(1000);
      expect(hold).toBeLessThanOrEqual(1500);
    }
  });

  it('comes down unlike: the reaching arm opens out wide in an arc and bends as it lowers, the other stays narrower', () => {
    for (const seed of seeds) {
      const steps = idleSteps('stretch', 'rest', seeded(seed));
      const after = (which: 'l' | 'r') => named(steps, which).filter(step => step.at > top(steps, which).at);
      const reach = after('l'), other = after('r');
      // Out past the side of the body (the shoulder is at 97) …
      const widest = reach.reduce((best, step) => hand(step, 'l')[0] < hand(best, 'l')[0] ? step : best);
      expect(hand(widest, 'l')[0]).toBeLessThan(45);
      // … opening outward first, nearly straight: the hand goes out to the side while still high, then down.
      const open = reach.find(step => hand(step, 'l')[0] < 60)!;
      expect(hand(open, 'l')[1]).toBeLessThan(30);
      expect(inside(open, 'l')).toBeGreaterThan(145);
      // The elbow bends as it lowers.
      const lowered = reach.filter(step => hand(step, 'l')[1] > 60 && step.parts['upper-l']!.r !== REST.l);
      expect(lowered.length).toBeGreaterThan(0);
      for (const step of lowered) expect(inside(step, 'l')).toBeLessThan(inside(open, 'l') - 20);
      // The other arm (its hand mirrored onto the left to compare) stays narrower, and bends too.
      const otherWidest = Math.max(...other.map(step => hand(step, 'r')[0]));
      expect(226 - otherWidest).toBeGreaterThan(hand(widest, 'l')[0] + 20);
      expect(Math.min(...other.map(step => inside(step, 'r')))).toBeLessThan(90);
    }
  });

  it('lets the shoulders drop first and the body come upright before the hands go back behind the lid, last', () => {
    for (const seed of seeds) {
      const steps = idleSteps('stretch', 'rest', seeded(seed));
      const neutral = (step: Step) => Math.abs(step.parts.lean!.sy - 1) <= .005 && step.parts['stretch-body']!.r === 0 && step.parts['stretch-body']!.y === 0
        && step.parts.head!.y === 0 && step.parts.head!.r === 0;
      const body = steps.filter(step => step.parts.lean);
      // Every body step names the chair, the body and the head (so none is left where another step put it).
      for (const step of body) expect(step.parts['stretch-body'] && step.parts.head).toBeTruthy();
      // At the start the shoulders lift (a small inhale); after the hold they drop before the body is upright.
      expect(body[0].parts['stretch-body']!.y).toBeLessThan(0);
      const bend = body.findIndex(step => Math.abs(step.parts['stretch-body']!.r) >= 3);
      expect(body[bend + 1].parts['stretch-body']!.y).toBeGreaterThanOrEqual(0);
      expect(neutral(body[bend + 1])).toBe(false);
      const upright = body.find((step, i) => i > bend && neutral(step))!;
      for (const step of body.filter(item => item.at >= upright.at)) expect(neutral(step)).toBe(true);
      // The hands are still out in view when the body is upright (the chair settling a hair past it), and back at the keys only after it.
      for (const which of ['l', 'r'] as const) {
        const way = named(steps, which), home = way[way.length - 1], before = way[way.length - 2];
        expect(home.parts[`upper-${which}`]!.r).toBe(REST[which]);
        expect(home.at).toBeGreaterThan(upright.at);
        expect(before.at).toBeGreaterThanOrEqual(upright.at - 1e-9);
        const [x, y] = hand(before, which);
        expect(y - 7 < 79.5 || x + 7 < 69 || x - 7 > 171).toBe(true);
      }
      expect(steps.ms).toBeGreaterThanOrEqual(5000);
      expect(steps.ms).toBeLessThanOrEqual(7000);
    }
  });

  it('keeps the waiting stretch and the heart\'s arms-up pose as they were', () => {
    const hold = 700 + seeded(5)() * 1300, ms = 300 + 1500 + 400 + hold + 1700;
    const steps = idleSteps('stretch', 'waiting', seeded(5));
    expect(steps.ms).toBeCloseTo(ms, 6);
    expect(steps.map(step => step.at)).toEqual([300, 1800, 2200, 2200 + hold].map(at => expect.closeTo(at / ms, 9)));
    const arms = (step: Step) => (['upper-l', 'fore-l', 'upper-r', 'fore-r'] as const).map(part => step.parts[part]!.r);
    expect(arms(steps[1])).toEqual([19, -114, -1, 140]);
    expect(arms(steps[2])).toEqual([23, -119, -4, 148]);
    expect(arms(steps[3])).toEqual([21, -116, -2, 144]);
    expect(steps[3].parts.lean!.sy).toBe(.88);
    expect(steps[3].parts['stretch-body']!.r).toBe(4.3);
    // The heart: both arms straight up beside the head, where the drawn heart arms (FieldIllustration.tsx) take over.
    expect(ARMS_UP).toEqual({ 'upper-l': 19, 'fore-l': -114, 'upper-r': -19, 'fore-r': 114 });
    const [lx, ly] = handAt('l', 19, -114), [rx, ry] = handAt('r', -19, 114);
    expect(Math.hypot(lx - 72.8, ly + 3.9)).toBeLessThan(.5);
    expect(Math.hypot(rx - 153.2, ry + 3.9)).toBeLessThan(.5);
    // The heart's hands are placed by the forearm's own turn: it carries the mitten exactly where handAt puts it.
    for (const [which, upper, fore, mitten] of [['l', 19, -114, [108.9, 37]], ['r', -19, 114, [117.1, 37]], ['l', -120, 104, [108.9, 37]]] as const) {
      const { r, x, y } = armTurn(which, upper, fore), a = r * Math.PI / 180;
      const [hx, hy] = handAt(which, upper, fore);
      expect(r).toBe(upper + fore);
      expect(mitten[0] * Math.cos(a) - mitten[1] * Math.sin(a) + x).toBeCloseTo(hx, 9);
      expect(mitten[0] * Math.sin(a) + mitten[1] * Math.cos(a) + y).toBeCloseTo(hy, 9);
    }
  });

  it('fades a hand\'s front copy over a fixed few frames, done before the desk cup goes when the cup changes hands', () => {
    expect(FRONT_FADE_MS).toBeGreaterThanOrEqual(30);
    expect(FRONT_FADE_MS).toBeLessThanOrEqual(50);
    expect(CUP_OVERLAP_MS).toBeGreaterThan(FRONT_FADE_MS);
    // A sip's front copy comes and goes with the cup, at the very moments it changes hands, and fades as long as any.
    for (const state of ['rest', 'waiting'] as const) {
      const steps = idleSteps('drink', state, seeded(8));
      expect(steps.fronts.map(front => [front.on, front.off, front.ramp])).toEqual([[steps.cup[0][0], steps.cup[1][0], undefined]]);
    }
  });
});

describe('desk figure yawn', () => {
  /** A step that names the left arm with its mitten at the mouth. */
  const covering = (step: { parts: Record<string, { r: number; s: number } | undefined> }) => {
    const upper = step.parts['upper-l'], fore = step.parts['fore-l'];
    if (!upper || !fore) return false;
    const [x, y] = handAt('l', upper.r, fore.r, upper.s);
    return Math.hypot(x - MOUTH[0], y - MOUTH[1]) < 1.5;
  };
  it('lowers the hand from the mouth only after the shoulders and head have recovered', () => {
    for (const state of ['rest', 'waiting'] as const) {
      const steps = idleSteps('yawn', state, seeded(9));
      const atMouth = steps.filter(covering);
      expect(atMouth.length).toBeGreaterThan(2);
      const covered = atMouth[0].at, handLeaves = atMouth[atMouth.length - 1].at;
      // Shoulders up and head tipped back while the mouth is covered…
      const peak = steps.find(step => step.at > covered && (step.parts['stretch-body']?.sy ?? 1) > 1.02);
      expect(peak).toBeDefined();
      // …then both back to normal, and only then does the hand leave.
      const bodyBack = steps.find(step => step.at > peak!.at && step.parts['stretch-body']?.sy === 1 && step.parts['stretch-body']?.y === 0);
      const headBack = steps.find(step => step.at > peak!.at && step.parts.head?.sy === 1 && step.parts.head?.r === 0);
      expect(bodyBack && headBack).toBeTruthy();
      expect(handLeaves).toBeGreaterThanOrEqual(bodyBack!.at);
      expect(handLeaves).toBeGreaterThanOrEqual(headBack!.at);
      // Every step in between keeps naming the hand at the mouth, so nothing moves it early.
      for (const step of steps.filter(item => item.at >= covered && item.at <= handLeaves)) expect(covering(step)).toBe(true);
    }
  });
});

describe('desk figure heart for our own repository', () => {
  it('always plays the first time this browser shows the figure for it, and remembers that', () => {
    const store = memoryStore();
    expect(greetAtOpening(store, () => .99)).toBe(true);
    expect(store.values.get(HEART_SEEN_KEY)).toBe('1');
  });

  it('plays about one opening in three after that', () => {
    const store = memoryStore({ [HEART_SEEN_KEY]: '1' });
    expect(greetAtOpening(store, () => .2)).toBe(true);
    expect(greetAtOpening(store, () => .4)).toBe(false);
    const random = seeded(6);
    let plays = 0;
    for (let i = 0; i < 3000; i++) if (greetAtOpening(store, random)) plays++;
    expect(plays / 3000).toBeCloseTo(1 / 3, 1);
  });

  it('still decides when storage cannot be used', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(greetAtOpening(broken, () => .1)).toBe(true);
    expect(greetAtOpening(broken, () => .9)).toBe(false);
    expect(greetAtOpening(null, () => .9)).toBe(false);
  });

  it('counts only openings: shown for our project, or an analysis starting for it', () => {
    const own = (pose: 'rest' | 'waiting' | 'puzzled') => ({ pose, own: true });
    // Appearing for our project (mounted, or the project switched to it).
    expect(isOpening(null, own('rest'))).toBe(true);
    expect(isOpening(null, own('waiting'))).toBe(true);
    expect(isOpening({ pose: 'rest', own: false }, own('rest'))).toBe(true);
    // An analysis starts for it.
    expect(isOpening(own('rest'), own('waiting'))).toBe(true);
    expect(isOpening(own('puzzled'), own('waiting'))).toBe(true);
    // Not openings: the same state again (a re-render), the analysis ending or failing, another project.
    expect(isOpening(own('rest'), own('rest'))).toBe(false);
    expect(isOpening(own('waiting'), own('waiting'))).toBe(false);
    expect(isOpening(own('waiting'), own('rest'))).toBe(false);
    expect(isOpening(own('waiting'), own('puzzled'))).toBe(false);
    expect(isOpening(null, own('puzzled'))).toBe(false);
    expect(isOpening(null, { pose: 'rest', own: false })).toBe(false);
    expect(isOpening(own('rest'), { pose: 'waiting', own: false })).toBe(false);
  });
});

describe('desk figure seasonal actions and the cup', () => {
  const seasons = ['spring', 'summer', 'autumn', 'winter'] as const;
  const picks = (state: 'rest' | 'waiting', season: typeof seasons[number] | undefined, options: { pulled?: boolean } = {}) => {
    const random = seeded(11), counts = new Map<IdleAction, number>();
    let last: IdleAction | null = null;
    for (let i = 0; i < 6000; i++) {
      last = nextIdle(state, { night: false, season, pulled: options.pulled, last, random }).id;
      counts.set(last, (counts.get(last) ?? 0) + 1);
    }
    return (id: IdleAction) => (counts.get(id) ?? 0) / 6000;
  };

  it('sips in every season and warms the hands only in winter; there is no fanning any more', () => {
    for (const state of ['rest', 'waiting'] as const) {
      for (const season of seasons) {
        const share = picks(state, season);
        expect(share('drink')).toBeGreaterThan(0);
        expect(share('rub-hands') > 0).toBe(season === 'winter');
      }
      expect(picks(state, undefined)('rub-hands')).toBe(0);
      expect(IDLE_ACTIONS[state].map(action => action.id)).not.toContain('fan');
    }
  });

  it('at rest about one action in six is a sip and in winter one in ten warming the hands; rarely while waiting', () => {
    expect(picks('rest', 'spring')('drink')).toBeCloseTo(1 / 6, 1);
    expect(picks('rest', 'winter')('rub-hands')).toBeCloseTo(.1, 1);
    const waiting = picks('waiting', 'winter');
    expect(waiting('drink')).toBeLessThan(.1);
    expect(waiting('rub-hands')).toBeLessThan(.06);
  });

  it('leaves the cup on the desk while the chair is pulled in', () => {
    expect(picks('rest', 'winter', { pulled: true })('drink')).toBe(0);
    const random = seeded(12);
    for (let i = 0; i < 500; i++) expect(nextIdle('rest', { night: false, season: 'winter', pulled: true, last: 'rub-hands', random }).id).not.toBe('drink');
  });

  it('sometimes follows warming the hands with a sip of the hot tea', () => {
    const random = seeded(13);
    let sips = 0;
    for (let i = 0; i < 4000; i++) if (nextIdle('rest', { night: false, season: 'winter', last: 'rub-hands', random }).id === 'drink') sips++;
    expect(sips / 4000).toBeGreaterThan(.2);
    expect(sips / 4000).toBeLessThan(.4);
    expect(FOLLOW_UPS.rest['rub-hands']).toEqual([['drink', .2]]);
    expect(FOLLOW_UPS.waiting['rub-hands']).toEqual([['drink', .2]]);
  });

  it('gives the new actions real durations', () => {
    const random = seeded(14);
    const range = (id: IdleAction, state: 'rest' | 'waiting', drink?: 'iced' | 'tea' | 'hot') => {
      const all = Array.from({ length: 200 }, () => idleDuration(id, state, random, drink));
      return [Math.min(...all), Math.max(...all)];
    };
    const within = ([low, high]: number[], min: number, max: number) => { expect(low).toBeGreaterThanOrEqual(min); expect(high).toBeLessThanOrEqual(max); };
    for (const drink of ['iced', 'tea', 'hot'] as const) within(range('drink', 'rest', drink), 4500, 7500);
    within(range('drink', 'waiting', 'hot'), 5000, 8000);      // from behind the head and back there
    within(range('rub-hands', 'rest'), 4000, 11_000);          // once or twice rubbed and blown into
  });
});

describe('desk figure: the hand stays until the body has recovered, and leaves last', () => {
  const neutralHead = (head?: { y: number; sy: number; r: number; x: number }) => !head || (head.y === 0 && head.sy === 1 && head.r === 0 && head.x === 0);
  const neutralBody = (body?: { y: number; sy: number }) => !body || (body.y === 0 && body.sy === 1);

  it('drinking: the cup goes back on the desk in the pose it was taken in, with body and head already back', () => {
    for (const state of ['rest', 'waiting'] as const) {
      for (const drink of ['iced', 'tea', 'hot'] as const) {
        const steps = idleSteps('drink', state, seeded(15), drink);
        expect(steps.cup.map(([, held]) => held)).toEqual([true, false]);
        const [[take], [give]] = steps.cup;
        const at = (moment: number) => steps.find(step => Math.abs(step.at - moment) < 1e-9)!;
        // Taken and set down in the same gripping pose, the cup upright there.
        for (const part of ['upper-r', 'fore-r', 'cup'] as const) expect(at(give).parts[part]?.r).toBeCloseTo(at(take).parts[part]!.r, 6);
        expect(at(take).parts['upper-r']!.r + at(take).parts['fore-r']!.r + at(take).parts.cup!.r).toBeCloseTo(0, 6);
        // The hand is in front only while it holds the cup.
        expect(steps.fronts).toEqual([{ side: 'r', on: take, off: give }]);
        // Every step names the drinking arm, the cup, the other arm, the body and the head.
        for (const step of steps) for (const part of ['upper-r', 'fore-r', 'cup', 'upper-l', 'fore-l', 'stretch-body', 'head'] as const) expect(step.parts[part]).toBeDefined();
        // The body sits up and the head moves while the cup is up, and both are back when it is set down…
        expect(steps.some(step => step.at > take && step.at < give && !neutralBody(step.parts['stretch-body']))).toBe(true);
        expect(steps.some(step => step.at > take && step.at < give && !neutralHead(step.parts.head))).toBe(true);
        expect(neutralBody(at(give).parts['stretch-body']) && neutralHead(at(give).parts.head)).toBe(true);
        // …and after that only the hand moves, back where it came from.
        for (const step of steps.filter(item => item.at >= give)) expect(neutralBody(step.parts['stretch-body']) && neutralHead(step.parts.head)).toBe(true);
        expect(steps.calm).toBe(state === 'waiting');
      }
    }
  });

  it('warming the hands: the shoulders let go while the hands are still at the mouth, then the hands go', () => {
    for (const state of ['rest', 'waiting'] as const) {
      const steps = idleSteps('rub-hands', state, seeded(17));
      for (const step of steps) for (const part of ['upper-l', 'fore-l', 'upper-r', 'fore-r'] as const) expect(step.parts[part]).toBeDefined();
      const hunched = steps.map((step, i) => [step, i] as const).filter(([step]) => (step.parts['stretch-body']?.sy ?? 1) > 1);
      expect(hunched.length).toBeGreaterThan(5);
      const relax = steps.findIndex((step, i) => i > hunched[hunched.length - 1][1] && step.parts['stretch-body'] !== undefined && neutralBody(step.parts['stretch-body']));
      expect(relax).toBeGreaterThan(0);
      // The hands stay cupped at the mouth from the last blow until the shoulders are down.
      const blow = steps[relax - 1];
      for (const part of ['upper-l', 'fore-l', 'upper-r', 'fore-r'] as const) expect(steps[relax].parts[part]!.r).toBe(blow.parts[part]!.r);
      expect(steps[relax].parts.head!.y).toBe(0);
      for (const step of steps.slice(relax)) expect(neutralBody(step.parts['stretch-body'])).toBe(true);
      // One or two puffs, each leaving after the hands reach the mouth and fading before the move ends.
      expect(steps.puffs.length).toBeGreaterThanOrEqual(1);
      expect(steps.puffs.length).toBeLessThanOrEqual(2);
      for (const puff of steps.puffs) expect(puff + 1200 / steps.ms).toBeLessThanOrEqual(1);
      // Both hands are drawn in front of the face for the whole visit.
      expect(steps.fronts.map(front => front.side).sort()).toEqual(['l', 'r']);
    }
  });
});

describe('desk figure: an arm stays on its own side and hidden by the lid where it turns over', () => {
  // The drawing (FieldIllustration.tsx): shoulders and elbows as drawn, the lid's top edge and sides, a mitten's
  // reach with its line.
  const SHOULDER = { l: [97, 72], r: [129, 72] } as const, ELBOW = { l: [70, 42], r: [156, 42] } as const;
  const elbowAt = (which: 'l' | 'r', upper: number, short = 1): [number, number] => {
    const [sx, sy] = SHOULDER[which], [ex, ey] = ELBOW[which], a = upper * Math.PI / 180;
    return [sx + short * ((ex - sx) * Math.cos(a) - (ey - sy) * Math.sin(a)), sy + short * ((ex - sx) * Math.sin(a) + (ey - sy) * Math.cos(a))];
  };
  const LID_TOP = 79.5, HAND = 8.6;
  const lidRight = (y: number) => y < 81 ? 171 : 171 - (y - 81) * 5 / 39, lidLeft = (y: number) => y < 98 ? 69 + (y - 79) * 2 / 19 : 71 + (y - 98) * 3 / 21;
  const behindLid = ([x, y]: [number, number]) => y - HAND >= LID_TOP && x - HAND >= lidLeft(y) && x + HAND <= lidRight(y);
  /** The arm along a stretch of steps: each step moves the joints it names together, in a straight line (upper, fore
   * and how short the upper arm is drawn). */
  const armPath = (poses: Array<[number, number, number]>) => poses.slice(1).flatMap((to, i) => Array.from({ length: 20 }, (_, k) => {
    const from = poses[i], t = (k + 1) / 20;
    return from.map((value, j) => value + (to[j] - value) * t) as [number, number, number];
  }));
  const handPath = (which: 'l' | 'r', poses: Array<[number, number, number]>) => armPath(poses).map(([upper, fore, short]) => handAt(which, upper, fore, short));
  const arm = (step: { parts: Record<string, { r: number; s: number } | undefined> }, which: 'l' | 'r'): [number, number, number] =>
    [step.parts[`upper-${which}`]!.r, step.parts[`fore-${which}`]!.r, step.parts[`upper-${which}`]!.s];

  it('sipping at rest: the forearm turns over unseen behind the lid, the hand comes out past its right side and back the same way', () => {
    for (const drink of ['iced', 'tea', 'hot'] as const) {
      const steps = idleSteps('drink', 'rest', seeded(21), drink), last = steps.length - 1;
      const [[take], [give]] = steps.cup;
      // Left out from the keyboard until the hand is low behind the lid, and again from there back to the keyboard.
      expect(steps.away).toEqual([{ side: 'r', on: 0, off: steps[0].at }, { side: 'r', on: steps[last].at, off: 1 }]);
      for (const step of [steps[0], steps[last]]) expect(behindLid(handAt('r', ...arm(step, 'r')))).toBe(true);
      // Drawn, the hand never shows above the lid while it is over it, on the way to the cup and back.
      const reach = steps.filter(step => step.at <= take + 1e-9), back = steps.filter(step => step.at >= give - 1e-9);
      for (const way of [reach, back]) {
        for (const [x, y] of handPath('r', way.map(step => arm(step, 'r')))) {
          if (x - HAND < lidRight(y)) expect(y - HAND).toBeGreaterThanOrEqual(LID_TOP);
        }
      }
    }
  });

  it('sipping: while the cup is up the hand never crosses to the other side of the chest, and the elbow stays on the cup\'s side', () => {
    for (const state of ['rest', 'waiting'] as const) {
      for (const drink of ['iced', 'tea', 'hot'] as const) {
        const steps = idleSteps('drink', state, seeded(22), drink);
        const [[take], [give]] = steps.cup;
        const up = steps.filter(step => step.at > take && step.at < give);
        for (const [x] of handPath('r', up.map(step => arm(step, 'r')))) expect(x).toBeGreaterThan(113);
        for (const [upper, , short] of armPath(up.map(step => arm(step, 'r')))) expect(elbowAt('r', upper, short)[0]).toBeGreaterThan(SHOULDER.r[0]);
        // Out to the side, except for a mug (the next test).
        if (drink === 'iced') for (const step of up) expect(elbowAt('r', step.parts['upper-r']!.r)[0]).toBeGreaterThan(SHOULDER.r[0] + 20);
      }
    }
  });

  it('a mug is drunk from with the elbow low in front of the body, behind the lid, never raised to the face, at rest or waiting', () => {
    for (const [state, drink] of [['rest', 'tea'], ['rest', 'hot'], ['waiting', 'tea'], ['waiting', 'hot']] as const) {
      for (const seed of [27, 28]) {
        const steps = idleSteps('drink', state, seeded(seed), drink);
        const [[take], [give]] = steps.cup;
        // Every step names how long the upper arm is drawn, and its forearm is scaled back by as much.
        for (const step of steps) expect(step.parts['upper-r']!.s * step.parts['fore-r']!.s).toBeCloseTo(1, 9);
        // The upper arm is shortened only while the cup is up, and is at its length again before the cup goes down.
        const short = steps.filter(step => step.parts['upper-r']!.s < 1);
        expect(short.length).toBeGreaterThan(1);
        for (const step of short) expect(step.at > take && step.at < give).toBe(true);
        // At the mouth the forearm runs from the mug down, leaning a little out, and the elbow is behind the lid.
        for (const step of short) {
          const [upper, fore, s] = arm(step, 'r'), [hx, hy] = handAt('r', upper, fore, s), [ex, ey] = elbowAt('r', upper, s);
          expect(hy).toBeLessThan(57);
          expect(ex - hx).toBeGreaterThan(0);
          expect(ex - hx).toBeLessThan((ey - hy) * .4);
          expect(behindLid([ex, ey])).toBe(true);
        }
        // On the way there and back the elbow never comes above the shoulder, and wherever the upper arm is drawn
        // shorter it is behind the lid.
        for (const [upper, , s] of armPath(steps.filter(step => step.at >= take && step.at <= give).map(step => arm(step, 'r')))) {
          expect(elbowAt('r', upper, s)[1]).toBeGreaterThan(SHOULDER.r[1]);
          if (s < .999) expect(behindLid(elbowAt('r', upper, s))).toBe(true);
        }
      }
    }
  });

  it('while the cup is held the elbow stays below the shoulder and hidden behind the lid, at rest or waiting', () => {
    // The elbow's round end with its line (5.5 + 1.65, smaller as the upper arm is drawn shorter), inside the lid's
    // outer edge (its line is 3.3 wide).
    const hidden = ([x, y]: [number, number], s: number) => {
      const r = 7.15 * s;
      return y - r >= LID_TOP - 1.65 && x - r >= lidLeft(y) - 1.65 && x + r <= lidRight(y) + 1.65;
    };
    for (const state of ['rest', 'waiting'] as const) {
      for (const drink of ['iced', 'tea', 'hot'] as const) {
        const steps = idleSteps('drink', state, seeded(29), drink);
        const [[take], [give]] = steps.cup;
        for (const [upper, , s] of armPath(steps.filter(step => step.at >= take - 1e-9 && step.at <= give + 1e-9).map(step => arm(step, 'r')))) {
          const elbow = elbowAt('r', upper, s);
          expect(elbow[1]).toBeGreaterThan(SHOULDER.r[1]);
          expect(hidden(elbow, s)).toBe(true);
        }
      }
    }
  });

  /** The arm's pose in each state's base (at the keyboard, or the hand behind the head). */
  const BASE_ARM: Record<'rest' | 'waiting', [number, number, number]> = { rest: [-120, 104, 1], waiting: [0, 0, 1] };
  /** The elbow's round end with its line (the forearm's 5 + 3.3, never scaled), inside the lid's outer edge. */
  const elbowHidden = ([x, y]: [number, number]) => y - 8.3 >= LID_TOP - 1.65 && x - 8.3 >= lidLeft(y) - 1.65 && x + 8.3 <= lidRight(y) + 1.65;
  /** The steps with the hand at the face: all of them from the keyboard for the chin; else those between the way up
   * and the way back (from behind the head: out, down beside the head, …, down beside the head, out; from the
   * keyboard low behind the lid, for the yawn also rising, and back the same way). */
  const atFace = (id: 'yawn' | 'rub-eye' | 'chin', state: 'rest' | 'waiting', steps: ReturnType<typeof idleSteps>) =>
    id === 'chin' && state === 'rest' ? [...steps] : steps.slice(state === 'waiting' || id === 'yawn' ? 2 : 1, state === 'waiting' || id === 'yawn' ? -2 : -1);
  const slantOf = ([hx, hy]: [number, number], [ex, ey]: [number, number]) => Math.atan2(hx - ex, ey - hy) * 180 / Math.PI;

  it('chin on hand: the cheek rests on the hand at the side of the jaw, the forearm leaning down and out on its own side', () => {
    for (const state of ['rest', 'waiting'] as const) {
      for (const seed of [31, 32]) {
        const steps = idleSteps('chin', state, seeded(seed)), visit = atFace('chin', state, steps);
        // From the keyboard the front copy is drawn whole: its elbow stays behind the lid all the way (below).
        if (state === 'rest') expect(steps.fronts).toEqual([{ side: 'l', on: expect.any(Number), off: expect.any(Number), whole: true }]);
        for (const step of visit) {
          const [upper, fore, s] = arm(step, 'l'), hand = handAt('l', upper, fore, s), elbow = elbowAt('l', upper, s);
          // Every step names how long the upper arm is drawn, and its forearm is scaled back by as much.
          expect(s * step.parts['fore-l']!.s).toBeCloseTo(1, 9);
          // The mitten at the left side of the jaw (the face spans 97–127, its middle at 112, the chin at 56), not
          // under the middle of the chin.
          expect(hand[0]).toBeGreaterThan(97);
          expect(hand[0]).toBeLessThan(105);
          expect(hand[1]).toBeGreaterThan(52);
          expect(hand[1]).toBeLessThan(61);
          // The forearm leans down and out from it, 25–35° from upright, on the same side, to an elbow behind the lid.
          expect(slantOf(hand, elbow)).toBeGreaterThanOrEqual(25);
          expect(slantOf(hand, elbow)).toBeLessThanOrEqual(35);
          expect(Math.max(hand[0], elbow[0]) + 5).toBeLessThan(112);
          expect(elbowHidden(elbow)).toBe(true);
        }
        // The head leans into the hand while it rests there, and is up again before the hand goes.
        for (const step of visit.slice(1, -1)) expect(step.parts.head!.r).toBeLessThan(0);
        const last = visit[visit.length - 1], before = visit[visit.length - 2];
        expect(last.parts.head!.r).toBeGreaterThan(0);
        expect(arm(last, 'l')).toEqual(arm(before, 'l'));
        expect(last.at).toBeLessThan(1);
      }
    }
  });

  it('a hand at the face is the one on its side and comes up on that side, never across the face, in both poses', () => {
    for (const id of ['yawn', 'rub-eye', 'chin'] as const) {
      for (const state of ['rest', 'waiting'] as const) {
        for (const seed of [41, 42]) {
          const steps = idleSteps(id, state, seeded(seed));
          // Only the left arm moves (the other one stays where it is: at the keyboard or behind the head).
          for (const step of steps) {
            expect(step.parts['upper-l'] && step.parts['fore-l']).toBeDefined();
            expect(step.parts['upper-r'] ?? step.parts['fore-r']).toBeUndefined();
          }
          // All the way, wherever the forearm or hand shows above the lid it is left of the face's middle (112; the
          // mitten that covers the mouth reaches it from the left).
          for (const [upper, fore, s] of armPath([BASE_ARM[state], ...steps.map(step => arm(step, 'l')), BASE_ARM[state]])) {
            const [hx, hy] = handAt('l', upper, fore, s), [ex, ey] = elbowAt('l', upper, s);
            for (let k = 0; k <= 20; k++) {
              const x = ex + (hx - ex) * k / 20, y = ey + (hy - ey) * k / 20;
              if (y < LID_TOP) expect(x).toBeLessThanOrEqual(113.5);
            }
          }
          // From the keyboard the front copy is drawn whole, and the elbow never shows. From behind the head the hand is
          // first out beside the head on its side, where its front copy switches on; the copy is drawn whole only while
          // the elbow is behind the lid (from and to the moments the hand is beside the jaw).
          const [front] = steps.fronts;
          expect(steps.fronts).toHaveLength(1);
          if (state === 'rest') {
            expect(front.whole).toBe(true);
            for (const [upper, , s] of armPath([BASE_ARM.rest, ...steps.map(step => arm(step, 'l')), BASE_ARM.rest])) expect(elbowHidden(elbowAt('l', upper, s))).toBe(true);
          } else {
            const out = steps.find(step => Math.abs(step.at - front.on) < 1e-9)!;
            expect(handAt('l', ...arm(out, 'l'))[0] + HAND).toBeLessThan(97);
            const whole = front.whole as { on: number; off: number };
            expect(whole.on).toBeGreaterThan(front.on);
            expect(whole.off).toBeLessThan(front.off);
            const inside = steps.filter(step => step.at >= whole.on - 1e-9 && step.at <= whole.off + 1e-9);
            expect(inside[0].at).toBeCloseTo(whole.on, 9);
            expect(inside[inside.length - 1].at).toBeCloseTo(whole.off, 9);
            for (const [upper, , s] of armPath(inside.map(step => arm(step, 'l')))) expect(elbowHidden(elbowAt('l', upper, s))).toBe(true);
          }
          // At the face (rubbing in small circles about the eye) the forearm comes up from an elbow low on its own side,
          // behind the lid.
          for (const step of atFace(id, state, steps)) {
            const [upper, fore, s] = arm(step, 'l'), hand = handAt('l', upper, fore, s), elbow = elbowAt('l', upper, s);
            if (id !== 'chin') expect(Math.hypot(hand[0] - (id === 'yawn' ? MOUTH : EYE)[0], hand[1] - (id === 'yawn' ? MOUTH : EYE)[1])).toBeLessThan(4);
            expect(hand[0]).toBeLessThanOrEqual(112);
            expect(slantOf(hand, elbow)).toBeGreaterThan(10);
            expect(elbowHidden(elbow)).toBe(true);
          }
        }
      }
    }
  });

  it('warming the hands while waiting: the front copies switch at once, out beside the head and clear of it', () => {
    const steps = idleSteps('rub-hands', 'waiting', seeded(26));
    for (const front of steps.fronts) expect(front.ramp).toBeUndefined();
    const out = steps.find(step => Math.abs(step.at - steps.fronts[0].on) < 1e-9)!;
    const [x, y] = handAt('l', ...arm(out, 'l'));
    expect(x + HAND).toBeLessThan(97);
    expect(y + HAND).toBeLessThan(60);
    expect(steps.fronts.every(front => front.off === steps.fronts[0].off)).toBe(true);
  });
});
