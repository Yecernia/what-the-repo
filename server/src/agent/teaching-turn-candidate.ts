import type { Project } from '../domain/conversation.js';
import type { ConversationReply } from './conversation-reply.js';
import type { ReplyEvidenceBlock } from './reply-evidence.js';
import type { TeachingQuestion } from './teaching-question.js';

/** A turn-local preview; it is never the input project's study state. */
export interface TeachingTurnCandidates { project: Project | null }

/** The baseline uses the current source message, including edits. The service
 * separately retains its persisted database baseline for the CAS guard. */
export function reduceTeachingTurnCommit(input: {
  baseline: Project; candidate: Project | null; completed: boolean; cancelled: boolean;
  replyKind?: ConversationReply['kind']; hasAssessment: boolean; question: TeachingQuestion | null;
  blocks: readonly ReplyEvidenceBlock[]; validationErrors: readonly string[];
}) {
  const active = input.completed && !input.cancelled && input.replyKind !== 'unavailable';
  const assessmentEligible = !input.hasAssessment || (active && input.blocks.some(block => block.kind === 'assessment' && block.commit_eligible));
  const explanationsEligible = input.blocks.filter(block => block.kind === 'explanation').every(block => block.commit_eligible);
  const questionEligible = !input.question || (active && assessmentEligible && explanationsEligible
    && input.blocks.some(block => block.kind === 'question' && block.commit_eligible));
  const project = structuredClone(active && assessmentEligible && input.hasAssessment && input.candidate ? input.candidate : input.baseline);
  const assessedQuestion = active && assessmentEligible && input.hasAssessment ? structuredClone(project.study.teaching_question ?? null) : null;
  const question = active && questionEligible ? structuredClone(input.question) : null;
  if (question) project.study.teaching_question = question;
  const turnEligible = active && assessmentEligible && questionEligible && !input.validationErrors.length
    && input.blocks.every(block => block.commit_eligible);
  return { project, assessedQuestion, question, assessmentEligible, questionEligible, turnEligible };
}
