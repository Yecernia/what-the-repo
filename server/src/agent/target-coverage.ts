import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Message, Project } from '../domain/conversation.js';
import { isConfirmedLessonSource } from '../domain/confirmed-lesson.js';
import type { LearningTargetDefinition, SnapshotLearningStep } from '../domain/snapshot.js';
import type { TeachingFeedbackScope, TeachingQuestion, TeachingQuestionResult, TeachingTargetAssessmentRecord, TeachingTargetResult } from './teaching-question.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** IDs are derived from exact labels and their route position, never fuzzy text. */
export function targetsForStep(step: SnapshotLearningStep): LearningTargetDefinition[] {
  const targets = step.learning_target_defs !== undefined ? step.learning_target_defs.map(target => ({ ...target }))
    : (step.learning_targets?.length ? step.learning_targets : [step.completion_check]).map((label, index) => ({
      target_id: `target:${hash(JSON.stringify([step.step_id, index, label]))}`, label,
    }));
  if (!targets.length || targets.some(target => !target.target_id || !target.label)
    || new Set(targets.map(target => target.target_id)).size !== targets.length) throw new Error('invalid_learning_targets');
  return targets;
}

/** Bind old label-only questions without granting any old mastery new authority. */
export function normalizeQuestionTargets(question: TeachingQuestion, step: SnapshotLearningStep): TeachingQuestion {
  if (question.step_id !== step.step_id) throw new Error('question_target_scope_mismatch');
  const targets = targetsForStep(step);
  const ids = question.target_ids === undefined ? question.target_items.map(label => {
    const matches = targets.filter(target => target.label === label);
    if (matches.length !== 1) throw new Error('question_target_label_not_unique');
    return matches[0]!.target_id;
  }) : [...question.target_ids];
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !targets.some(target => target.target_id === id)))
    throw new Error('question_target_scope_mismatch');
  return { ...structuredClone(question), target_ids: ids,
    target_items: ids.map(id => targets.find(target => target.target_id === id)!.label),
    answer_attempts: structuredClone(question.answer_attempts ?? []) };
}

export function targetResultValidationErrors(
  question: TeachingQuestion, answerParts: readonly string[], results: readonly TeachingTargetResult[],
  allowedEvidenceIds: ReadonlySet<string>,
  priorSupports: readonly TeachingTargetAssessmentRecord[] = [],
): string[] {
  const ids = question.target_ids ?? [];
  const errors: string[] = [];
  if (!ids.length || new Set(ids).size !== ids.length) errors.push('target_results: question has no valid target binding');
  if (results.length !== ids.length || new Set(results.map(result => result.target_id)).size !== results.length
    || ids.some(id => !results.some(result => result.target_id === id))) errors.push('target_results: cover each bound question target exactly once');
  for (const result of results) {
    if (!ids.includes(result.target_id)) errors.push('target_results: unknown or out-of-question target ' + result.target_id);
    if (!['proven', 'contradicted', 'unproven', 'not_addressed'].includes(result.outcome) || !result.reason.trim())
      errors.push('target_results: invalid outcome or empty reason');
    if (result.answer_spans.some(span => !span.trim() || !answerParts.some(part => part.includes(span))))
      errors.push('target_results: answer_spans must be exact nonempty spans of the current answer parts');
    if (result.evidence_ids.some(id => !allowedEvidenceIds.has(id))) errors.push('target_results: evidence must come from a complete question packet');
    if (['proven', 'contradicted'].includes(result.outcome) && (!result.answer_spans.length || !result.evidence_ids.length))
      errors.push('target_results: proven/contradicted requires current answer spans and complete evidence');
    if (new Set(result.prior_answer_message_ids ?? []).size !== (result.prior_answer_message_ids ?? []).length)
      errors.push('target_results: duplicate prior proof reference');
    if ((result.prior_answer_message_ids ?? []).some(id => !priorSupports.some(record => record.message_id === id
      && (record.results.some(prior => prior.target_id === result.target_id && prior.outcome === 'proven')
        || record.question_result?.requirements.some(requirement => requirement.outcome === 'satisfied'
          && requirement.target_ids.includes(result.target_id))))))
      errors.push('target_results: prior proof must be a qualified unretracted source for this target');
    if (result.outcome === 'contradicted' && result.prior_answer_message_ids?.length)
      errors.push('target_results: contradiction must use only current answer');
  }
  return [...new Set(errors)];
}

