import type { Message, Project } from '../domain/conversation.js';
import { currentLearningStep } from './learning-actions.js';
import type { TeachingQuestion } from './teaching-question.js';

export interface ConversationReply {
  kind: 'answer' | 'lesson' | 'assessment' | 'action' | 'unavailable';
  text: string;
  question: TeachingQuestion | null;
}

export function questionIsCurrent(project: Project, question: TeachingQuestion): boolean {
  return question.snapshot_id === project.analysis.snapshot_id
    && question.route_revision === (project.study.route_revision ?? 0)
    && question.step_id === currentLearningStep(project)?.step_id;
}

/** Only a saved, actually displayed question can repair a lost or retroactive registration.
 * `history` excludes the turn being regenerated, so it cannot certify its own question. */
export function restoreDisplayedTeachingQuestion(project: Project, history: Message[], userMessageId: string): boolean {
  const current = project.study.teaching_question;
  if (current && questionIsCurrent(project, current) && current.created_message_id !== userMessageId) return false;
  for (const message of [...history].reverse()) {
    const question = message.teaching_question;
    if (message.role !== 'assistant' || message.error || message.placeholder || !question
      || !questionIsCurrent(project, question) || question.created_message_id === userMessageId
      || !message.content.includes(question.prompt)) continue;
    const scope = message.teaching_context;
    const step = currentLearningStep(project)!;
    const targets = step.learning_targets?.length ? step.learning_targets : [step.completion_check];
    if (!scope || scope.snapshot_id !== question.snapshot_id || scope.route_revision !== question.route_revision
      || scope.step_id !== question.step_id || !question.evidence.length || !question.target_items.length
      || question.target_items.some(item => !targets.includes(item))
      || !history.slice(0, history.indexOf(message)).some(source => source.role === 'user'
        && source.message_id === question.created_message_id && source.analysis_snapshot_id === question.snapshot_id)) continue;
    project.study.teaching_question = structuredClone(question);
    return true;
  }
  // A question created in the answer turn cannot be salvaged by resending that same turn.
  if (current?.created_message_id === userMessageId) project.study.teaching_question = null;
  return false;
}

export function learningActionReply(replay: boolean): string | null {
  if (replay) return '这条消息的学习操作已经执行过。本次仅重新生成回答，学习进度没有再次改变。';
  return null;
}
