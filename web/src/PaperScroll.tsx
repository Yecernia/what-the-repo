import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { penPath } from './pen-path';
import { t } from './ui-language';

/** Native wheel/touch scrolling, with a draggable pen mark only when the sheet overflows. */
export function PaperScroll({ children, label = t('滚动设置') }: { children: ReactNode; label?: string }) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; scroll: number } | null>(null);
  const [metrics, setMetrics] = useState({ height: 0, total: 0, top: 0 });
  const measure = useCallback(() => {
    const el = viewport.current;
    if (el) setMetrics({ height: el.clientHeight, total: el.scrollHeight, top: el.scrollTop });
  }, []);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [measure]);
  const max = Math.max(0, metrics.total - metrics.height);
  const track = Math.max(0, metrics.height - 24);
  const thumb = Math.min(track, Math.max(38, track * metrics.height / (metrics.total || 1)));
  const travel = track - thumb;
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current && viewport.current && travel > 0) {
      viewport.current.scrollTop = drag.current.scroll + (event.clientY - drag.current.y) * max / travel;
    }
  };
  return <div className="paper-scroll">
    <div ref={viewport} id={id} className="settings-page-scroll" onScroll={measure}>
      <div ref={content} className="settings-paper-content">{children}</div>
    </div>
    {max > 1 && <div className="paper-scroll-rail" role="scrollbar" tabIndex={0}
      aria-label={label} aria-controls={id} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(metrics.top)}
      onPointerDown={event => {
        if (!viewport.current) return;
        const y = event.clientY - event.currentTarget.getBoundingClientRect().top - 12;
        const top = metrics.top / max * travel;
        if (y < top || y > top + thumb) viewport.current.scrollTop = (y - thumb / 2) * max / (travel || 1);
        drag.current = { y: event.clientY, scroll: viewport.current.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => {
        const el = viewport.current;
        if (!el) return;
        const positions: Record<string, number> = { ArrowDown: el.scrollTop + 40, ArrowUp: el.scrollTop - 40,
          PageDown: el.scrollTop + metrics.height * .85, PageUp: el.scrollTop - metrics.height * .85,
          Home: 0, End: max };
        const next = positions[event.key];
        if (next !== undefined) { event.preventDefault(); el.scrollTop = next; }
      }}>
      <svg className="paper-scroll-mark" aria-hidden="true" width="8" height={thumb}
        style={{ transform: `translateY(${12 + metrics.top / max * travel}px)` }}>
        <path d={penPath([[4,2,.6],[3.4,thumb * .24,1.15],[4.5,thumb * .51,.8],[3.7,thumb * .77,1.1],[4,thumb - 2,.55]], 2.6)} fill="currentColor" />
      </svg>
    </div>}
  </div>;
}
