import type { EvidenceRef, Message, Project } from '../domain/conversation.js';
import { currentLearningStep } from './learning-actions.js';
import type { TeachingQuestion } from './teaching-question.js';
import type { AssessmentReviewContext } from './assessment-review-context.js';
import { normalizeQuestionTargets, targetsForStep } from './target-coverage.js';
import { isConfirmedLessonSource } from '../domain/confirmed-lesson.js';

export interface ReplyEvidenceBlock {
  kind: 'assessment' | 'explanation' | 'question';
  text: string;
  evidence: EvidenceRef[];
  assessment_context?: AssessmentReviewContext;
}

export interface ConversationReply {
  kind: 'answer' | 'lesson' | 'assessment' | 'action' | 'unavailable';
  text: string;
  question: TeachingQuestion | null;
  evidenceBlocks?: ReplyEvidenceBlock[];
}

/** One turn-wide allowance, shared by SDK schema validation and tool preflight. */
export const MAX_REPLY_SUBMISSIONS = 3;
export interface ReplySubmissionBudget { used: number }

/** The model labels a lossless partition, not a rewritten whole-turn intent.
 * Requests and an answer can coexist; source text remains authoritative. */
export interface TeachingTurnPart {
  kind: 'answer' | 'replace' | 'explain' | 'control' | 'other';
  text: string;
}

export function validateTeachingTurn(message: string, parts: TeachingTurnPart[]): string | null {
  if (!parts.length || parts.some(part => !part.text.trim()) || parts.map(part => part.text).join('') !== message) {
    return 'Parts must partition the entire original user message exactly, in order, including punctuation and whitespace. Never rewrite or omit an answer.';
  }
  return null;
}

function sameQuestion(left: TeachingQuestion, right: TeachingQuestion): boolean {
  return left.question_id === right.question_id && left.created_message_id === right.created_message_id
    && left.prompt === right.prompt && left.snapshot_id === right.snapshot_id
    && left.step_id === right.step_id && left.route_revision === right.route_revision
    && JSON.stringify(left.target_items) === JSON.stringify(right.target_items)
    && JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

function displayedQuestion(project: Project, history: Message[], userMessageId: string): TeachingQuestion | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    const question = message.teaching_question;
    if (message.role !== 'assistant' || message.error || message.placeholder || !question
      || !questionIsCurrent(project, question) || question.created_message_id === userMessageId
      || !message.content.includes(question.prompt)) continue;
    const supportingBlocks = message.content_parts?.evidence_blocks?.filter(block => block.kind !== 'assessment');
    if (question.commit_eligibility?.deterministic === false
      || supportingBlocks?.some(block => block.commit_eligible === false
        || (block.review && (block.review.status === 'unverified' || (block.kind === 'question' && block.review.status === 'not_applicable')
          || block.review.completed === false || block.review.evidenceIncomplete === true || block.review.coverage?.complete === false
          || (block.review.status === 'reviewed' && !block.review.supported))))
      || (!supportingBlocks?.length && message.context_eligible === false)) continue;
    const scope = message.teaching_context;
    const step = currentLearningStep(project)!;
    const targets = targetsForStep(step).map(target => target.label);
    if (!scope || scope.snapshot_id !== question.snapshot_id || scope.route_revision !== question.route_revision
      || scope.step_id !== question.step_id || !question.evidence.length || !question.target_items.length
      || question.target_items.some(item => !targets.includes(item))
      || !history.slice(0, index).some(source => (source.role === 'user' || isConfirmedLessonSource(project, source))
        && source.message_id === question.created_message_id && source.analysis_snapshot_id === question.snapshot_id)) continue;
    try { return normalizeQuestionTargets(question, step); } catch { continue; }
  }
  return null;
}

export function questionWasDisplayed(project: Project, question: TeachingQuestion, userMessageId: string): boolean {
  const displayed = displayedQuestion(project, project.messages, userMessageId);
  return Boolean(displayed && sameQuestion(question, displayed));
}

/** Reject an echoed question block, rather than deleting possibly useful teaching
 * prose. The model can resubmit an explanation; the program renders the check once. */
export function repeatsQuestion(text: string, prompt: string): boolean {
  const normalize = (value: string) => value.replace(/[*_`~]/g, '').replace(/^\s*(?:#{1,6}|>|[-+]|\d+[.)])\s+/gm, '')
    .replace(/^(?:理解检查|检查题|问题|Question|Check)\s*[:：]\s*/iu, '')
    .replace(/\s+/g, ' ').trim();
  const question = normalize(prompt);
  const blocks = text.split(/\n\s*\n/).map(normalize).filter(Boolean);
  return blocks.some((_block, index) => {
    let candidate = '';
    for (let end = index; end < blocks.length && candidate.length < question.length; end++) {
      candidate += (candidate ? ' ' : '') + blocks[end];
      if (candidate === question) return true;
    }
    return false;
  });
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
  const displayed = displayedQuestion(project, history, userMessageId);
  if (displayed && current && sameQuestion(current, displayed)) return false;
  project.study.teaching_question = displayed ? structuredClone(displayed) : null;
  return Boolean(displayed);
}

export function learningActionReply(replay: boolean): string | null {
  if (replay) return '这条消息的学习操作已经执行过。本次恢复已保存的回答，学习进度没有再次改变。';
  return null;
}
