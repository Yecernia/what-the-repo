import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FieldIllustration } from './FieldIllustration';
import { HEART_SEEN_KEY } from './field-motion';

// jsdom has no Web Animations: a stand-in whose animations finish after their duration (on fake timers), so the
// figure's controller runs its moves and the test can see which elements were animated.
const animated: Element[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  animated.length = 0;
  Element.prototype.animate = function animate(this: Element, _frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    animated.push(this);
    const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0);
    let settle = () => {};
    const finished = new Promise<void>(resolve => { settle = resolve; });
    const timer = setTimeout(() => { animation.playState = 'finished'; settle(); }, duration);
    const animation = {
      playState: 'running', finished, pause() {}, play() {},
      cancel() { clearTimeout(timer); },
    };
    return animation as unknown as Animation;
  } as typeof Element.prototype.animate;
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
