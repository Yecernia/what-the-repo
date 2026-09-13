import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js/lib/common';

const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', css: 'css', html: 'xml', py: 'python', sh: 'bash', sql: 'sql', go: 'go', rs: 'rust' };
const highlight = (source: string, language: string) => hljs.highlight(source, {
  language: hljs.getLanguage(language) ? language : 'plaintext', ignoreIllegals: true,
}).value;

export function AdminCode({ source, language = 'json' }: { source: string; language?: string }) {
  const html = useMemo(() => highlight(source, language), [source, language]);
  return <pre className="admin-code"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

export function diffLines(source: string) {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0, language = 'plaintext';
  return source.replace(/\r\n/g, '\n').split('\n').map(line => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      return { kind: 'hunk', content: line, old: '', next: '', sign: '', language };
    }
    if (oldRemaining === 0 && newRemaining === 0) {
      if (/^(---|\+\+\+) /.test(line) && !line.includes('/dev/null')) {
        const path = line.slice(4).split('\t')[0];
        language = languages[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'plaintext';
      }
      return { kind: 'meta', content: line, old: '', next: '', sign: '', language };
    }
    const sign = line[0];
    if (!['+', '-', ' '].includes(sign)) return { kind: 'meta', content: line, old: '', next: '', sign: '', language };
    const old = sign !== '+' ? String(oldLine++) : '';
    const next = sign !== '-' ? String(newLine++) : '';
    if (sign !== '+') oldRemaining--;
    if (sign !== '-') newRemaining--;
    return { kind: sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context', content: line.slice(1), old, next, sign, language };
  });
}

function DiffDialog({ source, title, close }: { source: string; title: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const lines = useMemo(() => diffLines(source), [source]);
  useEffect(() => {
    const element = ref.current!;
    const previousOverflow = document.body.style.overflow;
    if (!element.open) element.showModal();
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  return createPortal(<dialog ref={ref} className="admin-code-dialog" aria-labelledby={id}
    onCancel={close} onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="admin-diff-shell">
      <header><div><h2 id={id}>{title}</h2><span className="admin-diff-added-count">+{lines.filter(l => l.kind === 'added').length} 新增</span>{' · '}
        <span className="admin-diff-removed-count">−{lines.filter(l => l.kind === 'removed').length} 删除</span></div>
        <button autoFocus onClick={close} aria-label="关闭修改差异">关闭</button></header>
      <div className="admin-diff-scroll" tabIndex={0} aria-label="Git diff 修改前后差异">
        {source ? <div className="admin-diff-code admin-code">{lines.map((line, index) =>
          <div key={index} className={'admin-diff-line admin-diff-' + line.kind}>
            <span className="admin-diff-number" aria-label={line.old ? '原行号 ' + line.old : undefined}>{line.old}</span>
            <span className="admin-diff-number" aria-label={line.next ? '新行号 ' + line.next : undefined}>{line.next}</span>
            <span className="admin-diff-sign">{line.sign}</span>
            <code dangerouslySetInnerHTML={{ __html: highlight(line.content || ' ', line.language) }} />
          </div>)}</div> : <p>此候选没有保存修改差异。</p>}
      </div>
    </div>
  </dialog>, document.body);
}

export function AdminDiffButton({ source, title }: { source: string; title: string }) {
  const [open, setOpen] = useState(false);
  return <><button className="admin-diff-trigger" onClick={() => setOpen(true)}>查看修改差异</button>
    {open && <DiffDialog source={source} title={title} close={() => setOpen(false)} />}</>;
}
