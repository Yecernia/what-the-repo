import { useMemo, useState, type ReactNode } from 'react';
import type { AdminRow } from './admin-api';
import { matches, money, record, rows, time, useOptions } from './admin-format';
import {
  FilterSelect, ListToolbar, PagedTable, SearchInput, Table, ViewSwitch,
} from './AdminListViews';

const businessNames: Record<string, string> = {
  analysis: '仓库分析', chat: '聊天', evolution: '自进化', historical_unclassified: '历史未分类',
};
const payerNames: Record<string, string> = {
  platform: '平台', user: '用户自带 Key', historical_unclassified: '历史未分类',
};
const agentNames: Record<string, string> = {
  'primary-chat': '聊天', 'learning-route': '学习路线', 'repository-analysis': '仓库分析',
  'component-explanation': '组件讲解', 'feedback-analysis': '反馈分析', evolution: '自进化',
  'connection-verification': '连接验证',
};
const triggerNames: Record<string, string> = { background: '后台', manual: '手动', initial: '首次' };
const statusNames: Record<string, string> = {
  queued: '排队中', running: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
};
const label = (names: Record<string, string>) => (v: unknown) =>
  v === null || v === undefined || v === '' ? '未标注' : names[String(v)] ?? String(v);
const includes = (row: AdminRow, keys: string[], query: string) =>
  !query.trim() || keys.some((key) => String(row[key] ?? '').toLowerCase().includes(query.trim().toLowerCase()));
const sum = (list: AdminRow[], key: string) => list.reduce((total, row) => total + Number(row[key] ?? 0), 0);

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="admin-card">
      <div className="admin-card-title"><h2>{title}</h2>{aside}</div>
      {children}
    </section>
  );
}

/** Groups rows by the given fields and adds up the numeric columns. */
function group(list: AdminRow[], keys: string[], extra: (items: AdminRow[]) => AdminRow) {
  const groups = new Map<string, AdminRow[]>();
  for (const row of list) {
    const id = keys.map((key) => String(row[key] ?? '')).join('\u0000');
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id, ...Object.fromEntries(keys.map((key) => [key, items[0]![key]])), ...extra(items),
  }) as AdminRow);
}

export function RepositoryUpdateUsage({ data, capped }: { data: AdminRow[]; capped: boolean }) {
  const [view, setView] = useState<'repository' | 'update'>('repository');
  const [trigger, setTrigger] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState('recent');
  const statuses = useOptions(data, 'status', statusNames);
  const filtered = useMemo(() => data.filter((row) => matches(row, 'trigger', trigger)
    && matches(row, 'status', status) && includes(row, ['repository_identity'], query)),
  [data, trigger, status, query]);
  const repositories = useMemo(() => group(filtered, ['repository_identity'], (items) => ({
    updates: items.length,
    background: items.filter((row) => row.trigger === 'background').length,
    succeeded: items.filter((row) => row.status === 'succeeded').length,
    failed: items.filter((row) => row.status === 'failed').length,
    used: sum(items, 'used'), reserved: sum(items, 'reserved'),
    last_at: items.reduce((last, row) => String(row.created_at) > last ? String(row.created_at) : last, ''),
  })).sort((a, b) => order === 'cost' ? Number(b.used) - Number(a.used)
    : order === 'count' ? Number(b.updates) - Number(a.updates)
      : String(b.last_at).localeCompare(String(a.last_at))), [filtered, order]);
  const resetKey = [view, trigger, status, query, order].join('|');
  return (
    <Card title="仓库更新用量" aside={<ViewSwitch label="仓库更新用量视图" value={view} onChange={setView}
      options={[['repository', '按仓库汇总'], ['update', '逐次明细']]} />}>
      <p className="admin-muted">最近 30 天的共享更新（手动、后台和首次分析），费用按更新累计，跨天不重置。</p>
      <ListToolbar summary={`${filtered.length} 次更新 · ${repositories.length} 个仓库 · 已知费用 ${money(sum(filtered, 'used'))}`}>
        <SearchInput label="仓库" value={query} onChange={setQuery} placeholder="owner/repo" />
        <FilterSelect label="触发" value={trigger} onChange={setTrigger}
          options={Object.entries(triggerNames)} />
        <FilterSelect label="状态" value={status} onChange={setStatus} options={statuses} />
        {view === 'repository' && (
          <label>
            排序
            <select value={order} onChange={(event) => setOrder(event.target.value)}>
              <option value="recent">最近更新</option>
              <option value="cost">费用最高</option>
              <option value="count">次数最多</option>
            </select>
          </label>
        )}
      </ListToolbar>
      {view === 'repository' ? (
        <PagedTable data={repositories} resetKey={resetKey} label="仓库更新汇总" empty="没有符合条件的更新"
          columns={[
            ['repository_identity', '仓库'],
            ['updates', '更新次数'],
            ['background', '后台'],
            ['succeeded', '成功'],
            ['failed', '失败'],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            ['last_at', '最近一次', time],
          ]} />
      ) : (
        <PagedTable data={filtered} resetKey={resetKey} label="仓库更新明细" empty="没有符合条件的更新"
          columns={[
            ['repository_identity', '仓库'],
            ['trigger', '触发', label(triggerNames)],
            ['status', '状态', label(statusNames)],
            ['created_at', '开始', time],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            ['remaining', '剩余', (v) => (capped ? money(v) : '不设限')],
            ['unknown_calls', '未知用量次数'],
          ]} />
      )}
    </Card>
  );
}

