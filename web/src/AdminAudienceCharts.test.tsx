import { afterEach, expect, it } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import {
  AdminAudienceCharts,
  hourlyAudience,
  sampleSegments,
  type AudienceSample,
} from './AdminAudienceCharts';
import {
  storagePolicyInputs,
  storagePolicyPayload,
  formatGB,
} from './admin-storage-units';
afterEach(cleanup);
const point = (minute: number, github = 1, guest = 2): AudienceSample => ({
  observed_at: new Date(Date.UTC(2026, 8, 13, 10, minute)).toISOString(),
  github: 4,
  guest: 5,
  online_github: github,
  online_guest: guest,
});
it('capacity GB inputs preserve exact byte policies, zero and unlimited distinctly', () => {
  const policy = {
    reserveBytes: 2 * 1024 ** 3,
    taskBytes: 1024 ** 3,
    cosCapacityBytes: null,
    cosMonthlyBudgetUsd: 0,
    cosUsdPerGiBMonth: 0.02,
  };
  expect(storagePolicyPayload(storagePolicyInputs(policy))).toEqual(policy);
  expect(
    storagePolicyPayload({ cosCapacityBytes: '0', taskBytes: '1.5' }),
  ).toEqual({ cosCapacityBytes: 0, taskBytes: 1_500_000_000 });
  expect(formatGB(null)).toBe('未知');
  expect(formatGB(1)).toBe('< 0.001 GB');
});
it('hourly average and peak use only observed minutes; missing minutes stay gaps', () => {
  const data = [point(1, 2, 4), point(2, 0, 2), point(5, 1, 2)];
  expect(sampleSegments(data).map((x) => x.length)).toEqual([2, 1]);
  const hourly = hourlyAudience(data);
  expect(hourly).toHaveLength(1);
  expect(hourly[0].sampleCount).toBe(3);
  expect(hourly[0].online_github).toBe(11 / 3);
  expect(hourly[0].online_guest).toBe(6);
});
it('defaults to hourly chart, supports minute selection and labels stale or missing history', () => {
  render(
    <AdminAudienceCharts
      audience={{ github: 4, guest: 5 }}
      history={[point(1), point(2)]}
      observedAt={point(8).observed_at}
    />,
  );
  expect(
    screen
      .getByRole('button', { name: '近 24 小时' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByText('采集已过期，以下保留最后有效记录。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '近 1 小时' }));
  expect(screen.getByRole('slider')).toBeTruthy();
  cleanup();
  render(
    <AdminAudienceCharts
      audience={{}}
      history={[]}
      observedAt={point(8).observed_at}
    />,
  );
  expect(screen.queryByRole('img', { name: /在线人数趋势/ })).toBeNull();
  expect(screen.getByText('暂无历史采样，接入采集后开始绘制。')).toBeTruthy();
});
it('hourly trends leave missing hours disconnected and do not label completed hours as unfinished', () => {
  const data = [point(1, 0, 0), point(2, 0, 0), point(121, 2, 3), point(122, 1, 2)];
  expect(sampleSegments(hourlyAudience(data), 3_600_000).map(s => s.length)).toEqual([1, 1]);
  const { container } = render(<AdminAudienceCharts audience={{ github: 4, guest: 5 }} history={data} observedAt={point(125).observed_at} />);
  expect(container.querySelectorAll('svg rect')).toHaveLength(0);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(screen.queryByText(/当前小时尚未结束/)).toBeNull();
  expect(screen.getByText(/该小时已采集/).textContent).toContain('2 / 60');
});
