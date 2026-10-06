import type { runUnderstandingAssessment } from './teaching-workers.js';
import type { AssessmentReviewContext } from './assessment-review-context.js';
import type { TeachingQuestionResult, TeachingTargetResult } from './teaching-question.js';
import { boundedQuestionSupportContext, priorTargetCoverageForAssessment, qualifiedQuestionSupportsForAssessment, targetsForStep } from './target-coverage.js';

/** Explicit mock protocol construction; production receives this from its owner. */
export function assessmentTestReviewContext(input: Parameters<typeof runUnderstandingAssessment>[0],
  result: { targetResults: TeachingTargetResult[]; questionResult?: TeachingQuestionResult }): AssessmentReviewContext {
  const step = input.project.study.dynamic_learning_plan!.find(step => step.step_id === input.question.step_id)!;
  const prior = priorTargetCoverageForAssessment(input.project, input.question, step, input.sourceMessageId);
  const supports = boundedQuestionSupportContext(qualifiedQuestionSupportsForAssessment(input.project, input.question, step, input.sourceMessageId));
  return { registered_question: { question_id: input.question.question_id, created_message_id: input.question.created_message_id,
    snapshot_id: input.question.snapshot_id, route_revision: input.question.route_revision, step_id: input.question.step_id,
    prompt: input.question.prompt, targets: targetsForStep(step).filter(target => input.question.target_ids!.includes(target.target_id)) },
    source_message_id: input.sourceMessageId ?? '', current_answer_parts: input.answerParts ?? [input.answer],
    prior_target_coverage: Object.values(prior.coverage), qualified_prior_question_supports: supports.context,
    omitted_prior_support_count: supports.omittedCount, question_result: result.questionResult ?? null, target_results: result.targetResults };
}