function questionResultShapeValid(result: TeachingQuestionResult): boolean {
  return Boolean(result && typeof result.complete === 'boolean' && Array.isArray(result.requirements)
    && !result.requirements.some(requirement => !requirement || typeof requirement.prompt_span !== 'string'
      || typeof requirement.reason !== 'string' || !['satisfied', 'missing', 'contradicted', 'not_selected'].includes(requirement.outcome)
      || !Array.isArray(requirement.target_ids) || !Array.isArray(requirement.answer_spans)
      || !Array.isArray(requirement.prior_answer_message_ids) || !Array.isArray(requirement.evidence_ids)
      || [...requirement.target_ids, ...requirement.answer_spans, ...requirement.prior_answer_message_ids, ...requirement.evidence_ids].some(value => typeof value !== 'string')));
}

export function questionResultValidationErrors(question: TeachingQuestion, answerParts: readonly string[],
  result: TeachingQuestionResult, allowedEvidenceIds: ReadonlySet<string>,
  priorSupports: readonly TeachingTargetAssessmentRecord[] = [], currentResults?: readonly TeachingTargetResult[]): string[] {
  const errors: string[] = [];
  if (!questionResultShapeValid(result)) return ['question_result: malformed saved requirement data'];
  if (!result.requirements.length || result.requirements.length > 12) errors.push('question_result: enumerate actual prompt requirements');
  for (const requirement of result.requirements) {
    if (!requirement.prompt_span.trim() || !question.prompt.includes(requirement.prompt_span))
      errors.push('question_result: prompt_span must quote exact saved question');
    if (!requirement.reason.trim() || !requirement.target_ids.length || new Set(requirement.target_ids).size !== requirement.target_ids.length
      || requirement.target_ids.some(id => !question.target_ids?.includes(id))) errors.push('question_result: invalid requirement binding');
    if (requirement.answer_spans.some(span => !span.trim() || !answerParts.some(part => part.includes(span))))
      errors.push('question_result: current answer spans must be exact');
    if (requirement.evidence_ids.some(id => !allowedEvidenceIds.has(id))) errors.push('question_result: evidence outside complete question packets');
    if (requirement.prior_answer_message_ids.some(id => !priorSupports.some(record => record.message_id === id
      && record.question_id === question.question_id && record.question_prompt_sha256 === hash(question.prompt)
      && (requirement.target_ids.every(target => record.results.some(prior => prior.target_id === target && prior.outcome === 'proven'))
        || record.question_result?.requirements.some(prior => prior.outcome === 'satisfied'
          && prior.prompt_span === requirement.prompt_span && requirement.target_ids.every(target => prior.target_ids.includes(target)))))))
      errors.push('question_result: prior answer must be qualified same-question proof');
    if (requirement.outcome === 'satisfied' && (!requirement.evidence_ids.length
      || (!requirement.answer_spans.length && !requirement.prior_answer_message_ids.length)))
      errors.push('question_result: satisfaction requires current spans or qualified prior proof and current packet evidence');
    if (requirement.outcome === 'contradicted' && (!requirement.answer_spans.length || !requirement.evidence_ids.length
      || requirement.prior_answer_message_ids.length)) errors.push('question_result: contradiction requires current spans and evidence');
    if (currentResults && requirement.outcome === 'contradicted' && requirement.target_ids.some(id =>
      !currentResults.some(target => target.target_id === id && target.outcome === 'contradicted')))
      errors.push('question_result: explicit contradicted constituent must contradict its whole bound target');
    if (new Set(requirement.prior_answer_message_ids).size !== requirement.prior_answer_message_ids.length)
      errors.push('question_result: duplicate prior proof reference');
  }
  if (result.complete !== result.requirements.every(requirement => ['satisfied', 'not_selected'].includes(requirement.outcome))
    || (result.complete && !result.requirements.some(requirement => requirement.outcome === 'satisfied')))
    errors.push('question_result: completeness must match selected actual requirements');
  return [...new Set(errors)];
}

