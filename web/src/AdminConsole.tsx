import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import QRCode from 'qrcode';
import ShieldCheck from '@sketchyicons/react/icons/shield-check';
import RefreshCw from '@sketchyicons/react/icons/refresh-cw';
import { Settings, LogOut, Plus } from './HandIcons';
import { adminRequest, type AdminRow } from './admin-api';
import {
  AdminAudienceCharts,
  type AudienceSample,
} from './AdminAudienceCharts';
import {
  formatGB as bytes,
  storagePolicyInputs,
  storagePolicyPayload,
} from './admin-storage-units';
import './admin.css';
import { AdminCode, AdminDiffButton } from './AdminCode';
import { AdminModal, UserIdentity, Pagination, RepositoryName, RepositoryUsers, AnalysisStatus } from './AdminRepositoryViews';

const pages = [
  ['overview', '总览'],
  ['activity', '任务与用户'],
  ['config', 'Agent 与厂商'],
  ['budgets', '预算'],
  ['feedback', '反馈与自进化'],
  ['storage', '存储管理'],
  ['audit', '操作记录'],
] as const;
type Page = (typeof pages)[number][0];
interface Auth {
  enabled: boolean;
  authenticated: boolean;
  github_verified?: boolean;
  enrolled?: boolean;
  csrf?: string;
  expires_at?: number;
  isolatedPreview?: boolean;
}
interface Connection {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  models: string[];
  masked?: string;
  verifiedAt?: string | null;
  apiKey?: string;
}
interface Version {
  version: number;
  createdAt: string;
  actor: string;
  connections: Connection[];
  agents: Record<string, { connectionId: string; model: string }>;
}
const money = (v: unknown) =>
  v === null || v === undefined ? '未知' : `$${Number(v).toFixed(4)}`;
const time = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';
const rows = (v: unknown): AdminRow[] =>
  Array.isArray(v) ? (v as AdminRow[]) : [];
