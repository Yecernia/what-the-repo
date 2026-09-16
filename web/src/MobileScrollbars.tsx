import { useEffect } from 'react';
import { penPath } from './pen-path';

// Keep the native scroll hosts (including textarea) so touch momentum, selection and
// chat's scroll ownership stay intact. PaperScroll already supplies its own ink rail.
const hosts = [
  'textarea', '.sidebar-body', '.chat-area', '.msg-bubble pre', '.sketch-select-menu',
  '.empty-state', '.new-project-dialog', '.settings-dialog', '.verified-model-list',
  '.provider-model-rows', '.source-code', '.auth-shell', '.workspace-details-scroll',
  '.value-point-grid', '.learning-plan', '.workspace-tabs', '.product-workspace',
].join(',');
const ns = 'http://www.w3.org/2000/svg';
const ink = penPath([[4, 1, .6], [3.4, 24, 1.15], [4.5, 51, .8], [3.7, 77, 1.1], [4, 99, .55]], 2.6);

/** iOS overlay scrollbars cannot reproduce our desktop scrollbar artwork. */
export function MobileScrollbars() {
  useEffect(() => {
    const media = window.matchMedia('(any-pointer: coarse)');
    let dispose: (() => void) | undefined;
    const activate = () => {
      dispose?.();
      dispose = undefined;
      if (!media.matches) return;
      const layers = new Map<Element, HTMLDivElement>();
      const entries = new Map<HTMLElement, SVGSVGElement[]>();
      let frame: number | null = null;
      let discover = true;
      const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
      // iOS can scroll a textarea's native editor without sending each intermediate
      // scroll event to the document. Sample only that active editor during touch/coast.
      let trackingFrame: number | null = null;
      let tracked: HTMLTextAreaElement | null = null;
      let touching = false;
      let lastMotion = 0, lastTop = 0, lastLeft = 0;
      const trackEditor = () => {
        trackingFrame = null;
        if (!tracked?.isConnected) { tracked = null; return; }
        const now = performance.now();
        if (tracked.scrollTop !== lastTop || tracked.scrollLeft !== lastLeft) {
          lastTop = tracked.scrollTop; lastLeft = tracked.scrollLeft;
          lastMotion = now;
          schedule();
        }
        if (touching || now - lastMotion < 350) trackingFrame = requestAnimationFrame(trackEditor);
        else tracked = null;
      };
      const touchStart = (event: TouchEvent) => {
        const target = event.target instanceof Element ? event.target.closest('textarea') : null;
        if (!(target instanceof HTMLTextAreaElement)) return;
        tracked = target; touching = true; lastMotion = performance.now();
        lastTop = target.scrollTop; lastLeft = target.scrollLeft;
        if (trackingFrame === null) trackingFrame = requestAnimationFrame(trackEditor);
        schedule();
      };
      const touchEnd = () => { touching = false; lastMotion = performance.now(); };
      const resize = new ResizeObserver(schedule);
      const layerFor = (element: HTMLElement) => {
        const local = element.matches('.composer-textarea, .inline-message-editor textarea');
        const parent = local ? element.parentElement! : element.closest('dialog[open], .settings-panel') ?? document.body;
        const key = local ? element : parent;
        let layer = layers.get(key);
        if (!layer) {
          layer = document.createElement('div');
          layer.className = `mobile-scroll-layer${local ? ' mobile-scroll-layer-local' : ''}`;
          layer.setAttribute('aria-hidden', 'true');
          parent.append(layer);
          layers.set(key, layer);
        }
        return layer;
      };
      const update = () => {
        frame = null;
        if (discover) {
          discover = false;
          document.querySelectorAll<HTMLElement>(hosts).forEach(element => {
            // Admin screens and their body-level dialogs use browser-native scrollbars.
            if (element.closest('.admin-console, .admin-code-dialog') || entries.has(element)) return;
            const layer = layerFor(element);
            const bars = [false, true].map(horizontal => {
              const svg = document.createElementNS(ns, 'svg');
              svg.setAttribute('viewBox', horizontal ? '0 0 100 8' : '0 0 8 100');
              svg.setAttribute('preserveAspectRatio', 'none');
              svg.dataset.axis = horizontal ? 'x' : 'y';
              const path = document.createElementNS(ns, 'path');
              path.setAttribute('d', ink);
              path.setAttribute('fill', 'currentColor');
              if (horizontal) path.setAttribute('transform', 'matrix(0 1 1 0 0 0)');
              svg.append(path); layer.append(svg);
              return svg;
            });
            entries.set(element, bars);
            element.classList.add('hand-scroll-native');
            element.addEventListener('scroll', schedule, { passive: true });
            resize.observe(element);
          });
        }
        const viewport = window.visualViewport;
        const screenLeft = viewport?.offsetLeft ?? 0, screenTop = viewport?.offsetTop ?? 0;
        const screenRight = screenLeft + (viewport?.width ?? window.innerWidth);
        const screenBottom = screenTop + (viewport?.height ?? window.innerHeight);
        for (const [element, bars] of entries) {
          if (!element.isConnected || element.closest('.admin-console, .admin-code-dialog')) {
            element.classList.remove('hand-scroll-native');
            bars.forEach(bar => bar.remove()); resize.unobserve(element); element.removeEventListener('scroll', schedule); entries.delete(element); continue;
          }
          const layer = bars[0].parentElement!;
          const local = layer.classList.contains('mobile-scroll-layer-local');
          // Keep editor chrome in the editor's coordinate system. Native keyboard
          // viewport shifts must not become a second, synthetic clipping boundary.
          if (local) Object.assign(layer.style, {
            left: `${element.offsetLeft + element.clientLeft}px`, top: `${element.offsetTop + element.clientTop}px`,
            width: `${element.clientWidth}px`, height: `${element.clientHeight}px`,
          });
          const rect = local ? { left: 0, top: 0, right: element.clientWidth, bottom: element.clientHeight } : element.getBoundingClientRect();
          let left = local ? 0 : Math.max(rect.left, screenLeft), top = local ? 0 : Math.max(rect.top, screenTop);
          let right = local ? rect.right : Math.min(rect.right, screenRight), bottom = local ? rect.bottom : Math.min(rect.bottom, screenBottom);
          if (!element.getClientRects().length || element.closest('[inert], [aria-hidden="true"]') || right <= left || bottom <= top) {
            bars.forEach(bar => { bar.style.display = 'none'; });
            continue;
          }
          // Clip indicators along with nested scroll hosts, rather than drawing over their menus.
          for (let parent = local ? null : element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) {
              const box = parent.getBoundingClientRect();
              if (style.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right); }
              if (style.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
            }
          }
          const style = getComputedStyle(element);
          const hidden = right <= left || bottom <= top;
          const origin = local ? { left: 0, top: 0 } : layer.getBoundingClientRect();
          bars.forEach((bar, axis) => {
            const horizontal = axis === 1;
            const visible = horizontal ? element.clientWidth : element.clientHeight;
            const total = horizontal ? element.scrollWidth : element.scrollHeight;
            const overflow = horizontal ? style.overflowX : style.overflowY;
            if (hidden || !/(auto|scroll)/.test(overflow) || total - visible <= 1) { bar.style.display = 'none'; return; }
            const track = Math.max(0, visible - 12);
            const size = Math.min(track, Math.max(28, track * visible / total));
            const position = Math.max(0, Math.min(1, (horizontal ? element.scrollLeft : element.scrollTop) / (total - visible)));
            const start = (horizontal ? rect.left : rect.top) + 6 + position * (track - size);
            const end = start + size;
            const clippedStart = Math.max(start, horizontal ? left : top);
            const clippedEnd = Math.min(end, horizontal ? right : bottom);
            bar.style.display = clippedEnd <= clippedStart ? 'none' : 'block';
            bar.style.color = style.getPropertyValue('--fg-muted');
            bar.style.left = `${(horizontal ? clippedStart : right - 8) - origin.left}px`;
            bar.style.top = `${(horizontal ? bottom - 8 : clippedStart) - origin.top}px`;
            bar.style.width = `${horizontal ? clippedEnd - clippedStart : 6}px`;
            bar.style.height = `${horizontal ? 6 : clippedEnd - clippedStart}px`;
          });
        }
        for (const [parent, layer] of layers) if (!parent.isConnected || !layer.childElementCount) { layer.remove(); layers.delete(parent); }
      };
      const mutations = new MutationObserver(records => {
        // Graph pan/selection changes do not change native scroll hosts.
        const relevant = records.filter(record => {
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          return !target?.closest('.mobile-scroll-layer, .react-flow__renderer');
        });
        if (!relevant.length) return;
        if (relevant.some(record => record.type === 'childList')) discover = true;
        schedule();
      });
      mutations.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'inert', 'hidden', 'open'] });
      document.addEventListener('scroll', schedule, true);
      document.addEventListener('input', schedule, true);
      document.addEventListener('touchstart', touchStart, { passive: true, capture: true });
      document.addEventListener('touchend', touchEnd, true);
      document.addEventListener('touchcancel', touchEnd, true);
      document.addEventListener('transitionend', schedule, true);
      window.addEventListener('resize', schedule);
      viewportEvents(true);
      function viewportEvents(add: boolean) {
        for (const name of ['resize', 'scroll']) {
          if (add) window.visualViewport?.addEventListener(name, schedule);
          else window.visualViewport?.removeEventListener(name, schedule);
        }
      }
      schedule();
      dispose = () => {
        mutations.disconnect(); resize.disconnect();
        document.removeEventListener('scroll', schedule, true);
        document.removeEventListener('input', schedule, true);
        document.removeEventListener('touchstart', touchStart, true);
        document.removeEventListener('touchend', touchEnd, true);
        document.removeEventListener('touchcancel', touchEnd, true);
        document.removeEventListener('transitionend', schedule, true);
        window.removeEventListener('resize', schedule); viewportEvents(false);
        if (frame !== null) cancelAnimationFrame(frame);
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
        entries.forEach((_, element) => { element.classList.remove('hand-scroll-native'); element.removeEventListener('scroll', schedule); });
        layers.forEach(layer => layer.remove());
      };
    };
    activate();
    media.addEventListener('change', activate);
    return () => { media.removeEventListener('change', activate); dispose?.(); };
  }, []);
  return null;
}
