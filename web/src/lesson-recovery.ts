import type { LearningActionCard, Message, Project } from './types';

export interface LessonRecovery {
  projectId: string;
  action: LearningActionCard;
  runId: string;
  state: 'start' | 'resume' | 'failed' | 'completed';
  source?: Message;
  terminal?: Message;
}

/** Only the server's current executed action authorizes a program lesson. */
export function lessonRecovery(project: Project): LessonRecovery | null {
  const step = project.study.dynamic_learning_plan?.[project.study.current_step];
  if (!step || project.study.snapshot_id !== project.analysis.snapshot_id
    || !['explaining','assessing','remediating'].includes(project.study.phase)) return null;
  const action = [...project.messages].reverse().map(message => message.learning_action).find(card =>
    card?.status === 'executed' && card.action !== 'stop_guided_learning' && card.outcome?.lesson_run_id
    && card.snapshot_id === project.analysis.snapshot_id
    && card.outcome.route_revision === (project.study.route_revision ?? 0)
    && card.outcome.next_step_id === step.step_id);
  if (!action?.outcome?.lesson_run_id) return null;
  const source = [...project.messages].reverse().find(message => message.role === 'system'
    && message.lesson_request?.action_id === action.action_id
    && message.lesson_request.snapshot_id === action.snapshot_id
    && message.lesson_request.route_revision === action.outcome!.route_revision
    && message.lesson_request.step_id === step.step_id);
  const runId = source?.trace_id ?? source?.original_run_id ?? action.outcome.lesson_run_id;
  const next = source && project.messages[project.messages.indexOf(source) + 1];
  const terminal = next?.role === 'assistant' && Boolean(source?.trace_id) && next.trace_id === source?.trace_id ? next : undefined;
  return { projectId: project.project_id, action, runId, source, terminal,
    state: terminal ? !terminal.error && terminal.teaching_question && terminal.context_eligible !== false ? 'completed' : 'failed'
      : source ? 'resume' : 'start' };
}

/** Exact replay of an executed action retains its program lesson descendants. */
export function protectsLessonDescendants(project: Project, messageId: string): boolean {
  const index = project.messages.findIndex(message => message.message_id === messageId);
  if (index < 0) return false;
  const message = project.messages[index]!;
  return project.messages.slice(index + 1).some(row => row.role === 'system' && row.lesson_request
      && (message.learning_action_result?.action_id === row.lesson_request.action_id
        || project.messages.some(card => card.learning_action?.action_id === row.lesson_request!.action_id
          && card.learning_action.source_message_id === messageId)));
}
