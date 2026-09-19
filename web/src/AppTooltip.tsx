import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Hint = { anchor: HTMLElement; text: string };

/** One top-layer hint for the whole app, including controls inside modal dialogs. */
export function AppTooltip() {
  const id = useId();
  const tip = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<Hint | null>(null);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let anchor: HTMLElement | null = null;
    let keyboardFocus = !window.matchMedia('(pointer: coarse)').matches;
    const clearTimer = () => { clearTimeout(pending); pending = undefined; };
    const hide = () => { clearTimer(); anchor = null; setHint(null); };
    const show = (event: Event) => {
      if (event.type === 'pointerover' && (event as PointerEvent).pointerType === 'touch') return;
      if (event.type === 'focusin' && !keyboardFocus) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip], [title]') : null;
      const text = target?.dataset.tooltip || target?.getAttribute('title');
      if (!target || !text || target === anchor) return;
      clearTimer(); anchor = target;
      const open = () => { if (target.isConnected) setHint({ anchor: target, text }); };
      if (event.type === 'focusin') open();
      else pending = setTimeout(open, 180);
    };
    const leave = (event: Event) => {
      if (!(event.target instanceof Node) || (!anchor?.contains(event.target) && !tip.current?.contains(event.target))) return;
      const next = (event as FocusEvent).relatedTarget;
      if (next instanceof Node && (anchor?.contains(next) || tip.current?.contains(next))) return;
      clearTimer();
      pending = setTimeout(hide, 100);
    };
    const scroll = (event: Event) => { if (!tip.current?.contains(event.target as Node)) hide(); };
    const key = (event: KeyboardEvent) => { keyboardFocus = true; if (event.key === 'Escape') hide(); };
    const pointer = () => { keyboardFocus = false; hide(); };
    document.addEventListener('pointerover', show, true);
    document.addEventListener('focusin', show, true);
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('focusout', leave, true);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('click', hide, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      clearTimer();
      document.removeEventListener('pointerover', show, true);
      document.removeEventListener('focusin', show, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('focusout', leave, true);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!hint || !el) return;
    const { anchor } = hint;
    const title = anchor.getAttribute('title');
    const describedBy = anchor.getAttribute('aria-describedby');
    anchor.removeAttribute('title');
    anchor.setAttribute('aria-describedby', [describedBy, id].filter(Boolean).join(' '));
    el.style.visibility = 'hidden';
    el.showPopover?.();
    const place = () => {
      if (!anchor.isConnected) { setHint(null); return; }
      const rect = anchor.getBoundingClientRect(), box = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 10, top = (viewport?.offsetTop ?? 0) + 10;
      const right = left + (viewport?.width ?? window.innerWidth) - 20;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 20;
      const below = rect.top - box.height - 9 < top;
      const beside = anchor.dataset.tooltipPlacement === 'right';
      const x = beside ? rect.right + 6 : rect.left + (rect.width - box.width) / 2;
      const y = beside ? rect.top + (rect.height - box.height) / 2 : below ? rect.bottom + 9 : rect.top - box.height - 9;
      el.style.left = `${Math.max(left, Math.min(right - box.width, x))}px`;
      el.style.top = `${Math.max(top, Math.min(bottom - box.height, y))}px`;
      el.style.visibility = 'visible';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el); observer.observe(anchor);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      if (title !== null) anchor.setAttribute('title', title);
      if (describedBy === null) anchor.removeAttribute('aria-describedby');
      else anchor.setAttribute('aria-describedby', describedBy);
    };
  }, [hint, id]);

  return hint && createPortal(<div ref={tip} id={id} role="tooltip" popover="manual"
    className="app-tooltip" data-reading={hint.anchor.dataset.tooltipReading === 'true' || Boolean(hint.anchor.closest('.repository-workspace, .source-dialog'))}>
    {hint.text}
  </div>, hint.anchor.closest('dialog[open]') ?? document.body);
}
