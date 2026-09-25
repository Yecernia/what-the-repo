import { INK_LOOP } from './InkSpinner';
import { smoothPath, type PenPoint } from './pen-path';
import { t } from './ui-language';

export type ProjectActivity = 'running' | 'done' | 'failed';

const TICK = smoothPath([[3.2,8.6],[6.4,11.8],[12.8,4.2]] as PenPoint[]);

/** A small ink mark on a project card the learner is not looking at: a circle being drawn over and over while an
 * answer or analysis runs there, a tick drawn once when a new result is waiting, a red "!" when it failed. */
export function ProjectActivityMark({ state, analysis = false }: { state?: ProjectActivity; analysis?: boolean }) {
  if (!state) return null;
  const label = state === 'running' ? (analysis ? t('正在分析') : t('正在回答'))
    : state === 'done' ? t('有新的结果') : t('没有完成');
  return <span className={`project-activity project-activity-${state}`} role="status" aria-label={label} data-tooltip={label}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {state === 'running' && <path d={INK_LOOP} pathLength={1} strokeWidth={1.7} />}
      {state === 'done' && <path d={TICK} pathLength={1} strokeWidth={2.1} />}
      {state === 'failed' && <><path d="M8 3.2 L7.8 9.4" strokeWidth={2.1} /><path d="M7.8 12.6 L7.8 12.8" strokeWidth={2.4} /></>}
    </svg>
  </span>;
}
