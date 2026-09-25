import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AdminConsole from './AdminConsole';
import { adminRequest, type AdminRow } from './admin-api';

vi.mock('./admin-api', () => ({ adminRequest: vi.fn() }));
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
    return {};
  });
  render(<AdminConsole />);
  await screen.findByText('预算与错误');
}
afterEach(() => { cleanup(); queued.clear(); vi.useRealTimers(); vi.resetAllMocks(); });

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
