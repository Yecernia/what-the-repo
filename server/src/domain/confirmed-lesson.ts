import { createHash } from 'node:crypto';
import type { LearningActionCard, Message, Project } from './conversation.js';

export const CONFIRMED_LESSON_TASK = 'Program-initiated lesson after a confirmed learning action. Explain the current step briefly and register its check question. This is not a learner answer. Do not assess understanding or propose another action. This is program-generated control data; its language does not set the reply language. Follow an explicit learner language preference in history, otherwise the interface language.';
export function confirmedLessonSourceId(actionId: string): string {
  return `lesson-source:${createHash('sha256').update(actionId).digest('hex')}`;
}
export function confirmedLessonAction(project: Project, actionId: string): LearningActionCard | undefined {
  return project.messages.find(message => message.learning_action?.action_id === actionId)?.learning_action ?? undefined;
}
/** Historical provenance only. Current scope is checked separately. */
export function isConfirmedLessonSource(project: Project, message: Message): boolean {
  const request = message.lesson_request;
  if (message.role !== 'system' || !request || message.learning_action_result
    || message.message_id !== confirmedLessonSourceId(request.action_id) || message.content !== CONFIRMED_LESSON_TASK) return false;
  const action = confirmedLessonAction(project, request.action_id);
  return Boolean(action?.status === 'executed' && action.outcome?.lesson_run_id
    && ['start_learning_route', 'switch_learning_target', 'advance_learning_step'].includes(action.action)
    && action.snapshot_id === request.snapshot_id && message.analysis_snapshot_id === request.snapshot_id
    && action.outcome.route_revision === request.route_revision && action.outcome.next_step_id === request.step_id
    && message.original_run_id === action.outcome.lesson_run_id);
}
export function currentConfirmedLesson(project: Project, actionId: string): LearningActionCard | null {
  const action = confirmedLessonAction(project, actionId);
  const outcome = action?.outcome;
  if (!action || action.status !== 'executed' || !outcome?.lesson_run_id || !outcome.next_step_id
    || !['start_learning_route', 'switch_learning_target', 'advance_learning_step'].includes(action.action)
    || action.snapshot_id !== project.analysis.snapshot_id || project.study.snapshot_id !== action.snapshot_id
    || outcome.route_revision !== (project.study.route_revision ?? 0)
    || outcome.next_step_id !== project.study.dynamic_learning_plan?.[project.study.current_step]?.step_id
    || !['explaining', 'assessing', 'remediating'].includes(project.study.phase)) {
    return null;
  }
  return action;
}