export function EvolutionTaskUsage({ data, capped }: { data: AdminRow[]; capped: boolean }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => data.filter((row) => includes(row, ['task_id'], query)), [data, query]);
  return (
    <Card title="自进化单任务用量">
      <p className="admin-muted">最近 100 个任务，按任务累计，跨天不重置；每日总预算同时适用。</p>
      <ListToolbar summary={`${filtered.length} 个任务 · 已知费用 ${money(sum(filtered, 'used'))}`}>
        <SearchInput label="任务" value={query} onChange={setQuery} placeholder="任务编号" />
      </ListToolbar>
      <PagedTable data={filtered} resetKey={query} label="自进化任务" empty="没有符合条件的任务"
        columns={[
          ['task_id', '任务'],
          ['used', '已知费用', money],
          ['reserved', '预留', money],
          ['remaining', '剩余', (v) => (capped ? money(v) : '不设限')],
          ['unknown_calls', '未知用量次数'],
        ]} />
    </Card>
  );
}

export function UsageAttribution({ data }: { data: AdminRow[] }) {
  const [view, setView] = useState<'summary' | 'task'>('summary');
  const [business, setBusiness] = useState('');
  const [payer, setPayer] = useState('');
  const [agent, setAgent] = useState('');
  const [query, setQuery] = useState('');
  const businesses = useOptions(data, 'business', businessNames);
  const payers = useOptions(data, 'payer', payerNames);
  const agents = useOptions(data, 'agent_role', agentNames);
  const filtered = useMemo(() => data.filter((row) => matches(row, 'business', business)
    && matches(row, 'payer', payer) && matches(row, 'agent_role', agent)
    && includes(row, ['task_id', 'connection_id'], query))
    .sort((a, b) => Number(b.used) - Number(a.used)), [data, business, payer, agent, query]);
  const summary = useMemo(() => group(filtered, ['business', 'payer', 'agent_role'], (items) => ({
    tasks: new Set(items.map((row) => row.task_id ?? '')).size,
    calls: sum(items, 'calls'), used: sum(items, 'used'), reserved: sum(items, 'reserved'),
    unknown_calls: sum(items, 'unknown_calls'),
  })).sort((a, b) => Number(b.used) - Number(a.used)), [filtered]);
  const resetKey = [view, business, payer, agent, query].join('|');
  const unknown = sum(filtered, 'unknown_calls');
  return (
    <Card title="用量归属" aside={<ViewSwitch label="用量归属视图" value={view} onChange={setView}
      options={[['summary', '按业务汇总'], ['task', '按任务明细']]} />}>
      <p className="admin-muted">
        今日（北京时间）的模型调用。这是程序预算记录，不是厂商结算账单；旧数据无法可靠分类时显示历史未分类。
      </p>
      <ListToolbar summary={`${sum(filtered, 'calls')} 次调用 · 已知费用 ${money(sum(filtered, 'used'))}`
        + (unknown ? ` · ${unknown} 次用量未知` : '')}>
        <FilterSelect label="业务" value={business} onChange={setBusiness} options={businesses} />
        <FilterSelect label="费用承担方" value={payer} onChange={setPayer} options={payers} />
        <FilterSelect label="Agent" value={agent} onChange={setAgent} options={agents} />
        {view === 'task' && (
          <SearchInput label="任务或连接" value={query} onChange={setQuery} placeholder="任务编号或连接" />
        )}
      </ListToolbar>
      {view === 'summary' ? (
        <PagedTable data={summary} resetKey={resetKey} label="用量汇总" empty="今日还没有符合条件的调用"
          columns={[
            ['business', '业务', label(businessNames)],
            ['payer', '费用承担方', label(payerNames)],
            ['agent_role', 'Agent', label(agentNames)],
            ['tasks', '任务数'],
            ['calls', '调用次数'],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            ['unknown_calls', '未知用量次数'],
          ]} />
      ) : (
        <PagedTable data={filtered} resetKey={resetKey} label="用量明细" empty="今日还没有符合条件的调用"
          columns={[
            ['task_id', '任务'],
            ['business', '业务', label(businessNames)],
            ['payer', '费用承担方', label(payerNames)],
            ['agent_role', 'Agent', label(agentNames)],
            ['connection_id', '连接'],
            ['config_version', '配置版本'],
            ['calls', '调用次数'],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            ['unknown_calls', '未知用量次数'],
          ]} />
      )}
    </Card>
  );
}