/** Semantic requirements are model-owned; their aggregate completeness is deterministic. */
export function questionResultFromRequirements(requirements: TeachingQuestionResult['requirements']): TeachingQuestionResult {
  return { complete: requirements.length > 0 && requirements.some(requirement => requirement.outcome === 'satisfied')
    && requirements.every(requirement => requirement.outcome === 'satisfied' || requirement.outcome === 'not_selected'),
    requirements: structuredClone(requirements) };
}

export interface TeachingTargetCoverage {
  target_id: string;
  label: string;
  proven: boolean;
  evidence_ids: string[];
  question_id?: string;
  message_id?: string;
  sequence?: number;
}

export interface TargetCoverageResult {
  coverage: Record<string, TeachingTargetCoverage>;
  /** All required step targets, including the currently unproven ones. */
  targetIds: string[];
  stepPassed: boolean;
  sequence: number;
}

function snapshotScope(project: Project, snapshotId?: string): string | null {
  return snapshotId ?? project.study.snapshot_id ?? project.analysis.snapshot_id;
}

/** A proof must retain the actual displayed question's authority and provenance. */
function qualifiedQuestionMessage(project: Project, message: Message | undefined, step: SnapshotLearningStep,
  answerMessageId: string): TeachingQuestion | null {
  const question = message?.teaching_question;
  if (!message || message.role !== 'assistant' || message.placeholder || message.error || !question
    || question.created_message_id === answerMessageId || !message.content.includes(question.prompt)
    || question.commit_eligibility?.deterministic === false) return null;
  const questionIndex = project.messages.indexOf(message);
  const answerIndex = project.messages.findIndex(row => row.message_id === answerMessageId && row.role === 'user');
  if (answerIndex <= questionIndex || !project.messages.slice(0, questionIndex).some(row => (row.role === 'user' || isConfirmedLessonSource(project, row))
    && row.message_id === question.created_message_id && row.analysis_snapshot_id === question.snapshot_id)) return null;
  const scope = message.teaching_context;
  if (!scope || scope.snapshot_id !== question.snapshot_id || scope.step_id !== question.step_id
    || scope.route_revision !== question.route_revision) return null;
  const blocks = message.content_parts?.evidence_blocks?.filter(block => block.kind !== 'assessment');
  if (blocks?.some(block => block.commit_eligible === false || (block.review
    && (block.review.status === 'unverified' || (block.kind === 'question' && block.review.status === 'not_applicable')
          || block.review.completed === false || block.review.evidenceIncomplete === true || block.review.coverage?.complete === false || (block.review.status === 'reviewed' && !block.review.supported))))
    || (!blocks?.length && message.context_eligible === false)) return null;
  try { return normalizeQuestionTargets(question, step); } catch { return null; }
}

function sameQuestionBinding(left: TeachingQuestion, right: TeachingQuestion): boolean {
  const evidenceBinding = (question: TeachingQuestion) => question.evidence.map(row =>
    [row.stable_id, row.path, row.start_line, row.end_line]);
  return left.question_id === right.question_id && left.created_message_id === right.created_message_id
    && left.snapshot_id === right.snapshot_id && left.route_revision === right.route_revision && left.step_id === right.step_id
    && left.prompt === right.prompt && JSON.stringify(left.target_ids) === JSON.stringify(right.target_ids)
    && JSON.stringify(evidenceBinding(left)) === JSON.stringify(evidenceBinding(right));
}

