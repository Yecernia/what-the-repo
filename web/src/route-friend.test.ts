import { describe, expect, it } from 'vitest';
import { localDay, observeRoutePhases, ROUTE_FRIEND_KEY, routeFinishedToday } from './route-friend';

class MemoryStore {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const MORNING = new Date(2026, 9, 8, 9, 30);
const EVENING = new Date(2026, 9, 8, 23, 50);
const NEXT_DAY = new Date(2026, 9, 9, 0, 10);

describe('the route-finished friend', () => {
  it('takes the first sight of a project as a baseline, so an old completion brings no friend', () => {
    const store = new MemoryStore();
    expect(observeRoutePhases(store, 'o:1', [['p:1', 'completed'], ['p:2', 'explaining']], MORNING)).toBe(false);
    expect(routeFinishedToday(store, 'o:1', MORNING)).toBe(false);
    // Seen again finished, it is still no change.
    expect(observeRoutePhases(store, 'o:1', [['p:1', 'completed']], EVENING)).toBe(false);
  });

  it('brings the friend for the rest of the day a project is seen to change into completed', () => {
    const store = new MemoryStore();
    observeRoutePhases(store, 'o:1', [['p:1', 'assessing'], ['p:2', 'orienting']], MORNING);
    expect(observeRoutePhases(store, 'o:1', [['p:1', 'completed'], ['p:2', 'orienting']], MORNING)).toBe(true);
    expect(routeFinishedToday(store, 'o:1', EVENING)).toBe(true);
    expect(store.getItem(`${ROUTE_FRIEND_KEY}:o:1`)).toContain(localDay(MORNING));
  });

  it('is gone the next day, and comes back only for a new completion', () => {
    const store = new MemoryStore();
    observeRoutePhases(store, 'o:1', [['p:1', 'assessing']], MORNING);
    observeRoutePhases(store, 'o:1', [['p:1', 'completed']], MORNING);
    expect(routeFinishedToday(store, 'o:1', NEXT_DAY)).toBe(false);
    expect(observeRoutePhases(store, 'o:1', [['p:1', 'completed']], NEXT_DAY)).toBe(false);
    // A new route started and finished on that later day.
    observeRoutePhases(store, 'o:1', [['p:1', 'orienting']], NEXT_DAY);
    expect(observeRoutePhases(store, 'o:1', [['p:1', 'completed']], NEXT_DAY)).toBe(true);
  });

  it('keeps each owner apart', () => {
    const store = new MemoryStore();
    observeRoutePhases(store, 'o:1', [['p:1', 'assessing']], MORNING);
    observeRoutePhases(store, 'o:1', [['p:1', 'completed']], MORNING);
    expect(routeFinishedToday(store, 'o:2', MORNING)).toBe(false);
    // Another owner seeing the same project id for the first time only sets its baseline.
    expect(observeRoutePhases(store, 'o:2', [['p:1', 'completed']], MORNING)).toBe(false);
  });

  it('falls back to no friend when storage is missing, throws or holds rubbish', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(observeRoutePhases(broken, 'o:1', [['p:1', 'completed']], MORNING)).toBe(false);
    expect(routeFinishedToday(broken, 'o:1', MORNING)).toBe(false);
    expect(observeRoutePhases(null, 'o:1', [['p:1', 'completed']], MORNING)).toBe(false);
    expect(routeFinishedToday(null, 'o:1', MORNING)).toBe(false);
    const full = new MemoryStore();
    full.setItem = () => { throw new Error('quota'); };
    observeRoutePhases(full, 'o:1', [['p:1', 'assessing']], MORNING);
    expect(observeRoutePhases(full, 'o:1', [['p:1', 'completed']], MORNING)).toBe(false);
    const garbled = new MemoryStore();
    garbled.setItem(`${ROUTE_FRIEND_KEY}:o:1`, '{not json');
    expect(routeFinishedToday(garbled, 'o:1', MORNING)).toBe(false);
    expect(observeRoutePhases(garbled, 'o:1', [['p:1', 'completed']], MORNING)).toBe(false);
  });
});
