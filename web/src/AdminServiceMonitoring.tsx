import { useState } from 'react';
import type { AdminRow } from './admin-api';
import { AdminCode } from './AdminCode';
import { AdminModal } from './AdminRepositoryViews';
import { groupServiceReports, reportAge, reportTime, reportMetrics } from './admin-monitoring';

function InstanceReports({ rows, observedAt }: { rows: AdminRow[]; observedAt: string }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / 5)), current = Math.min(page, pages);
  return <>
    <div className="admin-instance-list">{rows.slice((current - 1) * 5, current * 5).map(row =>
      <article className="admin-instance-report" key={String(row.instance_id)}>
        <div className="admin-instance-heading"><code>{String(row.instance_id ?? '实例标识未记录')}</code>
          <span>{row.fresh === true ? '近期有上报' : '未再上报 · 待核实'}</span></div>
        <p className="admin-muted">最后上报：{reportAge(row.observed_at, observedAt)} · {reportTime(row.observed_at)}</p>
        {reportMetrics(row.payload).length > 0 && <dl className="admin-instance-metrics" aria-label="这份报告中的指标">
          {reportMetrics(row.payload).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}
        </dl>}
        <details className="admin-details"><summary>查看这份报告的原始指标</summary>
          <AdminCode source={JSON.stringify(row.payload ?? {}, null, 2)} /></details>
      </article>)}</div>
    {pages > 1 && <nav className="admin-pagination" aria-label="实例报告分页">
      <span>共 {rows.length} 条 · 第 {current} / {pages} 页</span><div>
        <button disabled={current === 1} onClick={() => setPage(current - 1)}>上一页</button>
        <button disabled={current === pages} onClick={() => setPage(current + 1)}>下一页</button>
      </div></nav>}
  </>;
}

export function AdminServiceMonitoring({ observations, observedAt }: { observations: AdminRow[]; observedAt: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const groups = groupServiceReports(observations), current = groups.find(group => group.role === selected);
  const missing = groups.filter(group => !group.recent.length);
  return <section className="admin-card admin-service-monitoring" aria-labelledby="admin-services-title">
    <div className="admin-card-title"><h2 id="admin-services-title">服务上报概览</h2>
      <span className="admin-muted">已记录 {groups.length} 类服务</span></div>
    <p className="admin-muted">每 15 秒上报，45 秒内收到报告视为近期上报。以下状态截至本次刷新，不等于所有业务功能正常。</p>
    {!groups.length ? <p className="admin-empty">尚未收到服务报告，无法判断运行情况。</p> : <>
      {missing.length > 0 && <p className="admin-monitor-warning" role="status">
        {missing.map(group => group.name).join('、')}：所有已记录实例均超过 45 秒未上报，请检查进程或采集连接；不直接等于宕机。
      </p>}
      <div className="admin-service-list">{groups.map(group => <article className="admin-service-row" key={group.role}>
        <div className="admin-service-name"><strong>{group.name}</strong><small>{group.role} · {group.purpose}</small></div>
        <div className="admin-service-state"><span className="admin-analysis-status">
          <span className={'admin-status-dot ' + (group.recent.length ? 'is-active' : 'is-queued')} />
          {group.recent.length ? '近期有上报' : '未收到近期上报'}</span>
          <small>{group.recent.length} 个近期上报实例{group.stale.length > 0 && ` · ${group.stale.length} 条旧记录待核实`}</small></div>
        <div className="admin-service-time"><strong>{reportAge(group.latest.observed_at, observedAt)}</strong>
          <small>{reportTime(group.latest.observed_at)}</small></div>
        <button aria-label={`查看${group.name}实例`} onClick={() => setSelected(group.role)}>查看实例</button>
      </article>)}</div>
    </>}
    <p className="admin-monitor-footnote">旧记录可能来自重启、缩容或上报中断，不能确认已退出；同名仍有上报也不代表全部实例正常。此处未配置预期副本数，仅展示已收到报告的服务。</p>
    {current && <AdminModal title={current.name + ' · 实例与报告'} close={() => setSelected(null)}>
      <p className="admin-muted">每条记录是一个运行实例的最后一份报告，不是一次分析任务。相对时间以本次刷新为准。</p>
      <h3>近期上报实例 · {current.recent.length} 个</h3>
      {current.recent.length ? <InstanceReports key={current.role + ':recent'} rows={current.recent} observedAt={observedAt} />
        : <p className="admin-monitor-warning">目前没有近期上报，运行状态需要检查。</p>}
      {current.stale.length > 0 && <details className="admin-instance-history">
        <summary>未再上报的旧实例 · {current.stale.length} 条待核实记录</summary>
        <p className="admin-muted">没有退出记录或部署副本数，无法区分已退出实例和异常失联实例。保留这些报告供排查，不把旧指标当成当前值。</p>
        <InstanceReports key={current.role + ':stale'} rows={current.stale} observedAt={observedAt} />
      </details>}
    </AdminModal>}
  </section>;
}