function scopedRecords(project: Project, step: SnapshotLearningStep, snapshotId?: string): TeachingTargetAssessmentRecord[] {
  const snapshot = snapshotScope(project, snapshotId);
  const targetIds = new Set(targetsForStep(step).map(target => target.target_id));
  const candidates = (project.study.target_assessments ?? []).filter(record => {
    if (!record || !Array.isArray(record.answer_parts) || !Array.isArray(record.target_ids)
      || !Array.isArray(record.results) || record.results.some(result => !result || typeof result.target_id !== 'string'
        || typeof result.reason !== 'string' || !Array.isArray(result.answer_spans) || !Array.isArray(result.evidence_ids))
      || record.answer_parts.some(part => typeof part !== 'string')
      || record.results.some(result => result.answer_spans.some(span => typeof span !== 'string'))) return false;
    if (record.results.some(result => result.prior_answer_message_ids !== undefined
      && (!Array.isArray(result.prior_answer_message_ids) || result.prior_answer_message_ids.some(id => typeof id !== 'string')))) return false;
    if (record.question_result && !questionResultShapeValid(record.question_result)) return false;
    if (record.snapshot_id !== snapshot || record.route_revision !== (project.study.route_revision ?? 0)
      || record.step_id !== step.step_id || !Number.isSafeInteger(record.sequence) || record.sequence < 1) return false;
    const message = project.messages.find(message => message.message_id === record.original_message_id && message.role === 'user');
    if (!message || record.message_id !== record.original_message_id || hash(message.content) !== record.source_message_sha256
      || !record.answer_parts.length || record.answer_parts.some(part => !part.trim() || !message.content.includes(part))
      || record.target_ids.some(id => !targetIds.has(id))) return false;
    const question = qualifiedQuestionMessage(project,
      project.messages.find(row => row.message_id === record.question_message_id), step, record.message_id);
    if (!question || question.question_id !== record.question_id || question.snapshot_id !== record.snapshot_id
      || question.route_revision !== record.route_revision || hash(question.prompt) !== record.question_prompt_sha256
      || JSON.stringify(question.target_ids) !== JSON.stringify(record.target_ids)) return false;
    // Stored records were validated against complete packets when created. Recheck
    // their scope, answer binding and internal shape before deriving authority.
    return !targetResultValidationErrors(question, record.answer_parts,
      record.results.map(result => ({ ...result, prior_answer_message_ids: [] })),
      new Set(question.evidence.map(row => row.stable_id))).length;
  }).sort((a, b) => a.sequence - b.sequence);
  const accepted: TeachingTargetAssessmentRecord[] = [];
  for (const record of candidates) {
    const question = normalizeQuestionTargets(project.messages.find(row => row.message_id === record.question_message_id)!.teaching_question!, step);
    const answerIndex = project.messages.findIndex(row => row.message_id === record.message_id);
    const supports = activeQuestionSupports(accepted).filter(source => source.sequence < record.sequence
      && project.messages.findIndex(row => row.message_id === source.message_id) < answerIndex);
    const allowedIds = new Set(question.evidence.map(row => row.stable_id));
    if (targetResultValidationErrors(question, record.answer_parts, record.results, allowedIds, supports).length
      || (record.question_result && questionResultValidationErrors(question, record.answer_parts, record.question_result, allowedIds, supports, record.results).length)) continue;
    accepted.push({ ...record, question_prompt: question.prompt });
  }
  return accepted;
}

/** Only source-qualified partial proof, never an automatic union of natural-language labels. */
function activeQuestionSupports(records: readonly TeachingTargetAssessmentRecord[]): TeachingTargetAssessmentRecord[] {
  return records.flatMap((record, index) => {
    const requirements = (record.question_result?.requirements ?? []).filter(requirement => requirement.outcome === 'satisfied'
      && !records.slice(index + 1).some(later => later.results.some(result => result.outcome === 'contradicted'
        && requirement.target_ids.includes(result.target_id))));
    const results = record.results.filter(result => !records.slice(index + 1).some(later => later.results.some(next =>
      next.target_id === result.target_id && next.outcome === 'contradicted')));
    return requirements.length || results.some(result => result.outcome === 'proven')
      ? [{ ...record, results, ...(record.question_result ? { question_result: { complete: false, requirements } } : {}) }] : [];
  });
}

export function qualifiedQuestionSupportsForAssessment(project: Project, question: TeachingQuestion,
  step: SnapshotLearningStep, excludeMessageId?: string): TeachingTargetAssessmentRecord[] {
  if (question.snapshot_id !== snapshotScope(project) || question.route_revision !== (project.study.route_revision ?? 0))
    throw new Error('target_assessment_scope_mismatch');
  normalizeQuestionTargets(question, step);
  const copy = structuredClone(project);
  copy.study.target_assessments = (copy.study.target_assessments ?? []).filter(record => record.message_id !== excludeMessageId);
  const answerIndex = excludeMessageId ? project.messages.findIndex(row => row.message_id === excludeMessageId) : project.messages.length;
  return activeQuestionSupports(scopedRecords(copy, step, question.snapshot_id))
    .filter(record => project.messages.findIndex(row => row.message_id === record.message_id) < answerIndex);
}

