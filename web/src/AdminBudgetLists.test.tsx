import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BackgroundScheduling, RepositoryUpdateUsage, UsageAttribution } from './AdminBudgetLists';

afterEach(cleanup);

const rules = { intervalMinutes: 5, commitThreshold: 20, maxSnapshotAgeDays: 7,
  minUpdateIntervalHours: 24, activeWindowDays: 7, maxStartsPerDay: 2 };
const bodyRows = () => screen.getAllByRole('row').slice(1);

it('usage attribution groups calls by business and filters or pages the task list', () => {
  const usage = Array.from({ length: 25 }, (_, index) => ({
    business: index < 22 ? 'chat' : 'analysis', payer: 'platform',
    agent_role: index < 22 ? 'primary-chat' : 'repository-analysis', task_id: 'task-' + index,
    connection_id: 'deepseek', config_version: 3, calls: 2, used: index / 100, reserved: 0, unknown_calls: 0,
  }));
  render(<UsageAttribution data={usage} />);
  // Summary: one row per business, payer and agent instead of one per task.
  expect(bodyRows()).toHaveLength(2);
  expect(screen.getByText('50 次调用 · 已知费用 $3.0000')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '按任务明细' }));
  expect(bodyRows()).toHaveLength(20);
  expect(screen.getByText(/共 25 个 · 每页 20 个 · 第 1 \/ 2 页/)).toBeTruthy();
  expect(within(bodyRows()[0]!).getByText('task-24')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('业务'), { target: { value: 'analysis' } });
  expect(bodyRows()).toHaveLength(3);
  expect(screen.queryByText(/每页 20 个/)).toBeNull();
});

it('repository update usage summarises per repository and keeps per-update details', () => {
  const updates = [
    { update_id: 'u1', repository_identity: 'a/one', trigger: 'background', status: 'succeeded', created_at: '2026-09-24T01:00:00Z', used: 1, reserved: 0, remaining: 2, unknown_calls: 0 },
    { update_id: 'u2', repository_identity: 'a/one', trigger: 'manual', status: 'failed', created_at: '2026-09-24T02:00:00Z', used: 0.5, reserved: 0, remaining: 2.5, unknown_calls: 0 },
    { update_id: 'u3', repository_identity: 'b/two', trigger: 'manual', status: 'succeeded', created_at: '2026-09-23T02:00:00Z', used: 0.25, reserved: 0, remaining: 2.75, unknown_calls: 0 },
  ];
  render(<RepositoryUpdateUsage data={updates} capped />);
  expect(bodyRows().map((row) => within(row).getAllByRole('cell').slice(0, 5).map((cell) => cell.textContent)))
    .toEqual([['a/one', '2', '1', '1', '1'], ['b/two', '1', '0', '1', '0']]);
  fireEvent.change(screen.getByLabelText('触发'), { target: { value: 'background' } });
  expect(bodyRows()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '逐次明细' }));
  expect(within(bodyRows()[0]!).getByText('后台')).toBeTruthy();
  expect(within(bodyRows()[0]!).getByText('成功')).toBeTruthy();
});

it('background scheduling explains why each repository did or did not start', () => {
  const run = (decisions: Array<Record<string, unknown>>, queued = 0) => ({
    run_id: 'r' + decisions.length + queued, started_at: '2026-09-24T13:05:00Z', error: null,
    outcome: { examined: decisions.length, checked: decisions.length, queued, deferred: 0, failedChecks: 0, decisions },
  });
  render(<BackgroundScheduling data={{ ...rules, enabled: true, runs: [
    run([{ repository: 'ai/nanoid', decision: 'same', relation: 'same', behindCommits: 0 },
      { repository: 'vitejs/vite', decision: 'below_threshold', relation: 'ahead', behindCommits: 3 }]),
    run([{ repository: 'vitejs/vite', decision: 'queued', relation: 'ahead', behindCommits: 40 }], 1),
  ] }} />);
  expect(screen.getByText('已开启')).toBeTruthy();
  expect(screen.getByText('与上游一致，无需更新')).toBeTruthy();
  expect(screen.getByText('上游新增 3 个提交')).toBeTruthy();
  expect(screen.getByText('新提交不足 20 个，当前版本不满 7 天，也没有新 release')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('只看'), { target: { value: 'queued' } });
  expect(screen.getByText('1 个已启动后台更新')).toBeTruthy();
});

it('background scheduling says plainly when it is switched off', () => {
  render(<BackgroundScheduling data={{ ...rules, enabled: false, runs: [] }} />);
  expect(screen.getByText('未开启')).toBeTruthy();
  expect(screen.getByText(/后台更新未开启/)).toBeTruthy();
});

it('an idle pass says no repository was due instead of showing an empty table', () => {
  render(<BackgroundScheduling data={{ ...rules, enabled: true, runs: [{ run_id: 'idle', started_at: '2026-09-24T13:40:07Z',
    error: null, outcome: { examined: 0, checked: 0, queued: 0, deferred: 0, failedChecks: 0, decisions: [] } }] }} />);
  expect(screen.getAllByText('没有到检查时间的仓库（只检查最近 7 天有人用过的仓库）').length).toBeGreaterThan(0);
});
