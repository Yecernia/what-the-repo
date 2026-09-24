import { memo, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphEvidence } from './types';
import { LanguageGlyph, languageFromPath } from './language-glyph';
import { t, useUiLanguage } from './ui-language';
import './workspace-evidence.css';

const ROW_HEIGHT = 54;
const OVERSCAN = 4;
const WINDOW_HEIGHT = 378;
type Props = { evidence: GraphEvidence[]; onOpenEvidence: (item: GraphEvidence) => void };

const EvidenceButton = memo(function EvidenceButton({ item, onOpenEvidence, ...props }:
  { item: GraphEvidence; onOpenEvidence: Props['onOpenEvidence'] } & React.ComponentProps<'button'>) {
  return <button {...props} type="button" className="workspace-evidence"
    aria-label={`${item.label} ${item.path}${item.start_line ? `:${item.start_line}` : ''}`}
    title={`${item.path}${item.start_line ? `:${item.start_line}` : ''}`}
    disabled={!item.path} onClick={() => onOpenEvidence(item)}>
    <LanguageGlyph language={languageFromPath(item.path || 'file')} />
    <span className="workspace-evidence-main">
      <span className="workspace-evidence-label">{item.path.split(/[\\/]/).pop() || item.label}</span>
      <code className="workspace-evidence-path">{item.path}{item.start_line ? `:${item.start_line}` : ''}</code>
    </span>
  </button>;
});

function WindowedEvidenceList({ evidence, onOpenEvidence }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(WINDOW_HEIGHT);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const pendingFocus = useRef(false);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.scrollTop = 0; setTop(0); setActive(0); setFocused(null);
    const resize = () => setHeight(root.clientHeight || WINDOW_HEIGHT);
    resize();
    const observer = new ResizeObserver(resize); observer.observe(root);
    return () => observer.disconnect();
  }, [evidence]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    ref.current?.querySelector<HTMLButtonElement>(`[data-evidence-index="${active}"]`)?.focus({ preventScroll: true });
  }, [active, top]);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(evidence.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const indexes = Array.from({ length: Math.max(0, end - first) }, (_, i) => first + i);
  // Keep the focused control mounted even when a pointer scrolls it out of view.
  if (focused !== null && focused < evidence.length && !indexes.includes(focused)) indexes.push(focused);
  indexes.sort((a, b) => a - b);
  const entry = active >= first && active < end && evidence[active]?.path
    ? active : indexes.find(index => evidence[index]?.path);
  const move = (index: number) => {
    const root = ref.current; if (!root) return;
    const start = index * ROW_HEIGHT;
    if (start < root.scrollTop) root.scrollTop = start;
    else if (start + ROW_HEIGHT > root.scrollTop + height) root.scrollTop = start + ROW_HEIGHT - height;
    pendingFocus.current = true; setTop(root.scrollTop); setActive(index); setFocused(index);
    if (active === index) {
      pendingFocus.current = false;
      root.querySelector<HTMLButtonElement>(`[data-evidence-index="${index}"]`)?.focus({ preventScroll: true });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1,
      PageDown: Math.max(1, Math.floor(height / ROW_HEIGHT)), PageUp: -Math.max(1, Math.floor(height / ROW_HEIGHT)) };
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? evidence.length - 1
      : steps[event.key] !== undefined ? active + steps[event.key]! : null;
    if (next === null) return;
    event.preventDefault();
    next = Math.max(0, Math.min(evidence.length - 1, next));
    const direction = event.key === 'Home' ? 1 : event.key === 'End' || next < active ? -1 : 1;
    while (next >= 0 && next < evidence.length && !evidence[next]?.path) next += direction;
    if (next >= 0 && next < evidence.length) move(next);
  };
  return <>
    <p id={helpId} className="workspace-evidence-help">{t('共 {0} 项；可用方向键、Home、End 浏览。', evidence.length)}</p>
    <div ref={ref} className="workspace-evidence-window" role="list" aria-label={t('相关代码')}
      aria-describedby={helpId} onKeyDown={onKeyDown} tabIndex={entry === undefined ? 0 : -1}
      onScroll={event => setTop(event.currentTarget.scrollTop)}>
      <div className="workspace-evidence-window-space" role="presentation" style={{ height: evidence.length * ROW_HEIGHT }}>
        {indexes.map(index => <div key={index} className="workspace-evidence-window-row" role="listitem"
          aria-posinset={index + 1} aria-setsize={evidence.length}
          style={{ height: ROW_HEIGHT, transform: `translateY(${index * ROW_HEIGHT}px)` }}>
          <EvidenceButton item={evidence[index]!} onOpenEvidence={onOpenEvidence} data-evidence-index={index}
            tabIndex={index === entry ? 0 : -1}
            onFocus={() => { setActive(index); setFocused(index); }}
            onBlur={() => setFocused(null)} />
        </div>)}
      </div>
    </div>
  </>;
}

export const WorkspaceEvidenceList = memo(function WorkspaceEvidenceList(props: Props) {
  useUiLanguage();
  if (!props.evidence.length) return <div className="workspace-muted">{t('暂无可打开的源码')}</div>;
  if (props.evidence.length > 80) return <WindowedEvidenceList {...props} />;
  return <div className="workspace-evidence-list">{props.evidence.map((item, index) =>
    <EvidenceButton key={`${item.stable_id}:${index}`} item={item} onOpenEvidence={props.onOpenEvidence} />,
  )}</div>;
});
