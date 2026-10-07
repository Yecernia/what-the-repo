import { describe, expect, it } from 'vitest';
import { FOLLOW_UPS, firstPause, greetAtOpening, HEART_SEEN_KEY, IDLE_ACTIONS, idleDuration, idleGap, idleSteps, isOpening, nextIdle, type IdleAction } from './field-motion';

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
    within(range('stretch', 'rest'), 4000, 6500);
    within(range('yawn', 'rest'), 3500, 5500);                 // about 3.5 s at the mouth
    within(range('rub-eye', 'rest'), 3500, 7000);              // 2–4 s of rubbing, plus the hand's way
  });
});

describe('desk figure yawn', () => {
  it('lowers the hand from the mouth only after the shoulders and head have recovered', () => {
    for (const state of ['rest', 'waiting'] as const) {
      const steps = idleSteps('yawn', state, seeded(9));
      const atMouth = steps.filter(step => step.parts['upper-l']?.r === -209.5);
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
      for (const step of steps.filter(item => item.at >= covered && item.at <= handLeaves)) expect(step.parts['upper-l']?.r).toBe(-209.5);
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