/** Whole source records only: bounded context never truncates an exact proof span. */
export function boundedQuestionSupportContext(records: readonly TeachingTargetAssessmentRecord[]) {
  const rows = records.slice(-24).map(record => ({ question_id: record.question_id, question_message_id: record.question_message_id,
    source_question_prompt: record.question_prompt ?? null, message_id: record.message_id, sequence: record.sequence,
    answer_parts: record.answer_parts,
    satisfied_requirements: (record.question_result?.requirements ?? []).filter(requirement => requirement.outcome === 'satisfied')
      .map(requirement => ({ prompt_span: requirement.prompt_span, target_ids: requirement.target_ids,
        prior_answer_message_ids: requirement.prior_answer_message_ids, evidence_ids: requirement.evidence_ids })),
    proven_target_ids: record.results.filter(result => result.outcome === 'proven').map(result => result.target_id),
    snapshot_id: record.snapshot_id, route_revision: record.route_revision, step_id: record.step_id }));
  const context: typeof rows = [];
  const presentedSupports: TeachingTargetAssessmentRecord[] = [];
  let characters = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const size = JSON.stringify(row).length;
    if (characters + size > 24_000) continue;
    context.unshift(row); presentedSupports.unshift(records[records.length - rows.length + index]!); characters += size;
  }
  return { context, presentedSupports, omittedCount: records.length - context.length };
}

export function targetCoverageForStep(project: Project, step: SnapshotLearningStep, snapshotId?: string,
  excludeMessageId?: string): TargetCoverageResult {
  const targets = targetsForStep(step);
  const coverage = Object.fromEntries(targets.map(target => [target.target_id,
    { ...target, proven: false, evidence_ids: [] } as TeachingTargetCoverage]));
  let sequence = 0;
  const source = excludeMessageId ? structuredClone(project) : project;
  if (excludeMessageId) source.study.target_assessments = (source.study.target_assessments ?? []).filter(record => record.message_id !== excludeMessageId);
  for (const record of scopedRecords(source, step, snapshotId)) {
    if (record.message_id === excludeMessageId) continue;
    sequence = Math.max(sequence, record.sequence);
    for (const result of record.results) {
      if (result.outcome === 'proven' || result.outcome === 'contradicted') coverage[result.target_id] = {
        ...coverage[result.target_id]!, proven: result.outcome === 'proven', evidence_ids: [...result.evidence_ids],
        question_id: record.question_id, message_id: record.message_id, sequence: record.sequence,
      };
    }
  }
  return { coverage, targetIds: targets.map(target => target.target_id),
    stepPassed: targets.every(target => coverage[target.target_id]!.proven), sequence };
}

/** Validated historical coverage, never the turn being retried or edited. */
export function priorTargetCoverageForAssessment(project: Project, question: TeachingQuestion,
  step: SnapshotLearningStep, sourceMessageId?: string): TargetCoverageResult {
  if (question.snapshot_id !== snapshotScope(project) || question.route_revision !== (project.study.route_revision ?? 0))
    throw new Error('target_assessment_scope_mismatch');
  normalizeQuestionTargets(question, step);
  return targetCoverageForStep(project, step, question.snapshot_id, sourceMessageId);
}

