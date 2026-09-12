import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSmoothChatScroll } from './useSmoothChatScroll';

afterEach(() => vi.unstubAllGlobals());

it.each(['wheel', 'touch', 'keyboard', 'scrollbar'])('lets %s scrolling interrupt the follower until returning to the bottom', (input) => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  function Chat({ text, count = 1, project = 'one' }: { text?: string; count?: number; project?: string }) {
    const ref = useSmoothChatScroll(project, count, text);
    return <div ref={ref}>{text}</div>;
  }
  const view = render(<Chat text="a" />);
  const viewport = view.container.firstElementChild as HTMLElement;
  let height = 1000;
  Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } });
  const step = (time: number) => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
  });
  step(16);
  if (input === 'wheel') fireEvent.wheel(viewport, { deltaY: -10 });
  if (input === 'touch') {
    fireEvent.touchStart(viewport, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(viewport, { touches: [{ clientY: 115 }] });
  }
  if (input === 'keyboard') fireEvent.keyDown(viewport, { key: 'PageUp' });
  viewport.scrollTop -= 10;
  // Even if the scroll event is delayed, the next animation must not overwrite the drag.
  step(32);
  fireEvent.scroll(viewport);
  const readingTop = viewport.scrollTop;
  height = 1400;
  view.rerender(<Chat text="more output" />);
  step(48);
  view.rerender(<Chat count={2} />); // Answer completed, streaming content removed.
  step(64);
  expect(viewport.scrollTop).toBe(readingTop);
  expect(frames.size).toBe(0);
  viewport.scrollTop = 1000;
  fireEvent.scroll(viewport);
  height = 1600;
  view.rerender(<Chat text="next output" count={2} />);
  step(80);
  expect(viewport.scrollTop).toBeGreaterThan(1000);
  // Completion must not make a still-running animation impossible to interrupt.
  view.rerender(<Chat count={3} />);
  fireEvent.wheel(viewport, { deltaY: -40 });
  viewport.scrollTop -= 40;
  fireEvent.scroll(viewport);
  const completedTop = viewport.scrollTop;
  step(96);
  expect(viewport.scrollTop).toBe(completedTop);
  expect(frames.size).toBe(0);
  view.rerender(<Chat project="two" />);
  step(112);
  expect(viewport.scrollTop).toBeGreaterThan(completedTop);
  view.unmount();
  expect(frames.size).toBe(0);
});

it('keeps a single smooth animation following new chunks without jumping backward', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  function Chat({ text }: { text: string }) {
    const ref = useSmoothChatScroll('project', 1, text);
    return <div ref={ref}>{text}</div>;
  }
  const view = render(<Chat text="a" />);
  const viewport = view.container.firstElementChild as HTMLElement;
  let height = 1000;
  Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } });
  const step = (time: number) => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
  });
  step(16);
  expect(viewport.scrollTop).toBeGreaterThan(0);
  expect(viewport.scrollTop).toBeLessThan(600);
  const before = viewport.scrollTop;
  height = 1300;
  view.rerender(<Chat text="abc" />);
  view.rerender(<Chat text="abcdef" />);
  expect(frames.size).toBe(1);
  for (let time = 32; time < 1200; time += 16) step(time);
  expect(viewport.scrollTop).toBeGreaterThan(before);
  expect(viewport.scrollTop).toBe(900);
  expect(frames.size).toBe(0);
  height = 1400;
  view.rerender(<Chat text="next chunk" />);
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
});

it('respects reduced motion by following without animation', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  function Chat({ text }: { text: string }) {
    const ref = useSmoothChatScroll('project', 1, text);
    return <div ref={ref}>{text}</div>;
  }
  const view = render(<Chat text="a" />);
  const viewport = view.container.firstElementChild as HTMLElement;
  Object.defineProperties(viewport, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } });
  view.rerender(<Chat text="ab" />);
  expect(viewport.scrollTop).toBe(800);
});
