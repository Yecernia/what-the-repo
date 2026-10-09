import type { TeachingPhase } from './types';
import { t } from './ui-language';

/** How far a project's learning has grown: "curiosity is a sprout". */
export type ProjectGrowth = 'seed' | 'sprout' | 'tree';

/** No route yet (or one only proposed) is a seed, an active route a sprout, a finished route a small tree.
 * A project whose analysis is still running or failed has not started learning, so it stays a seed. */
export function projectGrowth(phase: TeachingPhase | null | undefined): ProjectGrowth {
  if (phase === 'completed') return 'tree';
  if (phase === 'explaining' || phase === 'assessing' || phase === 'remediating') return 'sprout';
  return 'seed';
}

export function projectGrowthLabel(growth: ProjectGrowth): string {
  return growth === 'tree' ? t('已学完这条路线') : growth === 'sprout' ? t('正在学习') : t('还没开始学习');
}
