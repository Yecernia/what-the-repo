import { t } from './ui-language';
import type { RepositoryViewStatus } from './types';

/** One largest unit, rounded down; fixed year/month/week lengths (365/30/7 days). */
export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(time)) return t('更新时间未知');
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return t('刚刚');
  const units: Array<[number, string]> = [
    [365 * 24 * 60, '{0}年前'], [30 * 24 * 60, '{0}个月前'], [7 * 24 * 60, '{0}周前'],
    [24 * 60, '{0}天前'], [60, '{0}小时前'], [1, '{0}分钟前'],
  ];
  const [size, label] = units.find(([unitMinutes]) => minutes >= unitMinutes)!;
  return t(label, Math.floor(minutes / size));
}

/** Freshness is relative to the repository's current version, never guessed. */
export function freshnessText(status: RepositoryViewStatus): string {
  const freshness = status.freshness;
  if (freshness.check_status === 'failed') return t('暂时无法检查最新代码');
  if (freshness.relation === 'diverged' || freshness.relation === 'rewound') return t('上游历史已变化');
  if (freshness.relation === 'same' && freshness.behind_commits === 0) return t('与上次检查的最新代码一致');
  if (freshness.relation === 'ahead' && freshness.behind_commits !== null) {
    return freshness.stale
      ? t('上次检查落后 {0} 个提交', freshness.behind_commits)
      : t('落后最新代码 {0} 个提交', freshness.behind_commits);
  }
  return freshness.check_status === 'checking' ? t('正在检查最新代码…') : t('尚未确认最新代码');
}