type Rules = { commitThreshold: number; maxSnapshotAgeDays: number; minUpdateIntervalHours: number;
  activeWindowDays: number; maxStartsPerDay: number; intervalMinutes: number };
function decisionText(decision: string, rules: Rules) {
  return ({
    queued: '已启动后台更新',
    up_to_date: '已是最新',
    same: '与上游一致，无需更新',
    inactive: `最近 ${rules.activeWindowDays} 天没人使用`,
    check_failed: '查询上游失败，下轮重试',
    check_stale: '上游信息不完整或已过期，下轮再查',
    unknown_relation: '无法判断与上游的关系',
    below_threshold: `新提交不足 ${rules.commitThreshold} 个，当前版本不满 ${rules.maxSnapshotAgeDays} 天，也没有新 release`,
    interval: `距上次后台更新不足 ${rules.minUpdateIntervalHours} 小时`,
    'deferred:disabled': '后台更新未开启',
    'deferred:unavailable': '仓库记录不可用',
    'deferred:inactive': `最近 ${rules.activeWindowDays} 天没人使用`,
    'deferred:interval': `距上次后台更新不足 ${rules.minUpdateIntervalHours} 小时`,
    'deferred:suppressed': '这个上游版本上次更新失败，等有新提交再试',
    'deferred:active_update': '已有更新在进行',
    'deferred:capacity': '后台更新队列已满',
    'deferred:budget_off': '预算设为 0，后台更新已关闭',
    'deferred:daily_starts': `今日已启动 ${rules.maxStartsPerDay} 次，达到上限`,
    'deferred:daily_budget': '今日后台更新预算不足',
  } as Record<string, string>)[decision] ?? decision;
}
function decisionTone(decision: string) {
  return decision === 'queued' ? 'is-active' : decision === 'check_failed' ? 'is-failed'
    : decision.startsWith('deferred') ? 'is-queued' : '';
}
function relationText(relation: unknown, behind: unknown) {
  return relation === 'ahead' ? `上游新增 ${behind ?? '?'} 个提交`
    : relation === 'same' ? '一致' : relation === 'diverged' ? '与上游分叉'
      : relation === 'rewound' ? '上游回退' : '未知';
}
function runSummary(run: AdminRow, rules: Rules) {
  if (run.error) return '本轮出错：' + String(run.error);
  const decisions = rows(record(run.outcome).decisions);
  if (!decisions.length) return `没有到检查时间的仓库（只检查最近 ${rules.activeWindowDays} 天有人用过的仓库）`;
  const counts = new Map<string, number>();
  for (const row of decisions) {
    const reason = decisionText(String(row.decision), rules);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${count} 个${reason}`).join('；');
}

export function BackgroundScheduling({ data }: { data: AdminRow }) {
  const rules = data as unknown as Rules;
  const runs = rows(data.runs);
  const [filter, setFilter] = useState('');
  const latest = runs[0];
  const outcome = record(latest?.outcome);
  const decisions = rows(outcome.decisions);
  const history = useMemo(() => runs.filter((run) => {
    const result = record(run.outcome);
    return !filter || (filter === 'queued' ? Number(result.queued) > 0
      : Boolean(run.error) || Number(result.deferred) > 0 || Number(result.failedChecks) > 0);
  }), [runs, filter]);
  const enabled = Boolean(data.enabled);
  return (
    <Card title="后台仓库更新" aside={
      <span className="admin-analysis-status">
        <span className={'admin-status-dot' + (enabled ? ' is-active' : '')} />{enabled ? '已开启' : '未开启'}
      </span>}>
      <p className="admin-muted">
        每 {rules.intervalMinutes} 分钟检查一次最近 {rules.activeWindowDays} 天有人打开过的仓库。
        上游新增至少 {rules.commitThreshold} 个提交、发布了新 release，或当前版本已超过 {rules.maxSnapshotAgeDays} 天且上游有变化时才会启动；
        同一仓库 {rules.minUpdateIntervalHours} 小时内最多一次，每天最多启动 {rules.maxStartsPerDay} 次。
      </p>
      {!enabled ? (
        <p className="admin-empty">后台更新未开启（部署配置 WHAT_THE_REPO_REPOSITORY_BACKGROUND_REFRESH_ENABLED）。</p>
      ) : !latest ? (
        <p className="admin-empty">最近 24 小时还没有调度记录。</p>
      ) : (
        <>
          <dl className="admin-amounts admin-background-stats">
            <div><dt>最近一轮</dt><dd>{time(latest.started_at)}</dd></div>
            <div><dt>检查仓库</dt><dd>{Number(outcome.examined ?? 0)}</dd></div>
            <div><dt>启动</dt><dd>{Number(outcome.queued ?? 0)}</dd></div>
            <div><dt>推迟 / 查询失败</dt><dd>{Number(outcome.deferred ?? 0)} / {Number(outcome.failedChecks ?? 0)}</dd></div>
          </dl>
          {latest.error ? <p className="admin-warning">本轮出错：{String(latest.error)}</p> : (
            <Table data={decisions} empty={runSummary(latest, rules)} columns={[
              ['repository', '仓库'],
              ['relation', '与上游', (v, row) => relationText(v, row.behindCommits)],
              ['decision', '结果', (v) => (
                <span className="admin-analysis-status">
                  <span className={'admin-status-dot ' + decisionTone(String(v))} />{decisionText(String(v), rules)}
                </span>
              )],
            ]} />
          )}
          <details className="admin-details admin-background-history">
            <summary>最近 24 小时的调度记录（{runs.length} 轮）</summary>
            <ListToolbar summary={`${history.length} 轮`}>
              <FilterSelect label="只看" value={filter} onChange={setFilter}
                options={[['queued', '有启动的轮次'], ['issue', '有推迟、失败或出错的轮次']]} />
            </ListToolbar>
            <PagedTable data={history} pageSize={12} resetKey={filter} label="后台调度记录" empty="没有符合条件的轮次"
              columns={[
                ['started_at', '时间', time],
                ['outcome', '检查', (v) => Number(record(v).examined ?? 0)],
                ['queued', '启动', (_v, row) => Number(record(row.outcome).queued ?? 0)],
                ['summary', '概况', (_v, row) => runSummary(row, rules)],
              ]} />
          </details>
        </>
      )}
    </Card>
  );
}
