import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AdminServiceMonitoring } from './AdminServiceMonitoring';
import { groupServiceReports, reportAge, reportMetrics } from './admin-monitoring';
const now = '2026-01-01T12:00:00Z';
const report = (id: string, fresh: boolean, role = 'analysis-worker') => ({
  instance_id: id, role, fresh, observed_at: fresh ? '2026-01-01T11:59:55Z' : '2026-01-01T08:00:00Z',
  payload: { gauges: [{ name: 'what_the_repo_analysis_runs_active', value: 1 }] },
});
afterEach(cleanup);
it('groups instances without mutating input and keeps all current replicas', () => {
  const input = [report('old', false), report('current-b', true), report('current-a', true), report('api', true, 'api')];
  const before = JSON.stringify(input), groups = groupServiceReports(input);
  expect(groups.map(g => g.role)).toEqual(['api', 'analysis-worker']);
  expect(groups[1].recent.map(r => r.instance_id)).toEqual(['current-a', 'current-b']);
  expect(groups[1].stale).toHaveLength(1);
  expect(JSON.stringify(input)).toBe(before);
});
it('a stale historical record does not declare a reporting service down', () => {
  render(<AdminServiceMonitoring observations={[report('old', false), report('current', true)]} observedAt={now} />);
  expect(screen.getByText('仓库分析服务')).toBeTruthy();
  expect(screen.getByText('1 个近期上报实例 · 1 条旧记录待核实')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText(/此处未配置预期副本数/)).toBeTruthy();
});
it('warns when no recorded instance reports recently, without claiming a crash', () => {
  render(<AdminServiceMonitoring observations={[report('old', false)]} observedAt={now} />);
  expect(screen.getByRole('status').textContent).toContain('所有已记录实例均超过 45 秒未上报');
});
it('opens and paginates the old instances separately, preserving their raw reports', () => {
  render(<AdminServiceMonitoring observations={[report('current', true), ...Array.from({ length: 7 }, (_, i) => report('old-' + i, false))]} observedAt={now} />);
  fireEvent.click(screen.getByRole('button', { name: '查看仓库分析服务实例' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('current')).toBeTruthy();
  const summary = within(dialog).getByText('未再上报的旧实例 · 7 条待核实记录');
  expect(summary.closest('details')?.open).toBe(false);
  fireEvent.click(summary);
  expect(within(dialog).getByText('old-0')).toBeTruthy();
  const pagination = within(dialog).getByRole('navigation', { name: '实例报告分页' });
  fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }));
  expect(within(dialog).getByText('old-6')).toBeTruthy();
  expect(within(dialog).queryByText('old-0')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('shows an explicit unknown state when nothing was collected', () => {
  render(<AdminServiceMonitoring observations={[]} observedAt={now} />);
  expect(screen.getByText('尚未收到服务报告，无法判断运行情况。')).toBeTruthy();
  expect(screen.queryByText('正常')).toBeNull();
});
it('ages are relative to the server response, with invalid and future times explicit', () => {
  expect(reportAge('2026-01-01T11:59:55Z', now)).toBe('5 秒前');
  expect(reportAge('invalid', now)).toBe('时间待核实');
  expect(reportAge('2026-01-02T00:00:00Z', now)).toBe('时间待核实');
});
it('never turns missing or invalid metrics into healthy zeros', () => {
  expect(reportMetrics({})).toEqual([]);
  expect(reportMetrics({ gauges: [{ name: 'what_the_repo_provider_calls_active', value: NaN }] })).toEqual([]);
});