/** Preview only: feedback does not commit, repeat or relabel a historical proof. */
export function assessmentFeedbackScope(prior: TargetCoverageResult, question: TeachingQuestion,
  currentResults: readonly TeachingTargetResult[], questionResult?: TeachingQuestionResult): TeachingFeedbackScope {
  const questionIds = question.target_ids ?? [];
  if (!questionIds.length || questionIds.some(id => !prior.targetIds.includes(id))
    || new Set(questionIds).size !== questionIds.length
    || currentResults.some(result => !questionIds.includes(result.target_id))
    || new Set(currentResults.map(result => result.target_id)).size !== currentResults.length)
    throw new Error('feedback_scope_target_mismatch');
  const priorProven = prior.targetIds.filter(id => prior.coverage[id]?.proven);
  const covered = new Set(priorProven);
  for (const result of currentResults) {
    if (result.outcome === 'proven') covered.add(result.target_id);
    else if (result.outcome === 'contradicted') covered.delete(result.target_id);
  }
  return {
    prior_proven_target_ids: priorProven,
    current_proven_target_ids: questionIds.filter(id => currentResults.some(result => result.target_id === id && result.outcome === 'proven')),
    question_covered_target_ids: questionResult ? questionIds.filter(id => {
      const selected = questionResult.requirements.filter(requirement => requirement.target_ids.includes(id) && requirement.outcome !== 'not_selected');
      return selected.length > 0 && selected.every(requirement => requirement.outcome === 'satisfied');
    }) : questionIds.filter(id => covered.has(id)),
    question_remaining_target_ids: questionResult ? questionIds.filter(id => questionResult.requirements.some(requirement =>
      requirement.target_ids.includes(id) && ['missing', 'contradicted'].includes(requirement.outcome))) : questionIds.filter(id => !covered.has(id)),
    step_remaining_target_ids: prior.targetIds.filter(id => !covered.has(id)),
    follow_up_target_ids: [],
    ...(questionResult ? { question_complete: questionResult.complete, question_requirements: structuredClone(questionResult.requirements) } : {}),
  };
}

export function feedbackScopeValidationErrors(expected: TeachingFeedbackScope, submitted: TeachingFeedbackScope): string[] {
  const errors: string[] = [];
  if (expected.question_complete !== undefined && (submitted.question_complete !== expected.question_complete
    || !isDeepStrictEqual(submitted.question_requirements, expected.question_requirements)))
    errors.push('feedback_scope_mismatch: question completeness and requirements must match question_result');
  const fields = ['prior_proven_target_ids', 'current_proven_target_ids', 'question_covered_target_ids',
    'question_remaining_target_ids', 'step_remaining_target_ids'] as const;
  for (const field of fields) {
    const actual = submitted[field];
    if (actual.length !== expected[field].length || new Set(actual).size !== actual.length
      || actual.some(id => !expected[field].includes(id)))
      errors.push(`feedback_scope_mismatch: ${field} must equal ${JSON.stringify(expected[field])}`);
  }
  if (new Set(submitted.follow_up_target_ids).size !== submitted.follow_up_target_ids.length
    || submitted.follow_up_target_ids.some(id => !expected.step_remaining_target_ids.includes(id)))
    errors.push('feedback_scope_already_proven: follow_up_target_ids must contain only genuinely remaining step targets; never re-request accumulated proofs');
  return errors;
}

/** The ledger is authoritative; a legacy step_passed or free mastery label is insufficient. */
export function hasValidTargetPass(project: Project, step: SnapshotLearningStep, snapshotId?: string): boolean {
  if (project.study.dynamic_learning_plan?.length
    && project.study.dynamic_learning_plan[project.study.current_step]?.step_id !== step.step_id) return false;
  const passed = project.study.step_passed;
  const result = targetCoverageForStep(project, step, snapshotId);
  return Boolean(result.stepPassed && passed?.proof_version === 1 && passed.step_id === step.step_id
    && passed.snapshot_id === snapshotScope(project, snapshotId) && passed.route_revision === (project.study.route_revision ?? 0)
    && passed.assessment_sequence === result.sequence && passed.target_ids?.length === result.targetIds.length
    && result.targetIds.every(id => passed.target_ids!.includes(id)));
}

function writeCoverage(project: Project, step: SnapshotLearningStep, snapshotId?: string): TargetCoverageResult {
  const result = targetCoverageForStep(project, step, snapshotId);
  const proven = Object.values(result.coverage).filter(target => target.proven);
  project.study.mastered_target_items = proven.map(target => target.label);
  project.study.mastered_target_evidence = Object.fromEntries(proven.map(target => [target.target_id, [...target.evidence_ids]]));
  project.study.step_passed = result.stepPassed ? {
    proof_version: 1, target_ids: result.targetIds, step_id: step.step_id,
    mastered_items: proven.map(target => target.label), evidence_ids: [...new Set(proven.flatMap(target => target.evidence_ids))],
    snapshot_id: snapshotScope(project, snapshotId)!, route_revision: project.study.route_revision ?? 0,
    assessment_sequence: result.sequence,
  } : null;
  return result;
}