const record = (v: unknown): AdminRow =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AdminRow) : {};
const text = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
const budgetNames: Record<string, string> = {
  analysis_daily: '平台每日仓库分析',
  chat_daily: '平台每日免费聊天',
  evolution_task: '自进化单任务',
  evolution_daily: '自进化每日总额',
};
function Card({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="admin-card">
      <div className="admin-card-title">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
function Table({
  data,
  columns,
}: {
  data: AdminRow[];
  columns: Array<
    | [string, string, (v: unknown, row: AdminRow) => ReactNode]
    | [string, string]
  >;
}) {
  if (!data.length) return <p className="admin-empty">暂无记录</p>;
  return (
    <div className="admin-table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label], index) => (
              <th key={key + index}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={String(
                row.id ?? row.job_id ?? row.project_id ?? row.owner_id ?? i,
              )}
            >
              {columns.map(([key, , format], index) => (
                <td key={key + index}>
                  {format ? format(row[key], row) : row[key] && typeof row[key] === 'object'
                    ? <AdminCode source={JSON.stringify(row[key], null, 2)} /> : text(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Details({
  value,
  label = '查看详细记录',
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="admin-details">
      <summary>{label}</summary>
      <AdminCode source={JSON.stringify(value, null, 2) ?? 'null'} />
    </details>
  );
}

export default function AdminConsole() {
  const [auth, setAuth] = useState<Auth | null>(null),
    [page, setPageValue] = useState<Page>('overview'),
    [userPage, setUserPage] = useState(1),
    [repositoryPage, setRepositoryPage] = useState(1),
    [storedPage, setStoredPage] = useState(1),
    [data, setData] = useState<AdminRow | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const setPage = (next: Page) => {
    requestSequence.current++;
    setData(null);
    setPageValue(next);
  };
  const [code, setCode] = useState(''),
    [bootstrap, setBootstrap] = useState(''),
    [enrollment, setEnrollment] = useState<{
      seed: string;
      uri: string;
      qr: string;
    } | null>(null),
    [recovery, setRecovery] = useState<string[]>([]),
    [recoverMode, setRecoverMode] = useState(false);
  const loadAuth = useCallback(async () => {
    try {
      setAuth(await adminRequest<Auth>('/auth/status'));
    } catch (e) {
      setAuth(null);
      setError((e as Error).message);
    }
  }, []);
  const load = useCallback(async () => {
    if (!auth?.authenticated) return;
    const sequence = ++requestSequence.current;
    try {
      const result = await adminRequest('/' + page + (page === 'activity' ? '?user_page=' + userPage + '&repository_page=' + repositoryPage : page === 'storage' ? '?repository_page=' + storedPage : ''));
      if (sequence === requestSequence.current) setData(result);
    } catch (e) {
      if (sequence !== requestSequence.current) return;
      setError((e as Error).message);
      await loadAuth();
    }
  }, [page, userPage, repositoryPage, storedPage, auth?.authenticated, loadAuth]);
  useEffect(() => {
    document.title = '管理台 · what-the-repo';
    void loadAuth();
  }, [loadAuth]);
  useEffect(() => {
    setData(null);
    setError('');
    void load();
  }, [load]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const timer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        ['overview', 'activity', 'audit'].includes(page)
      )
        void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [auth?.authenticated, page, load]);
  async function action(path: string, body: unknown = {}, method = 'POST') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await adminRequest(path, method, body, auth?.csrf);
      setNotice('操作已完成。');
      await load();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function authenticate(operation: string) {
    const result = await action('/auth/' + operation, { code, bootstrap });
    setCode('');
    setBootstrap('');
    if (!result) return;
    if (typeof result.uri === 'string')
      setEnrollment({
        seed: String(result.seed),
        uri: result.uri,
        qr: await QRCode.toDataURL(result.uri, { width: 224, margin: 2 }),
      });
    else {
      setEnrollment(null);
      setRecovery(
        Array.isArray(result.recovery_codes)
          ? (result.recovery_codes as string[])
          : [],
      );
      await loadAuth();
    }
  }
  const login = '/api/auth/github/start?return_to=%2Fadmin';
  if (!auth?.authenticated)
    return (
      <div className="admin-console admin-login">
        <a className="admin-wordmark" href="/">
          what-the-repo<span>管理台</span>
        </a>
        <main className="admin-login-panel">
          <ShieldCheck size={34} />
          <h1>管理员登录</h1>
          <p>GitHub 固定账号验证，通过后输入 Authenticator 验证码。</p>
          {error && (
            <div role="alert" className="admin-error">
              {error}
            </div>
          )}
          {!auth ? (
            error ? <button onClick={() => { setError(''); void loadAuth(); }}>重新连接管理服务</button>
              : <p>正在检查登录状态…</p>
          ) : !auth.enabled ? (
            <p>管理功能尚未启用，请先配置固定 GitHub 账号 ID 与管理密钥。</p>
          ) : !auth.github_verified ? (
            <a className="admin-primary" href={login}>
              使用 GitHub 登录
            </a>
          ) : enrollment ? (
            <>
              <h2>绑定 Authenticator</h2>
              <p>使用手机验证器扫码，然后输入新验证码确认。</p>
              <img
                width="224"
                height="224"
                src={enrollment.qr}
                alt="Authenticator 绑定二维码"
              />
              <details>
                <summary>无法扫码时手动输入</summary>
                <code className="admin-secret">{enrollment.seed}</code>
              </details>
              <label>
                新验证器的 6 位验证码
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                />
              </label>
              <button
                className="admin-primary"
                disabled={busy || code.length !== 6}
                onClick={() => void authenticate('confirm')}
              >
                确认绑定并登录
              </button>
            </>
          ) : !auth.enrolled ? (
            <>
              <p>首次绑定需要部署时生成的初始化凭据。</p>
              <label>
                初始化凭据
                <input
                  type="password"
                  autoComplete="off"
                  value={bootstrap}
                  onChange={(e) => setBootstrap(e.target.value)}
                />
              </label>
              <button
                className="admin-primary"
                disabled={busy || !bootstrap}
                onClick={() => void authenticate('enroll')}
              >
                开始绑定
              </button>
            </>
          ) : (
            <>
              <label>
                {recoverMode ? '一次性恢复码' : 'Authenticator 验证码'}
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  inputMode={recoverMode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  maxLength={recoverMode ? 24 : 6}
                />
              </label>
              <button
                className="admin-primary"
                disabled={busy || !code}
                onClick={() =>
                  void authenticate(recoverMode ? 'recover' : 'verify')
                }
              >
                {recoverMode ? '验证恢复码并更换验证器' : '验证并进入'}
              </button>
              <button
                className="admin-link"
                onClick={() => {
                  setRecoverMode(!recoverMode);
                  setCode('');
                }}
              >
                {recoverMode ? '使用验证码登录' : '无法使用验证器？使用恢复码'}
              </button>
              <button
                className="admin-link"
                disabled={busy || code.length !== 6 || recoverMode}
                onClick={() => void authenticate('replace')}
              >
                验证当前验证码并更换验证器
              </button>
            </>
          )}
          <p className="admin-muted">
            管理会话最长 8 小时，30
            分钟无操作后过期。登录后无需为每次操作再次输入验证码。
          </p>
        </main>
      </div>
    );
  return (
    <div className="admin-console">
      <aside className="admin-sidebar">
        <a className="admin-wordmark" href="/admin">
          what-the-repo<span>管理台</span>
        </a>
        <div className="admin-access">
          <ShieldCheck size={18} /> 二步验证已完成
        </div>
        <nav aria-label="管理台导航">
          {pages.map(([id, label], i) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setPage(id);
                setNotice('');
              }}
            >
              <span className="admin-nav-number">0{i + 1}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <span>北京时间 · UTC+8</span>
          <button
            onClick={async () => {
              if (await action('/auth/logout')) {
                setAuth(null);
                setData(null);
                await loadAuth();
              }
            }}
          >
            <LogOut size={18} />
            注销
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div>
            <span className="admin-eyebrow">WHAT-THE-REPO / ADMIN</span>
            <h1>{pages.find((p) => p[0] === page)?.[1]}</h1>
          </div>
          <button
            className="admin-refresh"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={17} />
            刷新
          </button>
        </header>
        {auth.isolatedPreview && (
          <div className="admin-notice">
            隔离本机预览 · 模拟 GitHub 身份与示例数据 · 不连接付费模型
          </div>
        )}
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="admin-notice" role="status">
            {notice}
          </div>
        )}
        {!!recovery.length && (
          <Card title="保存一次性恢复码">
            <p>
              这些恢复码仅显示这一次。每个只能使用一次，使用后需要重新绑定验证器。
            </p>
            <div className="admin-recovery">
              {recovery.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </div>
            <button onClick={() => setRecovery([])}>我已安全保存</button>
          </Card>
        )}
        {!data ? (
          <p className="admin-empty">正在读取…</p>
        ) : page === 'overview' ? (
          <Overview data={data} />
        ) : page === 'activity' ? (
          <Activity data={data} onUserPage={setUserPage} onRepositoryPage={setRepositoryPage} />
        ) : page === 'budgets' ? (
          <Budgets
            data={data}
            busy={busy}
            save={(b) => action('/budgets', b, 'PUT')}
          />
        ) : page === 'config' ? (
          <Connections
            data={data}
            busy={busy}
            save={(b) => action('/config', b, 'PUT')}
            verify={(id) => action('/connections/' + id + '/verify')}
          />
        ) : page === 'feedback' ? (
          <Feedback
            data={data}
            busy={busy}
            act={(id, a, b) => action('/evolution/' + id + '/' + a, b)}
          />
        ) : page === 'storage' ? (
          <Storage data={data} busy={busy} act={action} onRepositoryPage={setStoredPage} />
        ) : (
          <Card title="最近的管理操作">
            <p className="admin-muted">
              记录操作和结果，不记录 Key、验证码或请求正文。
            </p>
            <Table
              data={rows(data.entries)}
              columns={[
                ['created_at', '北京时间', (v) => time(v)],
                ['actor', '管理员'],
                ['action', '操作'],
                ['target', '对象'],
                ['outcome', '结果'],
              ]}
            />
          </Card>
        )}
        <footer className="admin-footer">
          what-the-repo · 管理接口逐项授权 · 金额为程序用量记录
        </footer>
      </main>
    </div>
  );
}
function Overview({ data }: { data: AdminRow }) {
  const online = record(data.online),
    jobs = record(data.jobs),
    health = record(data.health),
    metrics = record(data.metrics);
  const active = rows(metrics.gauges).filter(
    (g) => g.name === 'what_the_repo_provider_calls_active',
  );
  return (
    <>
      <p className="admin-description">
        查看服务运行情况与近期活动。采集时间 {time(data.observedAt)}。
      </p>
      <div className="admin-stat-grid">
        {[
          ['服务健康', health.database ? '正常' : '异常', 'API 与数据库'],
          [
            '近 90 秒在线',
            Number(online.github) + Number(online.guest),
            `登录用户 ${online.github} · 访客 ${online.guest}`,
          ],
          ['分析执行中', jobs.running, `排队 ${jobs.queued} 项`],
          [
            '当前模型请求数',
            active.length
              ? active.reduce((s, r) => s + Number(r.value), 0)
              : '未知',
            'API 服务当前正在进行的模型请求',
          ],
        ].map(([label, value, note]) => (
          <section className="admin-stat" key={String(label)}>
            <span>{text(label)}</span>
            <strong>{text(value)}</strong>
            <small>{text(note)}</small>
          </section>
        ))}
      </div>
      <p className="admin-muted admin-online-note" title="相同身份多标签页只计一次；手机后台停止心跳；访客按浏览器身份近似统计，不等于真实人数。">在线：近 90 秒有前台心跳的去重身份 <span aria-label="在线统计说明">ⓘ</span></p>
      {rows(data.observations).some(r => !r.fresh) && <p className="admin-monitor-warning">部分服务的监控上报已过期，可展开下方状态查看。</p>}
      <AdminAudienceCharts
        audience={record(data.audience)}
        history={rows(data.audienceHistory) as unknown as AudienceSample[]}
        observedAt={String(data.observedAt)}
      />
      <details className="admin-monitor-details"><summary>运行参数与监控上报状态</summary>
        <Card title="运行参数">
          <p className="admin-muted">由部署配置调整。</p>
          <Table
            data={Object.entries(record(data.tuning)).map(([name, value]) => ({
              name,
              value,
            }))}
            columns={[
              ['name', '参数'],
              ['value', '当前值'],
            ]}
          />
        </Card>
      <Card title="监控上报状态">
        <p className="admin-muted">
          各个服务定期报告运行情况。超过 45 秒未收到报告会标记过期，表示监控数据可能不再可靠，并不直接等于服务宕机。
        </p>
        <Table
          data={rows(data.observations)}
          columns={[
            ['role', '服务'],
            ['observed_at', '采集时间', (v) => time(v)],
            ['fresh', '状态', (v) => (v ? '有效' : '已过期')],
            ['payload', '指标', (v) => <Details value={v} />],
          ]}
        />
      </Card>
      </details>
      <Card title="预算与错误">
        <p>
          已有失败分析任务 {text(jobs.failed)} 项。日预算采用北京时间自然日。
        </p>
        <Table
          data={rows(data.budgets)}
          columns={[
            ['key', '业务', (v) => budgetNames[String(v)]],
            ['limit', '限额', (v) => (v === null ? '不设限' : money(v))],
            ['used', '已用', money],
            ['reserved', '预留', money],
            [
              'remaining',
              '剩余',
              (v, r) => (r.limit === null ? '不设限' : money(v)),
            ],
          ]}
        />
      </Card>
      <Card title="请求、模型、队列与数据库指标">
        <Details label="展开现有运行指标" value={metrics} />
      </Card>
    </>
  );
}
function Activity({ data, onUserPage, onRepositoryPage }: { data: AdminRow; onUserPage: (page: number) => void; onRepositoryPage: (page:number) => void }) {
  const pagination = record(data.userPagination);
  return (
    <>
      <p className="admin-description">分析任务按仓库汇总本次分析状态与请求用户；用户列表在线优先。两个列表独立分页。</p>
      <Card title="分析任务">
        <Table
          data={rows(data.repositories)}
          columns={[
            ['repository_identity', '仓库', (_, row) => <RepositoryName row={row} />],
            ['users', '本次分析请求用户', (_, row) => <RepositoryUsers row={row} kind="analysis" />],
            ['status', '阶段', (_, row) => <AnalysisStatus row={row} />],
            ['updated_at', '最近更新', (v) => time(v)],
            ['analysis', '详情', (v) => <Details value={v} />],
          ]}
        />
      <Pagination value={record(data.repositoryPagination)} onChange={onRepositoryPage} label="仓库分析" />
      </Card>
      <Card title="用户与访客">
        <Table
          data={rows(data.users)}
          columns={[
            ['owner_id', '用户 / 访客', (_, row) => <UserIdentity row={row} />],
            ['last_seen_at', '最近活动', (v) => time(v)],
            ['deleted_at', '软删除', (v) => time(v)],
            ['purge_after', '恢复截止', (v) => time(v)],
          ]}
        />
        <Pagination value={pagination} onChange={onUserPage} label="用户与访客" />
      </Card>

    </>
  );
}
function Budgets({
  data,
  busy,
  save,
}: {
  data: AdminRow;
  busy: boolean;
  save: (b: unknown) => Promise<unknown>;
}) {
  const [policies, setPolicies] = useState<Record<string, number | null>>(
    record(data.policies) as Record<string, number | null>,
  );
  useEffect(() => {
    setPolicies(record(data.policies) as Record<string, number | null>);
  }, [data]);
  return (
    <>
      <p className="admin-description">
        每日额度按北京时间自然日重置，下次重置 {time(data.resetAt)}
        。金额单位为美元。
      </p>
      <div className="admin-budget-grid">
        {rows(data.budgets).map((row) => {
          const key = String(row.key);
          return (
            <Card key={key} title={budgetNames[key] ?? key}>
              <label>
                金额限制
                <select
                  aria-label={budgetNames[key] + '限制'}
                  value={policies[key] === null ? 'unlimited' : 'limited'}
                  onChange={(e) =>
                    setPolicies({
                      ...policies,
                      [key]: e.target.value === 'unlimited' ? null : 0,
                    })
                  }
                >
                  <option value="limited">设置金额</option>
                  <option value="unlimited">不设限</option>
                </select>
              </label>
              {policies[key] !== null && (
                <label>
                  预算金额（USD）
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={policies[key] ?? 0}
                    onChange={(e) =>
                      setPolicies({
                        ...policies,
                        [key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              <dl className="admin-amounts">
                <div>
                  <dt>已用</dt>
                  <dd>
                    {key === 'evolution_task' ? '按任务查看' : money(row.used)}
                  </dd>
                </div>
                <div>
                  <dt>预留</dt>
                  <dd>
                    {key === 'evolution_task'
                      ? '按任务查看'
                      : money(row.reserved)}
                  </dd>
                </div>
                <div>
                  <dt>剩余</dt>
                  <dd>
                    {row.limit === null
                      ? '不设限'
                      : key === 'evolution_task'
                        ? '按任务查看'
                        : money(row.remaining)}
                  </dd>
                </div>
              </dl>
              {Number(row.unknownCalls) > 0 && (
                <p className="admin-warning">
                  有 {Number(row.unknownCalls)} 次调用用量未知，保留估计预留。
                </p>
              )}
            </Card>
          );
        })}
      </div>
      <button
        className="admin-primary"
        disabled={busy}
        onClick={() => void save(policies)}
      >
        保存预算
      </button>
      <p className="admin-muted">
        0 表示不接受新的有费用调用；不设限不会绕过其他适用预算。用户自带 Key
        不扣平台额度，个人金额限制默认不启用。
      </p>
      <Card title="自进化单任务用量">
        <p className="admin-muted">
          按任务累计，跨天不重置；每日总预算同时适用。
        </p>
        <Table
          data={rows(data.tasks)}
          columns={[
            ['task_id', '任务'],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            [
              'remaining',
              '剩余',
              (v) => (policies.evolution_task === null ? '不设限' : money(v)),
            ],
            ['unknown_calls', '未知用量次数'],
          ]}
        />
      </Card>
      <Card title="用量归属">
        <p className="admin-muted">
          这是程序预算记录，不是厂商结算账单。旧数据无法可靠分类时显示历史未分类。
        </p>
        <Table
          data={rows(data.usage)}
          columns={[
            ['business', '业务'],
            ['payer', '费用承担方'],
            ['agent_role', 'Agent'],
            ['connection_id', '连接'],
            ['config_version', '配置版本'],
            ['task_id', '任务'],
            ['used', '已知费用', money],
            ['reserved', '预留', money],
            ['unknown_calls', '未知用量次数'],
          ]}
        />
      </Card>
    </>
  );
}
function Connections({
  data,
  busy,
  save,
  verify,
}: {
  data: AdminRow;
  busy: boolean;
  save: (b: unknown) => Promise<unknown>;
  verify: (id: string) => Promise<AdminRow | null>;
}) {
  const history = (data.versions ?? []) as Version[],
    current = history.at(-1);
  const [connections, setConnections] = useState<Connection[]>(
      current?.connections ?? [],
    ),
    [agents, setAgents] = useState<Version['agents']>(current?.agents ?? {}),
    [result, setResult] = useState('');
  useEffect(() => {
    setConnections(current?.connections ?? []);
    setAgents(current?.agents ?? {});
  }, [current]);
  function change(index: number, patch: Partial<Connection>) {
    setConnections(
      connections.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  }
  return (
    <>
      <p className="admin-description">
        当前配置版本 {current?.version ?? '部署默认'}
        。保存后新任务生效，已创建的任务保留原版本。
      </p>
      {result && (
        <div role="status" className="admin-notice">
          {result}
        </div>
      )}
      <Card
        title="厂商连接"
        aside={
          <button
            onClick={() =>
              setConnections([
                ...connections,
                {
                  id: 'connection-' + Date.now(),
                  label: '新连接',
                  provider: 'custom',
                  baseUrl: '',
                  models: [],
                  apiKey: '',
                },
              ])
            }
          >
            <Plus size={17} />
            添加连接
          </button>
        }
      >
        {!connections.length && (
          <p className="admin-empty">
            当前沿用部署配置。添加连接后可为 Agent 分配模型。
          </p>
        )}
        {connections.map((c, i) => (
          <div className="admin-connection" key={c.id}>
            <div className="admin-form-grid">
              <label>
                连接名称
                <input
                  value={c.label}
                  onChange={(e) => change(i, { label: e.target.value })}
                />
              </label>
              <label>
                厂商
                <select
                  value={c.provider}
                  onChange={(e) => change(i, { provider: e.target.value })}
                >
                  {(Array.isArray(data.providers)
                    ? (data.providers as string[])
                    : [
                        'custom',
                        'deepseek',
                        'openai',
                        'anthropic',
                        'google',
                        'openrouter',
                      ]
                  ).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                HTTPS 接口地址
                <input
                  placeholder="https://api.example.com/v1"
                  value={c.baseUrl}
                  onChange={(e) => change(i, { baseUrl: e.target.value })}
                />
              </label>
              <label>
                API Key{' '}
                {c.masked && (
                  <span className="admin-muted">已保存 {c.masked}</span>
                )}
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={c.masked ? '留空保留已有 Key' : '填写 Key'}
                  value={c.apiKey ?? ''}
                  onChange={(e) =>
                    change(i, { apiKey: e.target.value || undefined })
                  }
                />
              </label>
              <label className="admin-wide">
                模型 ID（每行一个）
                <textarea
                  value={c.models.join('\n')}
                  onChange={(e) =>
                    change(i, { models: e.target.value.split('\n') })
                  }
                />
              </label>
            </div>
            <div className="admin-inline">
              <span className="admin-muted">
                {c.verifiedAt
                  ? '目录验证通过 ' + time(c.verifiedAt)
                  : '尚未验证连接'}
              </span>
              <button
                disabled={
                  busy || !current?.connections.some((x) => x.id === c.id)
                }
                onClick={async () => {
                  const r = await verify(c.id);
                  if (r)
                    setResult(
                      r.ok
                        ? '模型目录连接验证通过（未调用付费模型）。'
                        : '目录验证未通过；部分厂商不支持目录查询。',
                    );
                }}
              >
                验证已保存连接
              </button>
              <button
                onClick={() => {
                  setConnections(connections.filter((_, n) => n !== i));
                  setAgents(
                    Object.fromEntries(
                      Object.entries(agents).filter(
                        ([, a]) => a.connectionId !== c.id,
                      ),
                    ),
                  );
                }}
              >
                移除连接
              </button>
            </div>
          </div>
        ))}
      </Card>
      <Card title="平台模型分配">
        <p className="admin-muted">
          多个 Agent
          可以共用平台连接。学习路线、理解检验、引用检查和记忆维护跟随当前聊天模型，不单独配置。未设置的项目沿用部署默认值。
        </p>
        <div className="admin-agent-grid">
          {(data.roles as string[]).map((role) => (
            <label key={role}>
              {(
                {
                  'primary-chat': '免费聊天模型',
                  'repository-analysis': '仓库分析模型',
                  'feedback-analysis': '反馈分析模型',
                  evolution: '自进化模型',
                  'component-explanation': '仓库分析 · 组件讲解',
                  'architecture-planning': '仓库分析 · 架构规划',
                  'repository-value-discovery': '仓库分析 · 价值发现',
                  'snapshot-language-overlay': '仓库分析 · 语言转换',
                } as Record<string, string>
              )[role] ?? role}
              <select
                value={
                  agents[role]
                    ? agents[role].connectionId + '|' + agents[role].model
                    : ''
                }
                onChange={(e) => {
                  if (!e.target.value) {
                    const next = { ...agents };
                    delete next[role];
                    setAgents(next);
                  } else {
                    const [connectionId, model] = e.target.value.split('|');
                    setAgents({ ...agents, [role]: { connectionId, model } });
                  }
                }}
              >
                <option value="">沿用部署默认</option>
                {connections.flatMap((c) =>
                  c.models.filter(Boolean).map((m) => (
                    <option key={c.id + '|' + m} value={c.id + '|' + m}>
                      {c.label} / {m}
                    </option>
                  )),
                )}
              </select>
            </label>
          ))}
        </div>
      </Card>
      <button
        className="admin-primary"
        disabled={busy}
        onClick={() =>
          void save({
            baseVersion: current?.version ?? 0,
            connections: connections.map((c) => ({
              ...c,
              models: c.models.map((m) => m.trim()).filter(Boolean),
            })),
            agents: Object.fromEntries(
              Object.entries(agents).filter(([role]) =>
                (data.roles as string[]).includes(role),
              ),
            ),
          })
        }
      >
        <Settings size={17} />
        保存并应用于新任务
      </button>
      <Card title="配置版本历史">
        <Table
          data={history.slice().reverse() as unknown as AdminRow[]}
          columns={[
            ['version', '版本'],
            ['createdAt', '生效时间', time],
            ['actor', '管理员'],
            ['agents', '角色配置', (v) => <Details value={v} />],
          ]}
        />
      </Card>
    </>
  );
}
function Feedback({
  data,
  busy,
  act,
}: {
  data: AdminRow;
  busy: boolean;
  act: (id: string, action: string, b: unknown) => Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState<{ id: string; action: string } | null>(
      null,
    ),
    [reason, setReason] = useState('');
  return (
    <>
      <p className="admin-description">
        从反馈到候选，再到人工审核、发布与回滚。批准会立即发布。
      </p>
      <Card title="赞踩与反馈分析">
        <Table
          data={rows(data.feedback)}
          columns={[
            ['project_id', '项目'],
            ['owner_id', '用户 / 访客', (_, row) => <UserIdentity row={row} />],
            [
              'feedback',
              '反馈',
              (v) =>
                record(v).vote === 'up'
                  ? '赞'
                  : record(v).vote === 'down'
                    ? '踩'
                    : '语言反馈',
            ],
            ['feedback', '分析', (v) => <Details value={record(v).signal} />],
            ['feedback', '时间', (v) => time(record(v).updated_at)],
          ]}
        />
      </Card>
      <Card title="候选来源请求">
        <Table
          data={rows(data.requests)}
          columns={[
            ['request_id', '反馈请求'],
            ['status', '状态'],
            ['source', '来源'],
            ['updated_at', '最近更新', time],
            ['signals', '详情', (_, r) => <Details value={r} />],
          ]}
        />
      </Card>
      <Card title="自进化任务与候选">
        {rows(data.tasks).length ? (
          rows(data.tasks).map((task) => {
            const candidate = record(task.candidate_payload);
            return (
              <article className="admin-evolution" key={text(task.task_id)}>
                <h3>
                  {text(task.skill_id)}{' '}
                  <span className="admin-chip">{text(task.status)}</span>
                </h3>
                <p className="admin-muted">任务 {text(task.task_id)}</p>
                <p>{text(candidate.changeSummary)}</p>
                <AdminDiffButton source={typeof candidate.diff === 'string' ? candidate.diff : ''}
                  title={text(task.skill_id) + ' · 修改前后差异'} />
                <Table
                  data={rows(candidate.checks)}
                  columns={[
                    ['checkId', '检查'],
                    ['passed', '结果', (v) => (v ? '通过' : '未通过')],
                    ['elapsedMs', '耗时（毫秒）'],
                  ]}
                />
                <Details
                  label="来源与候选详情"
                  value={{
                    task: task.task_payload,
                    candidate: task.candidate_payload,
                  }}
                />
                <Details
                  label="检查、评测、用量与版本历史"
                  value={{
                    ledger: task.ledger_payload,
                    review: task.review_decision_payload,
                  }}
                />
                <div className="admin-inline">
                  {task.status === 'awaiting_review' &&
                    ['approve', 'reject'].map((a) => (
                      <button
                        key={a}
                        disabled={busy}
                        className={a === 'approve' ? 'admin-primary' : ''}
                        onClick={() =>
                          setConfirm({ id: text(task.task_id), action: a })
                        }
                      >
                        {a === 'approve' ? '批准并发布' : '拒绝'}
                      </button>
                    ))}
                  {candidate.status === 'approved' && (
                    <button
                      onClick={() =>
                        setConfirm({
                          id: text(task.task_id),
                          action: 'rollback',
                        })
                      }
                    >
                      回滚到上一个版本
                    </button>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <p className="admin-empty">暂无自进化候选</p>
        )}
      </Card>
      {confirm && (
        <Card
          title={
            confirm.action === 'approve'
              ? '确认批准并发布'
              : confirm.action === 'rollback'
                ? '确认回滚'
                : '拒绝候选'
          }
        >
          <p>任务：{confirm.id}。此操作将进入现有审核与版本处理流程。</p>
          {confirm.action === 'reject' && (
            <label>
              拒绝原因
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <div className="admin-inline">
            <button
              className="admin-primary"
              disabled={busy || (confirm.action === 'reject' && !reason.trim())}
              onClick={async () => {
                if (
                  await act(confirm.id, confirm.action, {
                    confirm: true,
                    reason,
                  })
                ) {
                  setConfirm(null);
                  setReason('');
                }
              }}
            >
              确认
              {confirm.action === 'approve'
                ? '批准并发布'
                : confirm.action === 'rollback'
                  ? '回滚'
                  : '拒绝'}
            </button>
            <button onClick={() => setConfirm(null)}>取消</button>
          </div>
        </Card>
      )}
      <Card title="审核操作状态">
        <Table
          data={rows(data.commands)}
          columns={[
            ['task_id', '任务'],
            ['action', '操作'],
            ['status', '状态'],
            ['result', '结果'],
            ['created_at', '时间', time],
          ]}
        />
      </Card>
    </>
  );
}
function StoredRepositories({data,busy,act,onPage}: {data:AdminRow;busy:boolean;act:(path:string,b?:unknown,method?:string)=>Promise<AdminRow|null>;onPage:(n:number)=>void}) {
  const [plan,setPlan]=useState<AdminRow|null>(null),[planError,setPlanError]=useState(''),[loading,setLoading]=useState(false),[confirmation,setConfirmation]=useState('');
  const inspect=async(row:AdminRow)=>{
    setLoading(true);setPlanError('');setConfirmation('');setPlan(null);
    try {setPlan(await adminRequest('/repositories/delete-plan?repository='+encodeURIComponent(String(row.repository_identity))));}
    catch(e){setPlanError((e as Error).message);}finally{setLoading(false);}
  };
  return <Card title="已分析仓库与存储">
    <p className="admin-muted">每个仓库一行，包含保存的全部版本。使用人数包含分析完成后的复用者；最后使用时间按对话中记录的分析版本统计，历史缺失记录不推算。</p>
    <Table data={rows(data.storedRepositories)} columns={[
      ['repository_identity','仓库',(_,r)=><><RepositoryName row={r}/><small className="admin-muted">{text(r.versions)} 个保存版本{r.cleanup_status ? ' · 清理未完成，可重试' : ''}</small></>],
      ['users','使用者',(_,r)=><><span className="admin-user-count">共 {text(r.user_count)} 位</span><RepositoryUsers row={r} kind="storage"/></>],
      ['cos_bytes','COS 完整占用',(v,r)=><div>{r.cos_enabled ? bytes(v) : '未启用 COS'}<small className="admin-cell-note">{r.cos_enabled ? '含对象保留历史版本' : '对象保存在本机文件中'}{r.cos_enabled && !r.inventory_fresh ? ' · 统计已过期' : ''}</small></div>],
      ['host_file_bytes','服务器文件',(v)=><div>{bytes(v)}<small className="admin-cell-note">快照、安全源码及本地副本</small></div>],
      ['database_bytes','数据库与索引',(v,r)=><div>{bytes(Number(v)+Number(r.database_index_bytes))}<small className="admin-cell-note">记录 {bytes(v)} · 索引 {bytes(r.database_index_bytes)}<br/>共享数据库空间按记录数分摊估算</small></div>],
      ['last_conversation_at','最后用于对话',v=>v ? time(v) : '尚无可确认的对话记录'],
      ['repository_identity','操作',(_,r)=><button className="admin-danger-button" disabled={busy||loading} onClick={()=>void inspect(r)}>查看并清理</button>],
    ]}/>
    <Pagination value={record(data.storedPagination)} onChange={onPage} label="已分析仓库"/>
    <p className="admin-muted">COS 与服务器分别统计，共享快照不重复计数。数据库占用是估算，删除后不保证数据库文件立即缩小；不将未知用量显示为 0。</p>
    {loading && <p>正在读取清理影响…</p>}{planError && <p role="alert">{planError}</p>}
    {plan && <AdminModal title={'清理仓库 · '+text(plan.repository_identity)} close={()=>{if(!busy)setPlan(null);}}>
      <p>{text(plan.impact)}</p>
      <p>预计清理 COS 对象 {bytes(plan.cos_bytes)}、服务器文件 {bytes(plan.host_file_bytes)}。相关数据库与索引占用约 {bytes(Number(plan.database_bytes)+Number(plan.database_index_bytes))}，其中对话历史保留，不计作可回收空间。</p>
      <p>影响 {text(plan.affected_projects)} 个对话项目、{text(plan.user_count)} 位使用者和 {text(plan.versions)} 个仓库版本。</p>
      <RepositoryUsers row={plan} kind="storage"/>
      {Number(plan.active_tasks)>0 && <p role="alert">仍有分析任务执行或排队，暂不能删除。</p>}
      <p className="admin-muted">执行前会再次检查引用和运行中的任务。清理失败保留状态，可刷新后重试；对话历史不会被删除。</p>
      <label>输入仓库名确认删除<input value={confirmation} onChange={e=>setConfirmation(e.target.value)} placeholder={String(plan.repository_identity)}/></label>
      <div className="admin-inline"><button className="admin-danger-button" disabled={busy||confirmation!==plan.repository_identity||Number(plan.active_tasks)>0}
        onClick={async()=>{if(await act('/repositories/delete',{repository:plan.repository_identity,token:plan.token,confirm:confirmation}))setPlan(null);else setPlanError('清理未完成，请关闭弹窗后刷新查看状态；引用有变化时请重新确认。');}}>删除分析资料，保留对话</button>
        <button disabled={busy} onClick={()=>setPlan(null)}>取消</button></div>
      {planError && <p role="alert">{planError}</p>}
    </AdminModal>}
  </Card>;
}
function Storage({
  data,
  busy,
  act,
  onRepositoryPage,
}: {
  data: AdminRow;
  onRepositoryPage: (page:number) => void;
  busy: boolean;
  act: (path: string, b?: unknown, method?: string) => Promise<AdminRow | null>;
}) {
  const status = record(data.status),
    cos = record(status.cos);
  const [confirm, setConfirm] = useState(''),
    [policy, setPolicy] = useState<Record<string, string>>(
      storagePolicyInputs(record(status.policy)),
    );
  useEffect(
    () => setPolicy(storagePolicyInputs(record(status.policy))),
    [status.policy],
  );
  return (
    <>
      <p className="admin-description">
        全站容量管理。当前状态：
        <strong>
          {status.state === 'healthy'
            ? '正常'
            : status.state === 'warning'
              ? '容量偏低'
              : '拒收新处理'}
        </strong>
        。已为 {text(status.activeTasks)} 个排队或执行任务预留{' '}
        {bytes(status.reservedBytes)}。
      </p>
      <StoredRepositories data={data} busy={busy} act={act} onPage={onRepositoryPage} />
      <Card title="主机与数据卷">
        <Table
          data={rows(status.volumes)}
          columns={[
            ['path', '位置'],
            ['totalBytes', '总容量', bytes],
            ['availableBytes', '可用空间', bytes],
            ['known', '采集状态', (v) => (v ? '有效' : '未知')],
          ]}
        />
        <p className="admin-muted">
          不同路径可能位于同一卷，容量不相加。预留正常数据库写入与任务所需空间。
        </p>
      </Card>
      <Card
        title="对象存储"
        aside={
          <button
            disabled={busy}
            onClick={() => void act('/storage/inventory')}
          >
            刷新实际对象用量
          </button>
        }
      >
        {status.cos ? (
          <>
            <dl className="admin-amounts">
              <div>
                <dt>COS 实际对象用量</dt>
                <dd>{bytes(cos.usedBytes)}</dd>
              </div>
              <div>
                <dt>配置容量预算</dt>
                <dd>
                  {cos.capacityBytes === null
                    ? '不设限'
                    : bytes(cos.capacityBytes)}
                </dd>
              </div>
              <div>
                <dt>月费用估计</dt>
                <dd>{money(cos.projectedMonthlyUsd)}</dd>
              </div>
            </dl>
            <p className="admin-muted">
              采集 {time(cos.observedAt)}。COS 没有主机磁盘剩余百分比；删除 COS
              对象不释放主机磁盘。
            </p>
          </>
        ) : (
          <p>当前使用本地对象存储。</p>
        )}
      </Card>
      <Card title="容量回收候选">
        <p>
          仅在容量偏低时检查长期未使用且没有有效引用的快照。最终删除前会重新检查引用、任务和状态。
        </p>
        <Table
          data={rows(data.candidates)}
          columns={[
            ['repository_identity', '仓库'],
            ['location', '位置'],
            ['references', '引用数'],
            ['reclaimableBytes', '预计回收', bytes],
            ['impact', '影响'],
            [
              'public_snapshot_key',
              '操作',
              (v) => (
                <button disabled={busy} onClick={() => setConfirm(String(v))}>
                  检查并删除
                </button>
              ),
            ],
          ]}
        />
        {confirm && (
          <div className="admin-warning">
            <p>确认永久删除这份无引用快照的分析与源码载荷及 COS 保留版本？</p>
            <code>{confirm}</code>
            <div className="admin-inline">
              <button
                disabled={busy}
                onClick={async () => {
                  if (await act('/storage/' + confirm + '/delete', { confirm }))
                    setConfirm('');
                }}
              >
                确认删除
              </button>
              <button onClick={() => setConfirm('')}>取消</button>
            </div>
          </div>
        )}
      </Card>
      <Card title="全站容量策略">
        <p className="admin-muted">
          容量输入与显示使用 GB，1 GB = 1,000,000,000
          字节。费用单价保留原计费口径：1 GiB = 1.073741824 GB。
        </p>
        <div className="admin-form-grid">
          {Object.entries(policy).map(([key, value]) => (
            <label key={key}>
              {(
                {
                  reserveBytes: '数据库与系统保留空间（GB）',
                  taskBytes: '每个任务预留空间（GB）',
                  warningBytes: '容量预警阈值（GB）',
                  resumeBytes: '恢复接收阈值（GB）',
                  cosCapacityBytes: 'COS 容量预算（GB）',
                  cosMonthlyBudgetUsd: 'COS 月费用预算（USD）',
                  cosUsdPerGiBMonth: 'COS 每 GiB 月估计价格（USD）',
                } as Record<string, string>
              )[key] ?? key}
              <input
                type="number"
                min="0"
                placeholder={
                  key.startsWith('cos') ? '留空表示不设限 / 未提供单价' : ''
                }
                step="any"
                value={value}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    [key]: e.target.value,
                  })
                }
              />
            </label>
          ))}
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void act('/storage/policy', storagePolicyPayload(policy), 'PUT')
          }
        >
          保存容量策略
        </button>
      </Card>
      <Card title="访客生命周期">
        <p>
          无项目且连续 7 天未使用的访客会被删除；有项目且连续 30
          天未使用的访客先软删除，保留 7 天恢复窗口。
        </p>
        <p>
          该时间清理持续执行，不等待容量不足。用户主动删除、临时文件与安全有效期各按自己的规则执行。
        </p>
      </Card>
    </>
  );
}
