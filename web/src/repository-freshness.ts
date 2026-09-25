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
  if (freshness.check_status === 'failed') return t('暂时无法检查仓库有没有新提交');
  if (freshness.relation === 'diverged' || freshness.relation === 'rewound') return t('仓库的提交历史被改写过');
  if (freshness.relation === 'same' && freshness.behind_commits === 0) return freshness.stale ? t('上次检查时已是最新版本') : t('已是最新版本');
  if (freshness.relation === 'ahead' && freshness.behind_commits !== null) {
    return freshness.stale
      ? t('上次检查时仓库有 {0} 个新提交', freshness.behind_commits)
      : t('仓库有 {0} 个新提交', freshness.behind_commits);
  }
  return freshness.check_status === 'checking' ? t('正在检查仓库有没有新提交…') : t('还没检查仓库有没有新提交');
}
