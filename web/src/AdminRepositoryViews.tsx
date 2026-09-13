import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { adminRequest, type AdminRow } from './admin-api';

export function AdminModal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const old = document.body.style.overflow;
    if (!ref.current?.open) ref.current?.showModal();
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = old; };
  }, []);
  return createPortal(<dialog ref={ref} className="admin-code-dialog admin-repository-dialog" aria-label={title}
    onCancel={close} onClose={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="admin-diff-shell"><header><h2>{title}</h2><button onClick={close} autoFocus>关闭</button></header>
      <div className="admin-modal-content">{children}</div></div>
  </dialog>, document.body);
}

export function UserIdentity({ row }: { row: AdminRow }) {
  const github = String(row.owner_id).startsWith('github:');
  const login = typeof row.login === 'string' ? row.login : '';
  const display = typeof row.display_name === 'string' ? row.display_name : '';
  return <div className="admin-user-identity">
    <span className="admin-identity-name">{row.online === true && <span className="admin-status-dot is-active" title="近 90 秒在线" aria-label="在线" />}
      {github && login ? <a href={'https://github.com/' + encodeURIComponent(login)} target="_blank" rel="noreferrer">{login}</a>
        : <span>{github ? display || 'GitHub 用户（名称未记录）' : '访客'}</span>}</span>
    {github && display && display !== login && <small>{display}</small>}
    <small>{String(row.owner_id ?? '身份未记录')}</small>
  </div>;
}

export function Pagination({ value, onChange, label }: { value: AdminRow; onChange: (page: number) => void; label: string }) {
  const current = Number(value.page ?? 1), pages = Number(value.pages ?? 1);
  return <nav className="admin-pagination" aria-label={label + '分页'}>
    <span>共 {Number(value.total ?? 0)} 个 · 每页 {Number(value.pageSize ?? 25)} 个 · 第 {current} / {pages} 页</span>
    <div><button disabled={current <= 1} onClick={() => onChange(1)}>首页</button>
      <button disabled={current <= 1} onClick={() => onChange(current - 1)}>上一页</button>
      <button disabled={current >= pages} onClick={() => onChange(current + 1)}>下一页</button>
      <button disabled={current >= pages} onClick={() => onChange(pages)}>末页</button>
      <form className="admin-page-jump" onSubmit={e => { e.preventDefault(); const n = Number(new FormData(e.currentTarget).get('page')); if (Number.isSafeInteger(n) && n >= 1 && n <= pages) onChange(n); }}>
        <span>跳至</span><input key={current} name="page" type="number" min={1} max={pages} step={1} required defaultValue={current} aria-label={label + '跳转页码'} /><span>页</span><button>跳转</button>
      </form></div>
  </nav>;
}

export function RepositoryName({ row }: { row: AdminRow }) {
  const name = String(row.repository_identity ?? '历史未分类');
  const valid = /^[\w.-]+\/[\w.-]+$/.test(name);
  return <div className="admin-repository-name"><strong>{name}</strong>{valid &&
    <a href={'https://github.com/' + name} target="_blank" rel="noreferrer">github.com/{name}</a>}</div>;
}

export function RepositoryUsers({ row, kind }: { row: AdminRow; kind: 'analysis' | 'storage' }) {
  const users = Array.isArray(row.users) ? row.users as AdminRow[] : [];
  const total = Number(row.user_count ?? users.length);
  const [open, setOpen] = useState(false), [all, setAll] = useState<AdminRow[] | null>(null), [error, setError] = useState('');
  const repository = String(row.repository_identity);
  useEffect(() => {
    if (!open) return;
    let current = true; setAll(null); setError('');
    const query = new URLSearchParams({ repository, kind, batch: String(row.batch_id ?? '') });
    adminRequest('/repositories/users?' + query).then(result => { if (current) setAll(result.users as AdminRow[]); })
      .catch(e => { if (current) setError((e as Error).message); });
    return () => { current = false; };
  }, [open, repository, kind, row.batch_id]);
  return <div className="admin-repository-users">{users.slice(0, 2).map(user => <UserIdentity key={String(user.owner_id)} row={user} />)}
    {!total && <span className="admin-muted">{row.participants_known === false ? '历史参与者未记录' : '暂无使用者'}</span>}
    {total > 0 && kind === 'analysis' && row.participants_known === false && <small className="admin-muted">历史记录仅能确认发起者</small>}
    {total > 2 && <button className="admin-users-expand" onClick={() => setOpen(true)}>展开全部 {total} 位用户</button>}
    {open && <AdminModal title={repository + (kind === 'analysis' ? ' · 本次分析请求用户' : ' · 使用者')} close={() => setOpen(false)}>
      <p className="admin-muted">{kind === 'analysis' ? '只包含本次分析结束前加入的去重身份，不计后续复用者。' : '按使用该仓库分析结果的账号 / 访客身份去重。'}</p>
      {error ? <p role="alert">{error}</p> : all ? <div className="admin-all-users">{all.map(user => <UserIdentity key={String(user.owner_id)} row={user} />)}</div> : <p>正在加载全部用户…</p>}
    </AdminModal>}
  </div>;
}

export function AnalysisStatus({ row }: { row: AdminRow }) {
  const status = String(row.status ?? ''), stage = String(row.stage ?? status);
  const active = status === 'running', failed = status === 'failed' || stage === 'failed';
  const labels: Record<string,string> = { done:'已完成', succeeded:'已完成', completed:'已完成', failed:'失败', queued:'排队中', cancelled:'已取消', idle:'待开始', running:'正在分析', fetching:'拉取仓库', scanning:'扫描代码', extracting:'提取结构', clustering:'组织结构', interpreting:'分析解读' };
  return <span className="admin-analysis-status"><span className={'admin-status-dot ' + (failed ? 'is-failed' : active ? 'is-active' : status === 'queued' ? 'is-queued' : 'is-idle')} />{labels[stage] ?? stage}</span>;
}
