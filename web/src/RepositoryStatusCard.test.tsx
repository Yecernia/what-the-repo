import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(freshnessText(base)).toBe('仓库有 12 个新提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, stale: true } })).toBe('上次检查时仓库有 12 个新提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'same', behind_commits: 0 } }))
      .toBe('已是最新版本');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'same', behind_commits: 0, stale: true } }))
      .toBe('上次检查时已是最新版本');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'unknown', behind_commits: null } }))
      .toBe('还没检查仓库有没有新提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'unknown', behind_commits: null, check_status: 'checking' } }))
      .toBe('正在检查仓库有没有新提交…');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, check_status: 'failed' } }))
      .toBe('暂时无法检查仓库有没有新提交');
    expect(freshnessText({ ...base, freshness: { ...base.freshness, relation: 'rewound', behind_commits: null } }))
      .toBe('仓库的提交历史被改写过');
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

  it('shows the switch action after a newer version is published', () => {
    render(<RepositoryStatusCard status={{ ...base, refresh_required: true }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '切换到新版本' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '更新代码' })).toBeNull();
  });

  it('offers no update when a fresh check found no new commits', () => {
    const same = { ...base.freshness, relation: 'same' as const, behind_commits: 0 };
    const { rerender } = render(<RepositoryStatusCard status={{ ...base, freshness: same }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByText('已是最新版本')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<RepositoryStatusCard status={{ ...base, freshness: { ...same, stale: true } }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '更新代码' })).toBeEnabled();
  });

  it('shows the upstream commit time only when the check has read it', () => {
    const { rerender } = render(<RepositoryStatusCard status={{ ...base, freshness: { ...base.freshness,
      upstream_committed_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByLabelText('最新提交于 3小时前')).toHaveTextContent('3小时前');
    rerender(<RepositoryStatusCard status={{ ...base, freshness: { ...base.freshness, upstream_committed_at: null } }}
      refreshPending={false} updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.queryByLabelText(/最新提交于/)).toBeNull();
    expect(screen.getByText('仓库有 12 个新提交')).toBeVisible();
  });

  it('tells a user over their hourly limit when another update may start', () => {
    render(<RepositoryStatusCard status={{ ...base, update_eligibility: { allowed: false, reason: 'rate_limited',
      retry_after: new Date(now + 30 * 60_000).toISOString() } }} refreshPending={false}
      updatePending={false} notice={null} onRefresh={noop} onUpdate={noop} />);
    expect(screen.getByRole('button', { name: '更新代码' })).toBeDisabled();
    expect(screen.getByText(/后可以再次更新/)).toBeVisible();
  });

  it('lists learned steps whose code changed and sends the learner decision', () => {
    const decisions: string[] = [];
    render(<RepositoryStatusCard status={{ ...base, migration: { status: 'needs_review', changed_items: 1, migration_id: 'm1',
      items: [{ step_id: 'step-1', title: '路由分发', reason: 'changed', paths: ['src/router.ts'], previously: 'completed' }],
      marked_steps: 2 } }} refreshPending={false} updatePending={false} notice={null} onRefresh={noop} onUpdate={noop}
      onResolveReview={(stepId, action) => decisions.push(`${stepId}:${action}`)} />);
    expect(screen.getByText('路由分发')).toBeVisible();
    expect(screen.getByText('路由分发').closest('li')).toHaveTextContent('相关代码已变化');
    expect(screen.getByText(/2 个未学的步骤/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重学' }));
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(decisions).toEqual(['step-1:relearn', 'step-1:skip']);
  });
});
