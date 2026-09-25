import { memo, useEffect, useId, useState } from 'react';
import type { GraphEvidence } from './types';
import { ActivityIcon } from './ActivityIcon';
import { LanguageGlyph, languageFromPath } from './language-glyph';
import { ChevronDown, ChevronLeft, ChevronRight } from './HandIcons';
import { usePhoneDevice } from './usePhoneDevice';
import { t, useUiLanguage } from './ui-language';
import './workspace-evidence.css';

const PREVIEW_COUNT = 5;
// One page fills most of the details panel without scrolling far: a phone shows fewer rows than a desktop.
const PAGE_SIZE = { desktop: 10, phone: 6 };
type Props = { evidence: GraphEvidence[]; onOpenEvidence: (item: GraphEvidence) => void };

const EvidenceButton = memo(function EvidenceButton({ item, onOpenEvidence }:
  { item: GraphEvidence; onOpenEvidence: Props['onOpenEvidence'] }) {
  return <button type="button" className="workspace-evidence"
    aria-label={`${item.label} ${item.path}${item.start_line ? `:${item.start_line}` : ''}`}
    disabled={!item.path} onClick={() => onOpenEvidence(item)}>
    <LanguageGlyph language={languageFromPath(item.path || 'file')} />
    <span className="workspace-evidence-main">
      <span className="workspace-evidence-label">{item.path.split(/[\\/]/).pop() || item.label}</span>
      <code className="workspace-evidence-path">{item.path}{item.start_line ? `:${item.start_line}` : ''}</code>
    </span>
  </button>;
});

function EvidenceRows({ items, onOpenEvidence }: Props & { items: GraphEvidence[] }) {
  return <div className="workspace-evidence-list" role="list" aria-label={t('相关代码')}>{items.map((item, index) =>
    <div key={`${item.stable_id}:${index}`} role="listitem"><EvidenceButton item={item} onOpenEvidence={onOpenEvidence} /></div>,
  )}</div>;
}

/** The unfolded list: a file-name search and pages the learner can step through or jump to. */
function PagedEvidence({ evidence, onOpenEvidence, onFold }: Props & { onFold: () => void }) {
  const phone = usePhoneDevice();
  const pageSize = phone ? PAGE_SIZE.phone : PAGE_SIZE.desktop;
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const needle = query.trim().toLowerCase();
  const matches = needle ? evidence.filter(item => (item.path || item.label).toLowerCase().includes(needle)) : evidence;
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(page, pages);
  const [pageDraft, setPageDraft] = useState(String(current));
  useEffect(() => { setPageDraft(String(current)); }, [current]);
  const go = (next: number) => setPage(Math.max(1, Math.min(pages, next)));
  const commitDraft = () => {
    const value = Number.parseInt(pageDraft, 10);
    if (Number.isFinite(value)) go(value); else setPageDraft(String(current));
  };
  const items = matches.slice((current - 1) * pageSize, current * pageSize);
  return <div className="workspace-evidence-paged">
    <label className="workspace-evidence-search" htmlFor={searchId}>
      <ActivityIcon name="search" size={16} />
      <input id={searchId} type="search" value={query} placeholder={t('搜索文件名')} aria-label={t('搜索文件名')}
        onChange={event => { setQuery(event.target.value); setPage(1); }} />
      <span className="workspace-evidence-count" aria-live="polite">{needle
        ? t('{0} / {1} 个', matches.length, evidence.length) : t('共 {0} 个', evidence.length)}</span>
    </label>
    {items.length
      ? <EvidenceRows items={items} onOpenEvidence={onOpenEvidence} evidence={evidence} />
      : <div className="workspace-muted workspace-evidence-empty">{t('没有匹配的文件')}</div>}
    <div className="workspace-evidence-footer">
      {pages > 1 && <nav className="workspace-evidence-pager" aria-label={t('翻页')}>
        <button type="button" className="workspace-evidence-page-edge" disabled={current === 1} onClick={() => go(1)}>{t('首页')}</button>
        <button type="button" className="workspace-evidence-page-step" aria-label={t('上一页')} disabled={current === 1}
          onClick={() => go(current - 1)}><ChevronLeft size={15} /></button>
        <span className="workspace-evidence-page-number">
          <input inputMode="numeric" aria-label={t('页码')} value={pageDraft}
            style={{ width: `${Math.max(2, String(pages).length) + 1.4}ch` }}
            onChange={event => setPageDraft(event.target.value.replace(/\D/g, ''))}
            onBlur={commitDraft}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitDraft(); } }} />
          <span>/ {pages}</span>
        </span>
        <button type="button" className="workspace-evidence-page-step" aria-label={t('下一页')} disabled={current === pages}
          onClick={() => go(current + 1)}><ChevronRight size={15} /></button>
        <button type="button" className="workspace-evidence-page-edge" disabled={current === pages} onClick={() => go(pages)}>{t('末页')}</button>
      </nav>}
      <button type="button" className="workspace-evidence-more" aria-expanded="true" onClick={onFold}>
        <ChevronDown size={14} />{t('收起')}
      </button>
    </div>
  </div>;
}

/** The first few code references, with a button that unfolds the rest as searchable pages. */
export const WorkspaceEvidenceList = memo(function WorkspaceEvidenceList({ evidence, onOpenEvidence }: Props) {
  useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!evidence.length) return <div className="workspace-muted">{t('暂无可打开的源码')}</div>;
  if (evidence.length <= PREVIEW_COUNT) return <EvidenceRows items={evidence} evidence={evidence} onOpenEvidence={onOpenEvidence} />;
  if (expanded) return <PagedEvidence evidence={evidence} onOpenEvidence={onOpenEvidence} onFold={() => setExpanded(false)} />;
  return <>
    <EvidenceRows items={evidence.slice(0, PREVIEW_COUNT)} evidence={evidence} onOpenEvidence={onOpenEvidence} />
    <button type="button" className="workspace-evidence-more" aria-expanded="false" onClick={() => setExpanded(true)}>
      <ChevronDown size={14} />{t('展开全部 {0} 个', evidence.length)}
    </button>
  </>;
});
