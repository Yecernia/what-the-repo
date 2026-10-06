import type { TeachingQuestionResult, TeachingTargetResult } from './teaching-question.js';
import type { TeachingTargetCoverage, boundedQuestionSupportContext } from './target-coverage.js';

/** Program-bound assessment premises. This is context, never extra source evidence. */
export interface AssessmentReviewContext {
  registered_question: {
    question_id: string;
    created_message_id: string;
    snapshot_id: string;
    route_revision: number;
    step_id: string;
    prompt: string;
    targets: Array<{ target_id: string; label: string }>;
  };
  source_message_id: string;
  current_answer_parts: string[];
  prior_target_coverage: TeachingTargetCoverage[];
  /** Only qualified records; no arbitrary conversation history. */
  qualified_prior_question_supports?: ReturnType<typeof boundedQuestionSupportContext>['context'];
  omitted_prior_support_count?: number;
  question_result: TeachingQuestionResult | null;
  target_results: TeachingTargetResult[];
}

/** The candidate record is checked as data, separately from editable prose.
 * Program-generated success/status messages are deliberately absent. */
export function assessmentReviewDocument(feedback: string, context: AssessmentReviewContext) {
  const record = 'Candidate assessment record (verify these judgments against the learner and source):\n'
    + JSON.stringify({ question_result: context.question_result, target_results: context.target_results });
  const prefix = record + '\n\n';
  const { question_result: _questionResult, target_results: _targetResults, ...premises } = context;
  return { text: prefix + feedback, feedbackStart: prefix.length, premises };
}

/** Ownership comes from the program's document ranges, never from a model vote.
 * A finding that crosses both objects belongs to the immutable judgment. */
export function assessmentFindingSubject(document: { text: string; feedbackStart: number },
  section: { start: number; end: number }, claim: string): 'assessment_judgment' | 'assessment_feedback' {
  let at = document.text.indexOf(claim);
  let feedbackOnly = false;
  while (at >= 0) {
    if (at < section.end && at + claim.length > section.start) {
      if (at < document.feedbackStart) return 'assessment_judgment';
      feedbackOnly = true;
    }
    at = document.text.indexOf(claim, at + Math.max(1, claim.length));
  }
  return feedbackOnly ? 'assessment_feedback' : 'assessment_judgment';
}
