import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CSSProperties } from 'react';
import { boundedCanvasShare, splitSnapThreshold, SPLIT_SNAP_DURATION_MS, useWorkspaceSplit } from './useWorkspaceSplit';

function Harness({ enabled = true }: { enabled?: boolean }) {
  const split = useWorkspaceSplit(enabled);
  return <div ref={split.bodyRef} style={{ ...split.style, '--workspace-stacked': '1' } as CSSProperties}>
    <div role="separator" aria-valuenow={split.percent} {...split.separatorProps} />
    <button onClick={split.reset}>reset</button><aside data-testid="details" aria-hidden={split.collapsed}>details</aside>
  </div>;
}
let now = 0, nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
/** Drive the animation clock, not wall-time sleeps or weakened instant-update assertions. */
function advance(ms = 16) {
  act(() => {
    now += ms;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(now));
  });
}
function finishAnimation() { advance(SPLIT_SNAP_DURATION_MS); }
const pointer = { pointerId: 1, isPrimary: true, button: 0 };
const down = (bar: HTMLElement, clientY = 600) => fireEvent.pointerDown(bar, { ...pointer, clientY });
const move = (bar: HTMLElement, clientY: number) => fireEvent.pointerMove(bar, { ...pointer, clientY });
const up = (bar: HTMLElement, clientY: number) => fireEvent.pointerUp(bar, { ...pointer, clientY });
beforeEach(() => {
  now = 0; nextFrame = 0; frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; }
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 1000, right: 600, width: 600, height: 1000, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function separator() {
  const element = screen.getByRole('separator');
  const captured = new Set<number>();
  Object.assign(element, { setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) });
  return element;
}
const percent = (bar: HTMLElement) => Number(bar.getAttribute('aria-valuenow'));
it('clamps to the initial ratio, snaps downward only, and leaves no upward hysteresis', () => {
  expect(boundedCanvasShare(-2, 1000)).toBe(0.6);
  expect(splitSnapThreshold(1000)).toBe(0.952);
  expect(splitSnapThreshold(200)).toBe(0.88);
  expect(boundedCanvasShare(0.94, 1000)).toBe(0.94);
  expect(boundedCanvasShare(0.96, 1000, true)).toBe(1);
  expect(boundedCanvasShare(0.999, 1000, false)).toBe(0.999);
  expect(boundedCanvasShare(NaN, 1000)).toBe(0.6);
  expect(boundedCanvasShare(0.9, 0)).toBe(0.6);
});
it('coalesces a burst into one frame, flushes pointerup, and keeps the detail node', () => {
  render(<Harness />); const bar = separator(), details = screen.getByTestId('details');
  down(bar);
  for (let y = 601; y <= 720; y++) move(bar, y);
  expect(frames.size).toBe(1); expect(percent(bar)).toBe(60);
  advance(); expect(percent(bar)).toBe(72); expect(frames.size).toBe(0);
  move(bar, 740); up(bar, 750);
  expect(percent(bar)).toBe(75); expect(frames.size).toBe(0);
  expect(document.body).not.toHaveClass('workspace-row-resizing');
  fireEvent.click(screen.getByText('reset'));
  expect(percent(bar)).toBe(60); expect(screen.getByTestId('details')).toBe(details);
});
it('animates past the lower threshold to full height after release without waiting for another move', () => {
  render(<Harness />); const bar = separator(), details = screen.getByTestId('details');
  down(bar); move(bar, 940); advance(); expect(percent(bar)).toBe(94);
  move(bar, 960);
  expect(percent(bar)).toBe(94); expect(frames.size).toBe(1);
  advance(40); const first = percent(bar);
  expect(first).toBeGreaterThan(95); expect(first).toBeLessThan(100);
  expect(details).toHaveAttribute('aria-hidden', 'false');
  up(bar, 960); expect(document.body).not.toHaveClass('workspace-row-resizing');
  expect(frames.size).toBe(1); advance(60);
  expect(percent(bar)).toBeGreaterThanOrEqual(first); expect(percent(bar)).toBeLessThan(100);
  advance(100); expect(percent(bar)).toBe(100);
  expect(details).toHaveAttribute('aria-hidden', 'true'); expect(frames.size).toBe(0);
});
it('does not restart the animation on continued downward moves and reverses immediately', () => {
  render(<Harness />); const bar = separator();
  down(bar); move(bar, 960); advance(80);
  move(bar, 980); advance(120); expect(percent(bar)).toBe(100);
  // The previous pointer position, not the old snap threshold, is the return origin.
  move(bar, 970); advance(); expect(percent(bar)).toBe(99);
  up(bar, 970); expect(percent(bar)).toBe(99); expect(frames.size).toBe(0);
});
it('interrupts a running snap on any upward input without jumping to its old start', () => {
  render(<Harness />); const bar = separator();
  down(bar); move(bar, 960); advance(40); const animated = percent(bar);
  move(bar, 940); advance();
  const reversed = percent(bar); expect(reversed).toBeLessThan(animated);
  expect(reversed).toBeGreaterThan(90); expect(frames.size).toBe(0);
  advance(500); expect(percent(bar)).toBe(reversed);
  up(bar, 940);
});
it('pulls back immediately from full height and cannot enlarge details beyond the default', () => {
  render(<Harness />); const bar = separator();
  fireEvent.keyDown(bar, { key: 'End' }); finishAnimation();
  down(bar, 975); move(bar, 965); advance(); expect(percent(bar)).toBe(99);
  move(bar, 200); advance(); expect(percent(bar)).toBe(60);
  up(bar, 200); expect(percent(bar)).toBe(60);
});
it('honors reduced motion without retaining animation work', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)' } as MediaQueryList));
  render(<Harness />); const bar = separator(); down(bar); move(bar, 960);
  expect(percent(bar)).toBe(100); expect(frames.size).toBe(0); up(bar, 960);
});
it.each(['pointerCancel', 'lostPointerCapture', 'escape', 'blur', 'resize'])('cancels %s, restores the starting size, and cancels scheduled frames', reason => {
  render(<Harness />); const bar = separator(); down(bar); move(bar, 960); advance(40);
  expect(percent(bar)).toBeGreaterThan(60);
  if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
  else if (reason === 'blur') fireEvent.blur(window);
  else if (reason === 'resize') fireEvent(window, new Event('resize'));
  else if (reason === 'pointerCancel') fireEvent.pointerCancel(bar, pointer);
  else fireEvent.lostPointerCapture(bar, pointer);
  expect(percent(bar)).toBe(60); expect(frames.size).toBe(0);
  expect(document.body).not.toHaveClass('workspace-row-resizing');
  expect(bar.hasPointerCapture(1)).toBe(false);
});
it('ignores secondary buttons and foreign pointers and cleans up on unmount', () => {
  const view = render(<Harness />); const bar = separator();
  fireEvent.pointerDown(bar, { ...pointer, button: 2, clientY: 600 }); move(bar, 900);
  expect(frames.size).toBe(0); expect(percent(bar)).toBe(60);
  down(bar); fireEvent.pointerMove(bar, { ...pointer, pointerId: 2, clientY: 900 });
  fireEvent.pointerUp(bar, { ...pointer, pointerId: 2, clientY: 900 });
  expect(frames.size).toBe(0); expect(bar.hasPointerCapture(1)).toBe(true);
  move(bar, 960); view.unmount();
  expect(frames.size).toBe(0); expect(document.body).not.toHaveClass('workspace-row-resizing');
});
it('supports animated keyboard collapse and immediate keyboard restore', () => {
  render(<Harness />); const bar = separator(); fireEvent.keyDown(bar, { key: 'End' });
  expect(percent(bar)).toBe(60); finishAnimation(); expect(percent(bar)).toBe(100);
  fireEvent.keyDown(bar, { key: 'ArrowUp' }); expect(percent(bar)).toBe(98);
  fireEvent.keyDown(bar, { key: 'Home' }); expect(percent(bar)).toBe(60);
  fireEvent.keyDown(bar, { key: 'Enter' }); finishAnimation(); expect(percent(bar)).toBe(100);
  fireEvent.keyDown(bar, { key: 'Enter' }); expect(percent(bar)).toBe(60);
});
it('does not hide details on other tabs and retains the finished architecture setting on return', () => {
  const view = render(<Harness />); const bar = separator();
  fireEvent.keyDown(bar, { key: 'End' }); finishAnimation();
  view.rerender(<Harness enabled={false} />);
  expect(screen.getByTestId('details')).toHaveAttribute('aria-hidden', 'false');
  expect(frames.size).toBe(0);
  view.rerender(<Harness />); expect(percent(screen.getByRole('separator'))).toBe(100);
});
it('cancels an in-progress drag when leaving the architecture tab', () => {
  const view = render(<Harness />); const bar = separator(); down(bar); move(bar, 960); advance(40);
  view.rerender(<Harness enabled={false} />); expect(frames.size).toBe(0);
  expect(document.body).not.toHaveClass('workspace-row-resizing');
  view.rerender(<Harness />); expect(percent(screen.getByRole('separator'))).toBe(60);
});
