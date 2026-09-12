import { useLayoutEffect, type RefObject } from 'react';

/** Measure off-screen: collapsing the focused input resets its scroll/caret viewport. */
export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, minimum: number, viewportRatio: number, scope?: string) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const mirror = document.createElement('textarea');
    mirror.tabIndex = -1;
    mirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirror);
    const measure = () => {
      const style = getComputedStyle(input);
      for (const property of ['box-sizing', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-transform', 'padding', 'border-width', 'border-style', 'white-space', 'overflow-wrap', 'word-break', 'tab-size']) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
      }
      Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none', width: `${input.getBoundingClientRect().width}px`, height: '0px', minHeight: '0', maxHeight: 'none', overflow: 'hidden' });
      mirror.value = value || ' ';
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const contentHeight = mirror.scrollHeight + border;
      const maximum = Math.max(minimum, Math.floor(window.innerHeight * viewportRatio));
      input.style.height = `${Math.min(maximum, Math.max(minimum, contentHeight))}px`;
      input.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
    };
    measure();
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; measure(); }
    });
    observer?.observe(input);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); mirror.remove(); };
  }, [ref, value, minimum, viewportRatio, scope]);
}
