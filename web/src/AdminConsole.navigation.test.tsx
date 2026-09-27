import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AdminConsole from './AdminConsole';
import { adminRequest, AdminRequestError, type AdminRow } from './admin-api';

vi.mock('./admin-api', async (original) => ({ ...await original<typeof import('./admin-api')>(), adminRequest: vi.fn() }));
vi.mock('./AdminAudienceCharts', () => ({ AdminAudienceCharts: () => null }));

const storagePath = '/storage?repository_page=1';
const storage: AdminRow = {
  storedRepositories: [], storedPagination: { page: 1, pages: 1, total: 0 },
};
const capacity: AdminRow = {
  status: { state: 'healthy', policy: {}, volumes: [] }, candidates: [],
};
const overview: AdminRow = {
  health: { database: true }, online: {}, jobs: {},
  metrics: { gauges: [] }, observations: [], budgets: [], tuning: {},
};
const queued = new Map<string, Array<Promise<AdminRow> | AdminRow>>();
function respond(path: string, result: Promise<AdminRow> | AdminRow) {
  queued.set(path, [...(queued.get(path) ?? []), result]);
}
function calls(path: string) {
  return vi.mocked(adminRequest).mock.calls.filter(([requested]) => requested === path).length;
}
function deferred() {
  let resolve!: (data: AdminRow) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AdminRow>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function openConsole() {
  vi.mocked(adminRequest).mockImplementation(async (path) => {
    const item = queued.get(path)?.shift();
    if (item) return item;
    if (path === '/auth/status') return { enabled: true, authenticated: true };
    if (path === '/overview') return overview;
    if (path === storagePath) return storage;
    if (path === '/storage/capacity') return capacity;
    if (path === '/audit') return { entries: [] };
    if (path === '/config') return { roles: [], versions: [] };
    return {};
  });
  render(<AdminConsole />);
  await screen.findByText('预算与错误');
}
afterEach(() => { cleanup(); queued.clear(); vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

it.each(['loaded', 'pending'])('keeps the %s storage read when reselecting its tab', async (state) => {
  await openConsole();
  const request = deferred();
  respond(storagePath, request.promise);
  const tab = screen.getByRole('button', { name: /存储管理/ });
  fireEvent.click(tab);
  if (state === 'loaded') await act(async () => request.resolve(storage));
  const before = calls(storagePath);
  fireEvent.click(tab);
  if (state === 'pending') await act(async () => request.resolve(storage));
  expect(screen.getByText('已分析仓库与存储')).toBeTruthy();
  expect(screen.queryByText('正在读取…')).toBeNull();
  expect(calls(storagePath)).toBe(before);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^刷新$/ })));
  expect(calls(storagePath)).toBe(before + 1);
});

it('shows stored repositories while capacity is still loading', async () => {
  await openConsole();
  const request = deferred();
  respond('/storage/capacity', request.promise);
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  expect(await screen.findByText('已分析仓库与存储')).toBeTruthy();
  expect(screen.getByText('正在读取容量状态…')).toBeTruthy();
  await act(async () => request.resolve(capacity));
  expect(screen.getByText('主机与数据卷')).toBeTruthy();
});

