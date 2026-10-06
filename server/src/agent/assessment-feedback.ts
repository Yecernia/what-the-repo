import type { TeachingFeedbackScope, TeachingQuestionResult } from './teaching-question.js';

/** Status is a projection of validated judgments, never another model verdict. */
export function assessmentStatusText(input: {
  answerRelevant?: boolean;
  verdict: string | null;
  questionResult?: TeachingQuestionResult;
  feedbackScope: TeachingFeedbackScope | null;
}, originalMessage: string): string {
  if (input.answerRelevant === false || input.verdict === 'unclear' || !input.questionResult || !input.feedbackScope) return '';
  const chinese = /\p{Script=Han}/u.test(originalMessage);
  const question = input.questionResult.complete
    ? chinese ? '本题已回答完整。' : 'This question is complete.'
    : input.questionResult.requirements.some(requirement => requirement.outcome === 'contradicted')
      ? chinese ? '本题仍有需要纠正的内容。' : 'This question still contains an error to correct.'
      : chinese ? '本题还有未完成的要求。' : 'This question still has unanswered requirements.';
  const remaining = input.feedbackScope.step_remaining_target_ids.length;
  const step = remaining
    ? chinese ? `本步还有 ${remaining} 项学习目标尚未获得完整证明。` : `${remaining} learning target${remaining === 1 ? '' : 's'} in this step still need${remaining === 1 ? 's' : ''} complete proof.`
    : chinese ? '本步所有学习目标已有有效证明。' : 'All learning targets in this step have valid proof.';
  return `${question}\n${step}`;
}

