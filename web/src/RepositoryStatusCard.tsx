import RefreshCw from '@sketchyicons/react/icons/refresh-cw';
import { t } from './ui-language';
import type { RepositoryViewStatus } from './types';
import { freshnessText, relativeAge } from './repository-freshness';

export type RepositoryUpdateNotice = { kind: 'up_to_date' | 'joined' | 'queued' | 'deferred'; retryAfter: string | null } | null;

const REVIEW_REASONS: Record<string, string> = {
  changed: '相关代码已变化', deleted: '相关文件已删除', missing: '原来的证据已不存在', unknown: '无法确认相关代码是否变化',
};

export function RepositoryStatusCard({ status, refreshPending, updatePending, notice, onRefresh, onUpdate,
  reviewPending = null, onResolveReview }: {
  status: RepositoryViewStatus;
  refreshPending: boolean;
  updatePending: boolean;
  notice: RepositoryUpdateNotice;
  onRefresh: () => void;
  onUpdate: () => void;
  /** Step being resolved, so its buttons stay disabled until the answer arrives. */
  reviewPending?: string | null;
  onResolveReview?: (stepId: string, action: 'relearn' | 'skip') => void;
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
      {!status.refresh_required && status.migration.status === 'needs_review' && status.migration.items?.length ? (
        <div className="learning-review">
          <p>{t('仓库更新后，{0} 个已学习的步骤需要你决定重学还是跳过：', status.migration.changed_items)}</p>
          <ul>
            {status.migration.items.map(item => (
              <li key={item.step_id}>
                <span><strong>{item.title}</strong> · {t(REVIEW_REASONS[item.reason] ?? REVIEW_REASONS.unknown)}
                  {item.previously === 'skipped' ? ` · ${t('此前已跳过')}` : ''}</span>
                <span className="learning-review-actions">
                  <button className="btn" type="button" disabled={reviewPending === item.step_id}
                    onClick={() => onResolveReview?.(item.step_id, 'relearn')}>{t('重学')}</button>
                  <button className="btn" type="button" disabled={reviewPending === item.step_id}
                    onClick={() => onResolveReview?.(item.step_id, 'skip')}>{t('跳过')}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!status.refresh_required && (status.migration.marked_steps ?? 0) > 0 && (
        <p>{t('路线中还有 {0} 个未学的步骤相关代码已变化，学到时会按新代码讲解。', status.migration.marked_steps ?? 0)}</p>
      )}
    </div>
  );
}
