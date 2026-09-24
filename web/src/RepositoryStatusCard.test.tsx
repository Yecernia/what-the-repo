import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepositoryStatusCard } from './RepositoryStatusCard';
import { freshnessText, relativeAge } from './repository-freshness';
import type { RepositoryViewStatus } from './types';

const now = Date.parse('2026-09-24T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const base: RepositoryViewStatus = {
  snapshot_available: true,
  current: { snapshot_id: 's1', commit_sha: 'a'.repeat(40), published_at: ago(90), generation: 1 },
  view: { snapshot_id: 's1', commit_sha: 'a'.repeat(40), published_at: ago(90), expires_at: null },
  refresh_required: false,
  view_expired: false,
  freshness: { base_snapshot_id: 's1', upstream_commit_sha: 'b'.repeat(40), behind_commits: 12,
    relation: 'ahead', check_status: 'ok', checked_at: ago(5), stale: false, error_code: null, next_check_at: null },
  update: null,
  update_eligibility: { allowed: true, reason: null, retry_after: null },
  migration: { status: 'not_needed', changed_items: 0 },
};

describe('relativeAge', () => {
  it('uses one largest unit rounded down with fixed week, month and year lengths', () => {
    expect(relativeAge(ago(0.5), now)).toBe('刚刚');
    expect(relativeAge(ago(5), now)).toBe('5分钟前');
    expect(relativeAge(ago(59), now)).toBe('59分钟前');
    expect(relativeAge(ago(60), now)).toBe('1小时前');
    expect(relativeAge(ago(3 * 1440), now)).toBe('3天前');
    expect(relativeAge(ago(14 * 1440), now)).toBe('2周前');
    expect(relativeAge(ago(30 * 1440), now)).toBe('1个月前');
    expect(relativeAge(ago(729 * 1440), now)).toBe('1年前');
    expect(relativeAge(ago(730 * 1440), now)).toBe('2年前');
  });

  it('clamps future times and reports missing ones', () => {
    expect(relativeAge(ago(-10), now)).toBe('刚刚');
    expect(relativeAge(null, now)).toBe('更新时间未知');
    expect(relativeAge('not a date', now)).toBe('更新时间未知');
  });
});

describe('freshnessText', () => {
  it('never shows zero when the comparison is unknown or failed', () => {
    expect(freshnessText(base)).toBe('落后最新代码 12 个提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, stale: true } })).toBe('上次检查落后 12 个提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'same', behind_commits: 0 } }))
      .toBe('与上次检查的最新代码一致');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'unknown', behind_commits: null } }))
      .toBe('尚未确认最新代码');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'unknown', behind_commits: null, check_status: 'checking' } }))
      .toBe('正在检查最新代码…');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, check_status: 'failed' } }))
      .toBe('暂时无法检查最新代码');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'rewound', behind_commits: null } }))
      .toBe('上游历史已变化');
  });
});

describe('RepositoryStatusCard', () => {
  const noop = () => undefined;

  it('offers joining a running update and disables the button for participants', () => {
    const update = { update_id: 'u1', status: 'running' as const, target_commit_sha: null, trigger: 'background' as const,
      stage: null, participation: 'none' as const, error_code: null, retryable: false };
    const { rerender } = render(<RepositoryStatusCard status={{ ...base, update }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '加入更新' })).toBeEnabled();
    rerender(<RepositoryStatusCard status={{ ...base, update: { ...update, participation: 'running' } }}
      refreshPending={false} updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '已加入更新' })).toBeDisabled();
  });

  it('shows the refresh action instead of the old page age after a newer version is published', () => {
    render(<RepositoryStatusCard status={{ ...base, refresh_required: true }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '刷新到新版本' })).toBeEnabled();
    expect(screen.queryByText(/更新于/)).toBeNull();
  });

  it('explains a cooldown with the time another update may start', () => {
    render(<RepositoryStatusCard status={{ ...base, update_eligibility: { allowed: false, reason: 'cooldown',
      retry_after: new Date(now + 30 * 60_000).toISOString() } }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled();
    expect(screen.getByText(/后可以再次更新/)).toBeVisible();
  });
});