/** Lazy compatibility: preserve historical data, but derive current authority only from new proofs. */
export function normalizeTargetCoverage(project: Project, step?: SnapshotLearningStep, snapshotId?: string): void {
  const current = step ?? project.study.dynamic_learning_plan?.[project.study.current_step];
  if (!current) {
    project.study.step_passed = null;
    project.study.mastered_target_items = [];
    project.study.mastered_target_evidence = {};
    return;
  }
  current.learning_target_defs ??= targetsForStep(current);
  if (project.study.teaching_question?.step_id === current.step_id) {
    try { project.study.teaching_question = normalizeQuestionTargets(project.study.teaching_question, current); }
    catch { /* Keep an incompatible historical question for display; it cannot be assessed. */ }
  }
  writeCoverage(project, current, snapshotId);
}

/** Apply only a qualified candidate. Semantic-review commit eligibility belongs to the caller. */
export function applyTargetAssessment(project: Project, question: TeachingQuestion, messageId: string,
  answerParts: readonly string[], targetResults: readonly TeachingTargetResult[], step?: SnapshotLearningStep,
  questionResult?: TeachingQuestionResult): TargetCoverageResult {
  const current = step ?? project.study.dynamic_learning_plan?.[project.study.current_step];
  if (!current || (project.study.dynamic_learning_plan?.length
    && project.study.dynamic_learning_plan[project.study.current_step]?.step_id !== current.step_id)
    || current.step_id !== question.step_id || question.snapshot_id !== snapshotScope(project)
    || question.route_revision !== (project.study.route_revision ?? 0) || question.created_message_id === messageId)
    throw new Error('target_assessment_scope_mismatch');
  const normalized = normalizeQuestionTargets(question, current);
  const displayedMessage = project.messages.find(row => {
    const displayed = qualifiedQuestionMessage(project, row, current, messageId);
    return displayed && sameQuestionBinding(normalized, displayed);
  });
  if (!displayedMessage) throw new Error('target_assessment_question_not_displayed');
  const message = project.messages.find(message => message.message_id === messageId && message.role === 'user');
  if (!message || !answerParts.length || answerParts.some(part => !part.trim() || !message.content.includes(part)))
    throw new Error('target_assessment_answer_source_mismatch');
  const supports = qualifiedQuestionSupportsForAssessment(project, normalized, current, messageId);
  const allowedIds = new Set(question.evidence.map(row => row.stable_id));
  const errors = targetResultValidationErrors(normalized, answerParts, targetResults, allowedIds, supports);
  if (questionResult) errors.push(...questionResultValidationErrors(normalized, answerParts, questionResult, allowedIds, supports, targetResults));
  if (errors.length) throw new Error(errors.join('; '));
  const existing = project.study.target_assessments ?? [];
  const sameScope = (record: TeachingTargetAssessmentRecord) => record.snapshot_id === question.snapshot_id
    && record.route_revision === question.route_revision && record.step_id === question.step_id;
  const sequence = Math.max(0, ...existing.filter(record => sameScope(record)
    && Number.isSafeInteger(record.sequence) && record.sequence >= 1).map(record => record.sequence)) + 1;
  const record: TeachingTargetAssessmentRecord = {
    question_message_id: displayedMessage.message_id, question_prompt_sha256: hash(question.prompt), question_prompt: question.prompt,
    snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id,
    question_id: question.question_id, message_id: messageId, original_message_id: messageId,
    sequence, answer_parts: [...answerParts], source_message_sha256: hash(message.content),
    target_ids: [...normalized.target_ids!], results: structuredClone([...targetResults]),
    ...(questionResult ? { question_result: structuredClone(questionResult) } : {}),
  };
  project.study.target_assessments = existing.filter(record => !(sameScope(record) && record.message_id === messageId)).concat(record);
  question.target_ids = normalized.target_ids;
  question.target_items = normalized.target_items;
  question.answer_attempts = (question.answer_attempts ?? []).filter(attempt => attempt.message_id !== messageId)
    .concat({ message_id: messageId, original_message_id: messageId, answer_parts: [...answerParts] });
  question.assessment_sequence += 1;
  return writeCoverage(project, current, question.snapshot_id);
}