it('shares slow reads across polls and refresh, then schedules the next poll after completion', async () => {
  await openConsole();
  vi.useFakeTimers();
  const request = deferred();
  respond('/audit', request.promise);
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  expect(calls('/audit')).toBe(1);
  await act(async () => request.resolve({ entries: [] }));
  expect(screen.getByText('最近的管理操作')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
  expect(calls('/audit')).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(calls('/audit')).toBe(2);
});

it('ignores a departed page response and allows retry after failure', async () => {
  await openConsole();
  const old = deferred(), current = deferred();
  respond(storagePath, old.promise);
  respond('/audit', current.promise);
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await act(async () => old.resolve(storage));
  fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  expect(calls('/audit')).toBe(1);
  expect(screen.queryByText('已分析仓库与存储')).toBeNull();
  await act(async () => current.reject(new Error('temporary failure')));
  expect(screen.getByRole('alert')).toHaveTextContent('temporary failure');
  respond('/audit', { entries: [] });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^刷新$/ })));
  expect(screen.getByText('最近的管理操作')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([false, true])('refreshes the visible page after a mutation (navigate: %s)', async (navigate) => {
  await openConsole();
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  await screen.findByText('主机与数据卷');
  const old = deferred(), mutation = deferred();
  respond(storagePath, old.promise);
  fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  respond('/storage/inventory', mutation.promise);
  fireEvent.click(screen.getByRole('button', { name: '刷新实际对象用量' }));
  if (navigate) {
    fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
    await screen.findByText('最近的管理操作');
    respond('/audit', { entries: [{ action: 'fresh audit' }] });
  } else respond(storagePath, {
    ...storage, storedRepositories: [{ repository_identity: 'fresh/repo' }],
  });
  await act(async () => mutation.resolve({}));
  expect(screen.getByText(navigate ? 'fresh audit' : 'fresh/repo')).toBeTruthy();
  await act(async () => old.resolve(storage));
  expect(screen.getByText(navigate ? 'fresh audit' : 'fresh/repo')).toBeTruthy();
});

it('restores a visited page immediately without a fresh request', async () => {
  await openConsole();
  respond('/audit', { entries: [{ action: 'cached audit' }] });
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await screen.findByText('cached audit');
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  await screen.findByText('已分析仓库与存储');
  const before = calls('/audit');
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  expect(screen.getByText('cached audit')).toBeTruthy();
  expect(calls('/audit')).toBe(before);
});

it('backs off failed polls, retains data and session, and resets the delay on recovery', async () => {
  await openConsole();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await act(async () => {});
  const failed = deferred();
  respond('/audit', failed.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); failed.reject(new Error('network unavailable')); });
  expect(screen.getByText('最近的管理操作')).toBeTruthy();
  expect(screen.getByRole('alert')).toHaveTextContent('保留上次读取结果');
  expect(calls('/auth/status')).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
  expect(calls('/audit')).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(calls('/audit')).toBe(3);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(calls('/audit')).toBe(4);
});

it('pauses hidden pages and immediately refreshes stale data on return', async () => {
  await openConsole();
  vi.useFakeTimers();
  const visible = vi.spyOn(document, 'visibilityState', 'get');
  visible.mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(calls('/audit')).toBe(0);
  visible.mockReturnValue('visible');
  await act(async () => fireEvent(document, new Event('visibilitychange')));
  expect(calls('/audit')).toBe(1);
  expect(screen.getByText('最近的管理操作')).toBeTruthy();
});

it.each([401, 403])('clears cached pages and drafts on HTTP %s, then starts a fresh session', async (status) => {
  await openConsole();
  respond('/config', { roles: [], versions: [] });
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  await screen.findByText('添加连接');
  fireEvent.click(screen.getByText('添加连接'));
  fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'private draft' } });
  const failed = deferred();
  respond('/config', failed.promise);
  fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  await act(async () => failed.reject(new AdminRequestError('session expired', status)));
  expect(screen.getByText('管理员登录')).toBeTruthy();
  expect(screen.queryByDisplayValue('private draft')).toBeNull();
  respond('/config', { roles: [], versions: [] });
  await act(async () => fireEvent.click(screen.getByText('重新连接管理服务')));
  expect(screen.getByText('当前沿用部署配置。添加连接后可为 Agent 分配模型。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /总览/ }));
  await screen.findByText('预算与错误');
  expect(calls('/overview')).toBe(2);
});

it('preserves connection drafts and their base version across refresh and navigation', async () => {
  await openConsole();
  respond('/config', { roles: [], versions: [{ version: 1, connections: [], agents: {} }] });
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  await screen.findByText('添加连接');
  fireEvent.click(screen.getByText('添加连接'));
  fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'my draft' } });
  respond('/config', { roles: [], versions: [{ version: 2, connections: [], agents: {} }] });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^刷新$/ })));
  expect(screen.getByLabelText('连接名称')).toHaveValue('my draft');
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await screen.findByText('最近的管理操作');
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  expect(screen.getByLabelText('连接名称')).toHaveValue('my draft');
  await act(async () => fireEvent.click(screen.getByText('保存并应用于新任务')));
  const write = vi.mocked(adminRequest).mock.calls.find(([path, method]) => path === '/config' && method === 'PUT');
  expect(write?.[2]).toMatchObject({ baseVersion: 1 });
});

