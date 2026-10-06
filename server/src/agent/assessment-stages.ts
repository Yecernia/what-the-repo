import { Type, type Static } from 'typebox';
import type { TeachingFeedbackScope, TeachingQuestion, TeachingQuestionRequirement, TeachingQuestionResult, TeachingTargetAssessmentRecord, TeachingTargetResult } from './teaching-question.js';
import type { LearningTargetDefinition } from '../domain/snapshot.js';
import { assessmentFeedbackScope, feedbackScopeValidationErrors, questionResultFromRequirements, questionResultValidationErrors, targetResultValidationErrors, type TargetCoverageResult } from './target-coverage.js';
import { runStructuredWorker } from './structured-worker.js';
import type { PiModelRuntime, PiUsageSummary } from './types.js';
import { combineWorkerDiagnostics, type WorkerDiagnostics } from './worker-diagnostics.js';

const REQUIREMENT = Type.Object({ prompt_span: Type.String({ minLength: 1, maxLength: 2000 }),
  target_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 6 }),
  outcome: Type.Union([Type.Literal('satisfied'), Type.Literal('missing'), Type.Literal('contradicted'), Type.Literal('not_selected')]),
  answer_spans: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 8 }),
  prior_answer_message_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 12 }),
  evidence_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 10 }), reason: Type.String({ minLength: 1, maxLength: 600 }) });
export const ASSESSMENT_SEMANTIC = Type.Object({ answer_relevant: Type.Boolean(), feedback: Type.String({ minLength: 1, maxLength: 1200 }),
  misconceptions: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 6 }),
  question_requirements: Type.Array(REQUIREMENT, { minItems: 1, maxItems: 12 }),
  target_results: Type.Array(Type.Object({ target_id: Type.String({ minLength: 1, maxLength: 256 }),
    outcome: Type.Union([Type.Literal('proven'), Type.Literal('contradicted'), Type.Literal('unproven'), Type.Literal('not_addressed')]),
    reason: Type.String({ minLength: 1, maxLength: 600 }), answer_spans: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 8 }),
    evidence_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 10 }),
    prior_answer_message_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 12 })) }), { minItems: 1, maxItems: 6 }),
}, { additionalProperties: false });
const FEEDBACK_ONLY = Type.Object({ feedback: Type.String({ minLength: 1, maxLength: 1200 }) }, { additionalProperties: false });
export interface AssessmentValue { answer_relevant: boolean; feedback: string; misconceptions: string[]; verdict: string;
  mastered_items: string[]; evidence_ids: string[]; question_result: TeachingQuestionResult; target_results: TeachingTargetResult[]; feedback_scope: TeachingFeedbackScope }
export interface FeedbackRepair { feedback: string; offendingSpans: string[]; verdict: string; answerRelevant: boolean;
  masteredItems: string[]; misconceptions: string[]; evidenceIds: string[]; targetResults: TeachingTargetResult[];
  feedbackScope: TeachingFeedbackScope; questionResult?: TeachingQuestionResult;
  evidenceIssues?: Array<{ claim: string; reason: string; kind: string }>; validationErrors?: string[] }
export interface AssessmentStageTrace { phase: 'semantic_assessment' | 'feedback_repair'; completed: boolean;
  stop_reason: string; usage: PiUsageSummary; diagnostics?: WorkerDiagnostics; semantic_result: unknown;
  validation_errors: Array<{ code: string; field: string }>;
  submissions?: Array<{ semantic_result: unknown; validation_errors: Array<{ code: string; field: string }> }>; }

function derive(input: { question: TeachingQuestion; targets: LearningTargetDefinition[]; prior: TargetCoverageResult },
  semantic: { answer_relevant: boolean; feedback: string; misconceptions: string[]; question_requirements: TeachingQuestionRequirement[]; target_results: TeachingTargetResult[] }): AssessmentValue {
  const qr = questionResultFromRequirements(semantic.question_requirements);
  const evidenceIds = [...new Set([...qr.requirements.flatMap(requirement => requirement.evidence_ids), ...semantic.target_results.flatMap(result => result.evidence_ids)])];
  const verdict = !semantic.answer_relevant || !evidenceIds.length ? 'unclear'
    : qr.requirements.some(requirement => requirement.outcome === 'contradicted') ? 'misconception' : qr.complete ? 'mastered' : 'partial';
  return { answer_relevant: semantic.answer_relevant, feedback: semantic.feedback, misconceptions: semantic.misconceptions,
    question_result: qr, target_results: semantic.target_results, verdict, evidence_ids: evidenceIds,
    mastered_items: input.targets.filter(target => semantic.target_results.some(result => result.target_id === target.target_id && result.outcome === 'proven')).map(target => target.label),
    feedback_scope: assessmentFeedbackScope(input.prior, input.question, semantic.target_results, qr) };
}

