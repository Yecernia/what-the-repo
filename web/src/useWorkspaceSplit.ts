import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

export const INITIAL_CANVAS_SHARE = 0.6;
export const SPLIT_SNAP_DURATION_MS = 200;
/** The default detail height is the maximum. Dragging upward never snaps or waits. */
export function boundedCanvasShare(raw: number, height: number, downward = true): number {
  if (!Number.isFinite(raw) || !Number.isFinite(height) || height <= 0) return INITIAL_CANVAS_SHARE;
  const clamped = Math.max(INITIAL_CANVAS_SHARE, Math.min(1, raw));
  return downward && clamped >= splitSnapThreshold(height) ? 1 : clamped;
}
export function splitSnapThreshold(height: number): number {
  return 1 - Math.min(48, height * 0.12) / height;
}
type Drag = { pointerId: number; lastY: number; startShare: number; height: number; element: HTMLDivElement };
type Snap = { from: number; startedAt: number };

export function useWorkspaceSplit(enabled: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const value = useRef(INITIAL_CANVAS_SHARE);
  const frame = useRef<number | null>(null);
  const snap = useRef<Snap | null>(null);
  const [share, setShare] = useState(INITIAL_CANVAS_SHARE);
  const [stacked, setStacked] = useState(false);
  const [dragging, setDragging] = useState(false);
  const active = enabled && stacked;
  const stopMotion = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; snap.current = null;
  }, []);
  const tick = useCallback((now: number): void => {
    frame.current = null;
    const motion = snap.current;
    if (motion) {
      const progress = Math.min(1, Math.max(0, (now - motion.startedAt) / SPLIT_SNAP_DURATION_MS));
      value.current = progress === 1 ? 1 : motion.from + (1 - motion.from) * (1 - (1 - progress) ** 3);
      if (progress === 1) snap.current = null;
    }
    setShare(value.current);
    if (snap.current) frame.current = requestAnimationFrame(tick);
  }, []);
  const queueFrame = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [tick]);
  const settle = useCallback((next: number) => {
    stopMotion(); value.current = next; setShare(next);
  }, [stopMotion]);
  const animateClosed = useCallback((from: number) => {
    stopMotion(); value.current = from;
    if (from >= 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settle(1); return;
    }
    snap.current = { from, startedAt: performance.now() };
    queueFrame();
  }, [stopMotion, settle, queueFrame]);
  const finish = useCallback((cancel = false) => {
    const current = drag.current;
    drag.current = null;
    if (cancel) settle(current?.startShare ?? value.current);
    else if (!snap.current) settle(value.current);
    if (!current) return;
    setDragging(false);
    document.body.classList.remove('workspace-row-resizing');
    if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }, [settle]);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => setStacked(getComputedStyle(element).getPropertyValue('--workspace-stacked').trim() === '1');
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const cancel = () => finish(true);
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel); window.addEventListener('resize', cancel);
    window.addEventListener('keydown', key); document.addEventListener('visibilitychange', visibility);
    return () => {
      cancel();
      window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel);
      window.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, finish]);
  const reset = useCallback(() => { finish(); settle(INITIAL_CANVAS_SHARE); }, [finish, settle]);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || event.button !== 0 || event.isPrimary === false || drag.current) return;
    const height = bodyRef.current?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    event.preventDefault(); event.stopPropagation();
    settle(value.current);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, lastY: event.clientY, startShare: value.current, height, element: event.currentTarget };
    document.body.classList.add('workspace-row-resizing'); setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientY - current.lastY;
    if (!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault(); current.lastY = event.clientY;
    // Downward input cannot restart the automatic finish; any upward movement interrupts it.
    if (delta > 0 && (snap.current || value.current === 1)) return;
    if (snap.current) stopMotion();
    const previous = value.current;
    const raw = previous + delta / current.height;
    const next = boundedCanvasShare(raw, current.height, delta > 0);
    const threshold = splitSnapThreshold(current.height);
    if (delta > 0 && next >= threshold) {
      animateClosed(Math.max(previous, Math.min(raw, threshold)));
    } else {
      value.current = next; queueFrame();
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active || drag.current) return;
    const height = bodyRef.current?.getBoundingClientRect().height ?? 0;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key) || height <= 0) return;
    event.preventDefault();
    if (event.key === 'Home' || (event.key === 'Enter' && value.current === 1)) { reset(); return; }
    if (event.key === 'End' || event.key === 'Enter') { animateClosed(value.current); return; }
    const step = (event.shiftKey ? 0.1 : 0.025) * (event.key === 'ArrowDown' ? 1 : -1);
    const next = boundedCanvasShare(value.current + step, height, step > 0);
    if (step > 0 && next >= splitSnapThreshold(height)) animateClosed(value.current);
    else settle(next);
  };
  return {
    bodyRef, active, dragging, collapsed: active && share === 1,
    percent: Math.round((active ? share : INITIAL_CANVAS_SHARE) * 100), reset,
    style: { '--workspace-canvas-share': `${(active ? share : INITIAL_CANVAS_SHARE) * 100}%` } as CSSProperties,
    separatorProps: {
      onPointerDown: start, onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        move(event); finish();
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) finish(true); },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) finish(true); },
      onKeyDown: keyDown, onDoubleClick: reset,
    },
  };
}