it('invalidates related resources after a write while preserving unrelated cached pages', async () => {
  await openConsole();
  respond('/config', { roles: [], versions: [] });
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  await screen.findByText('添加连接');
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  await screen.findByText('刷新实际对象用量');
  await act(async () => fireEvent.click(screen.getByText('刷新实际对象用量')));
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  expect(calls('/config')).toBe(1);
  expect(screen.getByText('添加连接')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /总览/ }));
  await act(async () => {});
  expect(calls('/overview')).toBe(2);
});

it('loads candidates only on demand and exposes server stale snapshots', async () => {
  await openConsole();
  respond('/storage/capacity', { ...capacity, readState: { observedAt: '2026-09-20T00:00:00Z', stale: true, refreshFailed: true } });
  fireEvent.click(screen.getByRole('button', { name: /存储管理/ }));
  await screen.findByText('主机与数据卷');
  expect(screen.getByText(/容量数据更新于/)).toHaveTextContent('后台刷新失败');
  expect(calls('/storage/candidates')).toBe(0);
  const request = deferred();
  respond('/storage/candidates', request.promise);
  fireEvent.click(screen.getByRole('button', { name: '检查回收候选' }));
  expect(screen.getByText('正在检查回收候选…')).toBeTruthy();
  expect(screen.getByText('主机与数据卷')).toBeTruthy();
  await act(async () => request.reject(new Error('candidate scan busy')));
  expect(screen.getByRole('alert')).toHaveTextContent('candidate scan busy');
});

it.each(['budget', 'storage'])('preserves the %s draft through refreshed server values and navigation', async (kind) => {
  await openConsole();
  const budget = { policies: { analysis_daily: 10 }, budgets: [{ key: 'analysis_daily', limit: 10 }] };
  const capacityWithPolicy = { ...capacity, status: { ...capacity.status as object, policy: { taskBytes: 1_000_000_000 } } };
  const path = kind === 'budget' ? '/budgets' : '/storage/capacity';
  const payload = kind === 'budget' ? budget : capacityWithPolicy;
  const nav = kind === 'budget' ? /预算/ : /存储管理/;
  const input = kind === 'budget' ? '预算金额（USD）' : '每个任务预留空间（GB）';
  respond(path, payload);
  fireEvent.click(screen.getByRole('button', { name: nav }));
  await screen.findByLabelText(input);
  fireEvent.change(screen.getByLabelText(input), { target: { value: '42' } });
  respond(path, payload);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^刷新$/ })));
  expect(screen.getByLabelText(input)).toHaveValue(42);
  fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
  await screen.findByText('最近的管理操作');
  fireEvent.click(screen.getByRole('button', { name: nav }));
  expect(screen.getByLabelText(input)).toHaveValue(42);
  fireEvent.click(screen.getByText(kind === 'budget' ? '放弃预算草稿' : '放弃容量策略草稿'));
  expect(screen.getByLabelText(input)).toHaveValue(kind === 'budget' ? 10 : 1);
});

it('retries server refresh failures on normally non-polling pages with increasing delays', async () => {
  await openConsole();
  vi.useFakeTimers();
  const stale = { roles: [], versions: [], readState: { stale: true, refreshFailed: true, refreshing: false } };
  respond('/config', stale);
  respond('/config', stale);
  fireEvent.click(screen.getByRole('button', { name: /Agent 与厂商/ }));
  await act(async () => {});
  expect(screen.getByText(/后台刷新失败/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(calls('/config')).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(calls('/config')).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(calls('/config')).toBe(3);
  expect(screen.queryByText(/后台刷新失败/)).toBeNull();
});