export async function runAssessmentStages(input: { question: TeachingQuestion; targets: LearningTargetDefinition[]; prior: TargetCoverageResult;
  answerParts: string[]; priorSupports: TeachingTargetAssessmentRecord[];
  allowedIds: ReadonlySet<string>; context: Record<string, unknown>; modelRuntime: PiModelRuntime; signal?: AbortSignal; feedbackRepair?: FeedbackRepair }) {
  const usage: PiUsageSummary = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const stages: AssessmentStageTrace[] = [];
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(input.feedbackRepair ? 20_000 : 120_000)]);
  const common = { skillId: 'understanding-assessment' as const, inputSchemaId: 'understanding-assessment-input-v7',
    outputSchemaId: 'understanding-assessment-output-v6', contextBuilderId: 'understanding-assessment-context-v13', modelRuntime: input.modelRuntime,
    thinkingLevel: 'medium' as const, signal };
  const validate = (value: AssessmentValue, checkLockedScope = false) => {
    const errors = targetResultValidationErrors(input.question, input.answerParts, value.target_results, input.allowedIds, input.priorSupports);
    errors.push(...questionResultValidationErrors(input.question, input.answerParts, value.question_result, input.allowedIds, input.priorSupports, value.target_results));
    // Locally derived scope needs no self-comparison. A locked external repair
    // crosses a trust boundary and must still match the original judgments.
    if (!errors.length && checkLockedScope) errors.push(...feedbackScopeValidationErrors(assessmentFeedbackScope(input.prior, input.question, value.target_results, value.question_result), value.feedback_scope));
    if (value.evidence_ids.some(id => !input.allowedIds.has(id))) errors.push('assessment_evidence_not_in_complete_question_packet');
    if ([...value.question_result.requirements.flatMap(requirement => requirement.evidence_ids), ...value.target_results.flatMap(target => target.evidence_ids)]
      .some(id => !value.evidence_ids.includes(id))) errors.push('assessment_evidence_must_cover_semantic_results');
    if ((!value.answer_relevant || value.verdict === 'unclear') && value.target_results.some(result => result.outcome === 'proven' || result.outcome === 'contradicted'))
      errors.push('irrelevant_or_unclear_answer_cannot_prove_or_contradict_targets');
    return errors;
  };
  const record = (phase: AssessmentStageTrace['phase'], result: { usage: PiUsageSummary; diagnostics?: WorkerDiagnostics; value: unknown; stopReason: string; validationErrors: string[] }, attempts: AssessmentStageTrace['validation_errors'] = []) => {
    for (const key of Object.keys(usage) as Array<keyof PiUsageSummary>) usage[key] += result.usage[key];
    const completed = result.stopReason === 'completed' && !result.validationErrors.length && result.value !== null;
    stages.push({ phase, completed, stop_reason: result.stopReason, usage: result.usage, diagnostics: result.diagnostics,
      semantic_result: result.value, validation_errors: attempts });
    return completed;
  };
  const diagnosticsFor = (errors: string[]) => errors.map(error => {
    const known: Array<[string, string, string]> = [
      ['answer_spans', 'exact_current_span', 'target_results.answer_spans'], ['current answer spans', 'exact_current_span', 'question_requirements.answer_spans'],
      ['prompt_span', 'exact_saved_prompt', 'question_requirements.prompt_span'], ['evidence', 'complete_packet_evidence', error.startsWith('target_results:') ? 'target_results.evidence_ids' : 'question_requirements.evidence_ids'],
      ['prior proof', 'qualified_prior_source', 'target_results.prior_answer_message_ids'], ['prior answer', 'qualified_same_question_source', 'question_requirements.prior_answer_message_ids'],
      ['cover each bound', 'target_correspondence', 'target_results.target_id'], ['unknown or out-of-question', 'target_scope', 'target_results.target_id'],
      ['contradicted constituent', 'constituent_contradiction', 'target_results.outcome'], ['requirement binding', 'requirement_binding', 'question_requirements.target_ids'],
    ];
    const match = known.find(([needle]) => error.includes(needle));
    return match ? { code: match[1], field: match[2] } : { code:
      error.startsWith('target_results:') ? 'target_result_shape' : error.startsWith('question_result:') ? 'question_requirement_shape' : error.split(':')[0]!,
      field: 'assessment' };
  });
  let value: AssessmentValue | null = null;
  let last: { skillVersion: string; model?: string; provider?: string; diagnostics?: WorkerDiagnostics } | null = null;
  let successful = false;
  const repair = async (fixed: AssessmentValue, reason: Record<string, unknown>, external: FeedbackRepair) => {
    const attempts: AssessmentStageTrace['validation_errors'] = [];
    const submissions: NonNullable<AssessmentStageTrace['submissions']> = [];
    const result = await runStructuredWorker({ ...common, schema: FEEDBACK_ONLY,
      taskLimits: { maxRequests: 2, timeoutMs: 20_000, maxOutputTokens: 4096 },
      systemPrompt: 'task_phase=feedback_repair. Submit ONLY {feedback}, consistent with locked fixed_assessment and the listed findings. Keep actual question completion separate from remaining whole-target learning. Use only this block evidence for mechanism assertions; do not rescore or offer actions. Be concise and submit directly.',
      userPrompt: JSON.stringify({ ...input.context, task_phase: 'feedback_repair', fixed_assessment: fixed, feedback_to_repair: fixed.feedback, ...reason }),
      validateSubmitted: submitted => { const errors = validate({ ...fixed, feedback: submitted.feedback }, true);
        if (!external.evidenceIssues?.length && external.offendingSpans.some(span => submitted.feedback.includes(span)))
          errors.push('feedback_repair_retained_action');
        attempts.push(...diagnosticsFor(errors)); submissions.push({ semantic_result: submitted, validation_errors: diagnosticsFor(errors) }); return errors; },
    });
    last = result; successful = record('feedback_repair', result, attempts);
    stages.at(-1)!.submissions = submissions;
    if (result.value) value = { ...fixed, feedback: result.value.feedback };
  };
  if (input.feedbackRepair) {
    const fixed = input.feedbackRepair;
    if (fixed.questionResult) { value = { answer_relevant: fixed.answerRelevant, verdict: fixed.verdict, feedback: fixed.feedback,
      mastered_items: fixed.masteredItems, misconceptions: fixed.misconceptions, evidence_ids: fixed.evidenceIds,
      question_result: fixed.questionResult, target_results: fixed.targetResults, feedback_scope: fixed.feedbackScope };
      await repair(value, { offending_spans: fixed.offendingSpans, evidence_review_findings: fixed.evidenceIssues ?? [], validation_errors: fixed.validationErrors ?? [] }, fixed); }
  } else {
    const attempts: AssessmentStageTrace['validation_errors'] = [];
    const submissions: NonNullable<AssessmentStageTrace['submissions']> = [];
    const result = await runStructuredWorker({ ...common, schema: ASSESSMENT_SEMANTIC, taskLimits: { maxRequests: 2, timeoutMs: 120_000, maxOutputTokens: 12288 },
      systemPrompt: 'task_phase=semantic_assessment. question_requirements assess the cumulative ACTUAL saved prompt, using current_answer_parts or qualified same-question prior refs. target_results assess CURRENT contributions to each full target. Follow every target current_result_duty: when prior_status=proven and the current answer supplies no new proof/contradiction, return not_addressed with empty current spans/evidence; the program preserves the old proof. Historical originals are NEVER current answer_spans. Return the five schema fields and each target once. Quote short decisive exact spans; use evidence IDs only from complete current packets. A narrow question can be fully answered without proving the full broad target. Keep feedback concise; submit directly once these judgments are ready.',
      userPrompt: JSON.stringify({ ...input.context, task_phase: 'semantic_assessment' }),
      validateSubmitted: submitted => {
        const errors = targetResultValidationErrors(input.question, input.answerParts, submitted.target_results, input.allowedIds, input.priorSupports);
        errors.push(...questionResultValidationErrors(input.question, input.answerParts, questionResultFromRequirements(submitted.question_requirements),
          input.allowedIds, input.priorSupports, submitted.target_results));
        if (!errors.length) errors.push(...validate(derive(input, submitted)));
        attempts.push(...diagnosticsFor(errors));
        submissions.push({ semantic_result: submitted, validation_errors: diagnosticsFor(errors) }); return errors; },
    });
    last = result; successful = record('semantic_assessment', result, attempts);
    stages.at(-1)!.submissions = submissions;
    if (successful && result.value) value = derive(input, result.value);
  }
  return { value, usage, stages, skillVersion: last?.skillVersion ?? 'input-rejected', model: last?.model, provider: last?.provider,
    diagnostics: combineWorkerDiagnostics(stages.flatMap(stage => stage.diagnostics ? [stage.diagnostics] : [])),
    stopReason: successful ? 'completed' : stages.at(-1)?.stop_reason ?? 'feedback_repair_missing_question_result',
    validationErrors: successful ? [] : ['assessment_stage_failed'] };
}
