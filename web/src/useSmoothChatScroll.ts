import { useCallback, useLayoutEffect, useRef } from 'react';

/** One smooth follower; scrolling up hands control back until the reader returns to the bottom. */
export function useSmoothChatScroll(conversationId: string | null, messageCount: number, content?: string) {
  const controller = useRef<{ start: () => void; reset: () => void; dispose: () => void } | null>(null);
  const previousConversation = useRef(conversationId);
  const viewport = useCallback((element: HTMLDivElement | null) => {
    controller.current?.dispose();
    controller.current = null;
    if (!element) return;
    let animation: number | null = null;
    let previousTime: number | null = null;
    let following = true;
    let lastTop = element.scrollTop;
    let touchY: number | undefined;
    const stop = () => {
      following = false;
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
      previousTime = null;
    };
    const writeTop = (top: number) => {
      element.scrollTop = top;
      // Remember the browser's actual (possibly rounded/clamped) position.
      lastTop = element.scrollTop;
    };
    const follow = (time: number) => {
      animation = null;
      if (!following || !element.isConnected) return;
      // A scrollbar drag can precede delivery of its scroll event.
      if (element.scrollTop < lastTop - .5) { stop(); return; }
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = target - element.scrollTop;
      const elapsed = previousTime === null ? 16 : Math.min(64, time - previousTime);
      previousTime = time;
      if (Math.abs(distance) <= 1) { writeTop(target); return; }
      writeTop(element.scrollTop + distance * (1 - Math.exp(-elapsed / 65)));
      animation = requestAnimationFrame(follow);
    };
    const start = () => {
      if (!following || animation !== null) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        writeTop(Math.max(0, element.scrollHeight - element.clientHeight));
        return;
      }
      previousTime = null;
      animation = requestAnimationFrame(follow);
    };
    const onScroll = () => {
      const top = element.scrollTop;
      if (top < lastTop - .5) stop();
      else if (top > lastTop && element.scrollHeight - element.clientHeight - top <= 2) {
        following = true;
        start();
      }
      lastTop = top;
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) stop(); };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined && nextY > touchY) stop();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) stop();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    controller.current = {
      start,
      reset: () => { stop(); following = true; lastTop = element.scrollTop; },
      dispose: () => {
        stop();
        element.removeEventListener('scroll', onScroll);
        element.removeEventListener('wheel', onWheel);
        element.removeEventListener('touchstart', onTouchStart);
        element.removeEventListener('touchmove', onTouchMove);
        element.removeEventListener('keydown', onKeyDown);
      },
    };
    start();
  }, []);

  useLayoutEffect(() => {
    if (previousConversation.current !== conversationId) {
      controller.current?.reset();
      previousConversation.current = conversationId;
    }
    controller.current?.start();
  }, [conversationId, messageCount, content]);

  return viewport;
}
