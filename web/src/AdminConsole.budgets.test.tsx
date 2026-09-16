import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import AdminConsole from './AdminConsole';
import { adminRequest, type AdminRow } from './admin-api';

vi.mock('./admin-api', () => ({ adminRequest: vi.fn() }));
vi.mock('./AdminAudienceCharts', () => ({ AdminAudienceCharts: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function overviewRow(budget: AdminRow, name: string) {
  vi.mocked(adminRequest)
    .mockResolvedValueOnce({ enabled: true, authenticated: true })
    .mockResolvedValueOnce({
      observedAt: '2026-09-14T10:00:00Z', health: { database: true },
      online: { github: 0, guest: 0 }, jobs: { running: 0, queued: 0, failed: 0 },
      metrics: { gauges: [] }, observations: [], budgets: [budget], tuning: {},
    });
  render(<AdminConsole />);
  const business = await screen.findByText(name, { exact: true });
  const row = business.closest('tr');
  if (!row) throw new Error('Budget row not rendered');
  return within(row);
}

it('overview explains per-task accounting instead of marking it unknown or zero', async () => {
  const row = await overviewRow({ key: 'evolution_task', limit: 1.5, used: null, reserved: null, remaining: null }, '自进化单任务');
  expect(row.getByText('$1.5000 / 任务')).toBeTruthy();
  expect(row.getAllByText('按任务查看')).toHaveLength(3);
  expect(row.queryByText('未知')).toBeNull();
});

it('unlimited task budget keeps an explicit unlimited remainder', async () => {
  const row = await overviewRow({ key: 'evolution_task', limit: null, used: null, reserved: null, remaining: null }, '自进化单任务');
  expect(row.getAllByText('按任务查看')).toHaveLength(2);
  expect(row.getAllByText('不设限')).toHaveLength(2);
});
it('zero task limit is not treated as missing or unlimited', async () => {
  const row = await overviewRow({ key: 'evolution_task', limit: 0, used: null, reserved: null, remaining: null }, '自进化单任务');
  expect(row.getByText('$0.0000 / 任务')).toBeTruthy();
  expect(row.getAllByText('按任务查看')).toHaveLength(3);
});
it('daily budgets still show their actual used, reserved and remaining amounts', async () => {
  const row = await overviewRow({ key: 'analysis_daily', limit: 10, used: 2, reserved: 1, remaining: 7 }, '平台每日仓库分析');
  expect(row.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['平台每日仓库分析', '$10.0000', '$2.0000', '$1.0000', '$7.0000']);
});
it('genuinely missing daily usage remains unknown', async () => {
  const row = await overviewRow({ key: 'chat_daily', limit: 5, used: null, reserved: undefined, remaining: null }, '平台每日免费聊天');
  expect(row.getAllByText('未知')).toHaveLength(3);
  expect(row.queryByText('按任务查看')).toBeNull();
});
