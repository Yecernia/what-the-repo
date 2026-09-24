import RefreshCw from '@sketchyicons/react/icons/refresh-cw';
import { t } from './ui-language';
import type { RepositoryViewStatus } from './types';
import { freshnessText, relativeAge } from './repository-freshness';

export type RepositoryUpdateNotice = { kind: 'up_to_date' | 'joined' | 'queued' | 'deferred'; retryAfter: string | null } | null;

export function RepositoryStatusCard({ status, refreshPending, updatePending, notice, onRefresh, onUpdate }: {
  status: RepositoryViewStatus;
  refreshPending: boolean;
  updatePending: boolean;
  notice: RepositoryUpdateNotice;
  onRefresh: () => void;
  onUpdate: () => void;
}) {
  const update = status.update;
  const active = Boolean(update && (update.status === 'queued' || update.status === 'running'));
  // After a failure the participant may retry like anyone else.
  const participating = active && update!.participation !== 'none';
  const heading = status.view_expired ? t('当前页面版本已过期')
    : status.refresh_required ? t('仓库已更新，点击刷新')
    : freshnessText(status);
  // An old page shows no age: the current version's time would be misleading.
  const age = !status.refresh_required && !status.view_expired && status.view?.published_at
    ? t('更新于 {0}', relativeAge(status.view.published_at)) : null;
  const retryAfter = notice?.kind === 'deferred' ? notice.retryAfter : status.update_eligibility.retry_after;
  return (
    <div className="repository-status-card" role="status">
      <div className="repository-status-row">
        <strong>{heading}{age ? <span className="repository-status-age"> · {age}</span> : null}</strong>
        {status.refresh_required || status.view_expired ? (
          <button className="btn" type="button" onClick={onRefresh} disabled={refreshPending}>
            <RefreshCw size={12} /> {refreshPending ? t('本轮结束后刷新') : t('刷新到新版本')}
          </button>
        ) : (
          <button className="btn" type="button" onClick={onUpdate}
            disabled={updatePending || participating || !status.update_eligibility.allowed}>
            <RefreshCw size={12} /> {updatePending ? t('正在检查更新…')
              : participating ? t('已加入更新')
              : active ? t('加入更新') : t('更新')}
          </button>
        )}
      </div>
      {update && (
        <p>{update.status === 'failed' ? t('共享更新失败，当前内容仍可使用')
          : participating
            ? (update.status === 'running' ? t('共享更新正在进行，完成后会提示刷新') : t('已加入共享更新，正在排队'))
            : update.status === 'running' ? t('这个仓库正在更新，完成后会提示刷新') : t('这个仓库有一次更新正在排队')}</p>
      )}
      {notice?.kind === 'up_to_date' && <p>{t('已是最新代码，无需更新')}</p>}
      {retryAfter && !status.update_eligibility.allowed && (
        <p>{t('{0} 后可以再次更新', new Date(retryAfter).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</p>
      )}
      {status.view_expired && <p>{t('旧版本已超过保留期，请刷新查看当前版本。')}</p>}
    </div>
  );
}
