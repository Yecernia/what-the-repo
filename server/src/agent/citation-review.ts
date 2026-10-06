import { Type, type Static } from 'typebox';
import { DIRECT_REVIEW_RESULT, answerReviewSections, directReviewGroups, hasSameScopeProof, validateDirectReview, type DirectReviewValue, type ReviewSection } from './direct-citation-review.js';
import { assessmentFindingSubject, assessmentReviewDocument, type AssessmentReviewContext } from './assessment-review-context.js';
import type { EvidenceRef } from '../domain/conversation.js';
import type { ProductStore } from '../persistence/store.js';
import { loadEvidencePackets, type EvidenceCoverage, type CitationCoverage } from './evidence-packets.js';
import { runStructuredWorker } from './structured-worker.js';
import type { PiModelRuntime, PiUsageSummary } from './types.js';
import { combineWorkerDiagnostics, createWorkerDiagnostics, type WorkerDiagnostics } from './worker-diagnostics.js';

export { answerReviewSections } from './direct-citation-review.js';
const ANSWER_COVERAGE = Type.Object({ complete: Type.Boolean(), sections: Type.Array(Type.Object({
  section_id: Type.Integer({ minimum: 0 }), status: Type.Union([Type.Literal('reviewed'), Type.Literal('no_repository_claim'), Type.Literal('unreviewed')]),
  claim_indices: Type.Array(Type.Integer({ minimum: 0 })), evidence_ids: Type.Array(Type.String()),
})), omitted_material: Type.Array(Type.Object({ span: Type.String(), reason: Type.String() })) });
interface DirectReviewRun {
  round: 'first' | 'structural_repair'; value: DirectReviewValue | null;
  attempts: Array<{ value: DirectReviewValue; validationErrors: string[] }>;
  validationErrors: string[]; stopReason: string; usage: PiUsageSummary; diagnostics?: WorkerDiagnostics;
}
export interface CitationReviewResult {
  status: 'reviewed' | 'not_applicable' | 'unverified'; summary: string;
  issues: Array<{ claim: string; reason: string; kind: 'insufficient_evidence' | 'contradicted';
    subject?: 'assessment_judgment' | 'assessment_feedback' }>;
  evidenceIncomplete: boolean; completed: boolean; supported: boolean;
  acceptedEvidenceIds: string[]; unsupportedClaims: string[]; stopReason: string;
  validationErrors?: string[]; diagnostics?: WorkerDiagnostics; coverage?: EvidenceCoverage;
  answerCoverage?: Static<typeof ANSWER_COVERAGE>;
  /** Schema-owned final semantic submissions; never hidden thinking or provider exceptions. */
  semanticReview?: { protocol: 'direct-citation-v1'; sections: ReviewSection[];
    assessment_document?: { text: string; feedbackStart: number };
    groups: Array<{ group_id: number; focus_section_ids: number[]; runs: DirectReviewRun[] }>;
    request_budget: { limit: number; reserved: number; actual: number } };
  usage: PiUsageSummary;
}
const EMPTY_USAGE: PiUsageSummary = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
function zeroRequestDiagnostics(): WorkerDiagnostics { const receipt = createWorkerDiagnostics(); receipt.finish(); return receipt.data; }
/** Never expose provider/exception text through the persisted review or user notice. */
export function unavailableEvidenceReview(reason?: string, answerText?: string): CitationReviewResult {
  const safe = ['cancelled', 'worker_call_limit_exceeded', 'worker_time_limit_exceeded', 'worker_output_limit_exceeded', 'invalid_review_result'].includes(reason ?? '') ? reason! : 'review_unavailable';
  return { status: 'unverified', summary: answerText !== undefined && !/\p{Script=Han}/u.test(answerText)
    ? 'Evidence review could not be completed; treat the related claims as unverified.' : '未能完成证据核对，请将相关说明视为尚未核实。',
    issues: [], evidenceIncomplete: false, completed: false, supported: false, acceptedEvidenceIds: [], unsupportedClaims: [], stopReason: safe, usage: { ...EMPTY_USAGE } };
}
function addUsage(left: PiUsageSummary, right: PiUsageSummary): PiUsageSummary {
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens, cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens, costUsd: left.costUsd + right.costUsd };
}
export async function reviewAnswerEvidence(input: {
  text: string; evidence: EvidenceRef[]; projectId: string; snapshotId: string; store: ProductStore; modelRuntime: PiModelRuntime;
  signal?: AbortSignal; purpose?: 'answer' | 'assessment' | 'question'; assessmentContext?: AssessmentReviewContext;
  citationCoverage?: CitationCoverage; evidenceLimits?: { maxLines?: number; maxCharacters?: number };
}): Promise<CitationReviewResult> {
  const deadlineAt = Date.now() + 420_000;
  const deadlineSignal = AbortSignal.timeout(420_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  const purpose = input.purpose ?? 'answer';
  if (purpose === 'assessment' && !input.assessmentContext) return { ...unavailableEvidenceReview(undefined, input.text),
    stopReason: 'assessment_context_missing', validationErrors: ['assessment_context_missing'], diagnostics: zeroRequestDiagnostics() };
  const assessmentDocument = purpose === 'assessment' && input.assessmentContext ? assessmentReviewDocument(input.text, input.assessmentContext) : null;
  const reviewText = assessmentDocument?.text ?? input.text;
  const sections = answerReviewSections(reviewText);
  if (signal.aborted) return { ...unavailableEvidenceReview('cancelled', input.text), diagnostics: zeroRequestDiagnostics() };
  if (sections.length > 128 || reviewText.length > 128_000) return { ...unavailableEvidenceReview(undefined, input.text),
    stopReason: 'answer_coverage_budget_exceeded', validationErrors: ['answer_coverage_budget_exceeded'], diagnostics: zeroRequestDiagnostics() };
  if (purpose === 'answer' && (!input.text.trim() || /^(?:你好|您好|谢谢|多谢|再见|hi|hello|thanks|thank you|bye)[!！。.\s]*$/iu.test(input.text.trim()))) {
    return { status: 'not_applicable', summary: 'No repository claim to check.', issues: [], evidenceIncomplete: false,
      completed: true, supported: false, acceptedEvidenceIds: [], unsupportedClaims: [], stopReason: 'not_applicable', usage: { ...EMPTY_USAGE },
      diagnostics: zeroRequestDiagnostics(), coverage: { complete: true, packets: [], reasons: [] } };
  }
  let loaded: Awaited<ReturnType<typeof loadEvidencePackets>>;
  try { loaded = await loadEvidencePackets({ ...input, ...input.evidenceLimits, signal }); }
  catch (error) {
    if (signal.aborted) return { ...unavailableEvidenceReview(input.signal?.aborted ? 'cancelled' : 'worker_time_limit_exceeded', input.text), diagnostics: zeroRequestDiagnostics() };
    throw error;
  }
  const packets = loaded.packets;
  const coverage: EvidenceCoverage = { ...loaded.coverage,
    ...(input.citationCoverage ? { citations: input.citationCoverage } : {}),
    reasons: [...new Set([...loaded.coverage.reasons, ...(input.citationCoverage?.references.flatMap(ref => ref.reason ? [ref.reason] : []) ?? []),
      ...(!packets.length ? ['missing_citation' as const] : [])])] };
  coverage.complete = loaded.coverage.complete && !coverage.reasons.length && !input.citationCoverage?.references.some(ref => !ref.resolved);
  const incomplete = loaded.incomplete || Boolean(input.citationCoverage?.references.some(ref => !ref.resolved));
  if (coverage.reasons.includes('budget_exceeded') || coverage.reasons.includes('invalid_reference') || (purpose !== 'answer' && !packets.length)) {
    const reason = coverage.reasons.includes('budget_exceeded') ? 'evidence_budget_exceeded' : coverage.reasons.includes('invalid_reference') ? 'invalid_reference' : 'missing_citation';
    return { ...unavailableEvidenceReview(undefined, input.text), evidenceIncomplete: true, stopReason: reason, validationErrors: [reason], coverage, diagnostics: zeroRequestDiagnostics() };
  }
  const groups: NonNullable<CitationReviewResult['semanticReview']>['groups'] = directReviewGroups(sections, reviewText.length)
    .map((focus_section_ids, group_id) => ({ group_id, focus_section_ids, runs: [] }));
  let reserved = 0;
  const execute = async (group: (typeof groups)[number], round: DirectReviewRun['round']) => {
    if (reserved >= 6 || signal.aborted || Date.now() >= deadlineAt) return;
    reserved++;
    const attempts: DirectReviewRun['attempts'] = [];
    const previous = group.runs.at(-1);
    const locked = round === 'structural_repair' ? (previous?.value?.sections ?? []).filter(row =>
      group.focus_section_ids.includes(row.section_id)
      && !validateDirectReview({ sections: [row] }, reviewText, sections, [row.section_id], packets, 'answer').length) : [];
    const validate = (value: DirectReviewValue) => [...validateDirectReview(value, reviewText, sections, group.focus_section_ids, packets, purpose),
      ...(locked.some(row => JSON.stringify(value.sections.find(candidate => candidate.section_id === row.section_id)) !== JSON.stringify(row))
        ? ['review_repair_changed_valid_section'] : [])];
    const result = await runStructuredWorker({
      skillId: 'citation-review', inputSchemaId: 'citation-review-input-v15', outputSchemaId: 'citation-review-output-v14', contextBuilderId: 'citation-review-context-v27',
      modelRuntime: input.modelRuntime, signal, thinkingLevel: 'medium', schema: DIRECT_REVIEW_RESULT, maxSubmitAttempts: 1,
      taskLimits: { maxRequests: 1, timeoutMs: Math.max(1, Math.min(360_000, deadlineAt - Date.now())), maxOutputTokens: 65_536 },
      validateSubmitted: value => { const errors = validate(value);
        attempts.push({ value: structuredClone(value), validationErrors: errors }); return errors; },
      systemPrompt: [
        'task_phase=direct_review. You alone make FINAL semantic judgments for every material assertion in each focus_section_id. Compare the exact original answer directly with original evidence; no intermediate claim extraction, source-case analyzer, second judge or execution matrix.',
        'final_answer is the complete original language, retained ONCE. answer_sections contains only lossless offsets; focus_section_ids assigns responsibility. All outside sections remain interpretation context. Review every assertion of focal paragraphs/list items under its actual subject, quantifier, phase and conditions. State only final outcome and concise grounds.',
        'For a finding copy an exact original span, describe its actual assertion/conditions and explain concrete same-condition source counterevidence or the actual source gap. Complete source IDs and matching proof layers establish provenance only, not semantic entailment. Unfinished review is unverified; missing source is insufficient_evidence; positive same-scope counterevidence is contradicted.',
        'For teaching assess exact repository premises, answerability and bound hypothetical/state provenance. Bound assessment_context is not source evidence. purpose=' + purpose,
        ...(assessmentDocument ? ['The candidate assessment record contains judgments to verify, not established facts. Check whether the actual saved question requirements and whole learning targets are supported by the learner originals in assessment_context and the source. Then check the owner feedback. Incomplete learning is not itself an error in a judgment that correctly records it. Do not replace learner evidence with assistant knowledge.'] : []),
        ...(round === 'structural_repair' ? ['Correct only the reported submission structure. Preserve completed semantic findings; never resample a negative judgment to seek support.'] : []),
      ].join('\n'),
      userPrompt: JSON.stringify({ task_phase: 'direct_review', final_answer: reviewText, answer_sections: sections, focus_section_ids: group.focus_section_ids,
        evidence: packets, purpose, ...(assessmentDocument ? { assessment_context: assessmentDocument.premises } : {}),
        ...(round === 'structural_repair' ? { structural_repair: { candidate: previous?.value ?? null, locked_section_ids: locked.map(row => row.section_id), errors: previous?.validationErrors ?? [],
          schema_errors: previous?.diagnostics?.toolDispatches?.flatMap(item => item.schemaErrors ?? []) ?? [] } } : {}) }),
    });
    const errors = result.value ? validate(result.value) : [];
    group.runs.push({ round, value: result.value ? structuredClone(result.value) : null, attempts, validationErrors: errors.length ? errors
      : result.validationErrors.length ? ['invalid_direct_review_schema'] : [], stopReason: result.stopReason, usage: result.usage, diagnostics: result.diagnostics });
  };
  await Promise.all(groups.map(group => execute(group, 'first')));
  // One bounded repair per invalid submission. No retries for truncation, timeout, provider failure, valid gaps or negatives.
  for (const group of groups) {
    const run = group.runs.at(-1);
    const truncated = run?.stopReason === 'worker_output_limit_exceeded' || run?.diagnostics?.requests.some(request => request.completionReason === 'length');
    // SDK shape rejection supplies no schema-owned candidate. A fresh generation would be semantic resampling, not repair.
    const invalid = run?.value && run.stopReason === 'completed_with_validation_errors' && run.validationErrors.length;
    if (invalid && !truncated) await execute(group, 'structural_repair');
  }
  const valid = (run: DirectReviewRun | undefined): run is DirectReviewRun & { value: DirectReviewValue } => Boolean(run?.value && run.stopReason === 'completed' && !run.validationErrors.length);
  // Retain independently valid final findings even when a sibling row failed structure.
  // A rejected repair cannot overwrite a valid first finding; group completion still requires a valid full submission.
  const accepted = groups.flatMap(group => {
    const rows = new Map<number, DirectReviewValue['sections'][number]>();
    for (const run of group.runs) for (const row of run.value?.sections ?? []) {
      if (!group.focus_section_ids.includes(row.section_id) || rows.has(row.section_id)) continue;
      if (!validateDirectReview({ sections: [row] }, reviewText, sections, [row.section_id], packets, 'answer').length) rows.set(row.section_id, row);
    }
    return [...rows.values()];
  }).sort((a, b) => a.section_id - b.section_id);
  const normalizeIssue = (issue: DirectReviewValue['sections'][number]['issues'][number]) => {
    if (issue.kind !== 'contradicted' || hasSameScopeProof(issue.contradiction_proof, packets)) return { claim: issue.claim, reason: issue.reason, kind: issue.kind };
    return { claim: issue.claim, reason: /\p{Script=Han}/u.test(input.text) ? '已提供的源码片段没有完整、同一证明范围的正面反证；该主张尚未核实。'
      : 'The supplied excerpts do not establish complete positive counterevidence within the same proof scope; this claim remains unverified.', kind: 'insufficient_evidence' as const };
  };
  const issues = accepted.flatMap(row => row.issues.map(issue => ({ ...normalizeIssue(issue),
    ...(assessmentDocument ? { subject: assessmentFindingSubject(assessmentDocument, sections[row.section_id]!, issue.claim) } : {}) })));
  const teachingConflict = purpose !== 'answer' && accepted.length === sections.length && accepted.every(row => row.outcome === 'no_repository_claim');
  const completed = groups.every(group => valid(group.runs.at(-1))) && accepted.length === sections.length && !accepted.some(row => row.outcome === 'unverified') && !teachingConflict;
  const allNonClaims = completed && accepted.every(row => row.outcome === 'no_repository_claim');
  if (allNonClaims) { coverage.reasons = coverage.reasons.filter(reason => reason !== 'missing_citation'); coverage.complete = !incomplete && !coverage.reasons.length; }
  const supported = completed && !allNonClaims && coverage.complete && !incomplete && !issues.length && accepted.every(row => row.outcome === 'supported' || row.outcome === 'no_repository_claim');
  const runs = groups.flatMap(group => group.runs);
  const diagnostics = combineWorkerDiagnostics(runs.flatMap(run => run.diagnostics ? [run.diagnostics] : []).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) ?? zeroRequestDiagnostics();
  const usage = runs.reduce((total, run) => addUsage(total, run.usage), { ...EMPTY_USAGE });
  const failed = groups.find(group => !valid(group.runs.at(-1)))?.runs.at(-1);
  const unresolved = accepted.some(row => row.outcome === 'unverified');
  const stopReason = !completed ? failed?.stopReason === 'completed_with_validation_errors' ? 'invalid_review_result' : failed?.stopReason
    ?? (signal.aborted ? input.signal?.aborted ? 'cancelled' : 'worker_time_limit_exceeded' : 'review_not_completed')
    : allNonClaims ? 'not_applicable' : !packets.length ? 'no_evidence' : 'completed';
  return { status: !completed || incomplete || !coverage.complete && !allNonClaims ? 'unverified' : allNonClaims ? 'not_applicable' : 'reviewed',
    summary: accepted.map(row => row.basis).join(' ').slice(0, 500) || unavailableEvidenceReview(undefined, input.text).summary,
    issues, evidenceIncomplete: incomplete, completed, supported, acceptedEvidenceIds: [...new Set(accepted.flatMap(row => row.evidence_ids))],
    unsupportedClaims: [...new Set(issues.map(issue => issue.claim))], stopReason: unresolved && !failed ? 'source_review_incomplete' : stopReason,
    validationErrors: [...new Set([...groups.flatMap(group => group.runs.at(-1)?.validationErrors ?? ['review_not_completed']), ...(unresolved ? ['source_review_incomplete'] : []), ...(teachingConflict ? ['teaching_subject_not_reviewed'] : [])])],
    coverage, answerCoverage: { complete: completed, sections: sections.map(section => {
      const row = accepted.find(row => row.section_id === section.section_id);
      return { section_id: section.section_id, status: !row || row.outcome === 'unverified' ? 'unreviewed' : row.outcome === 'no_repository_claim' ? 'no_repository_claim' : 'reviewed',
        claim_indices: row && row.outcome !== 'no_repository_claim' && row.outcome !== 'unverified' ? [section.section_id] : [], evidence_ids: row?.evidence_ids ?? [] };
    }), omitted_material: sections.filter(section => !accepted.some(row => row.section_id === section.section_id && row.outcome !== 'unverified')).map(section => ({
      span: reviewText.slice(section.start, section.end), reason: accepted.find(row => row.section_id === section.section_id)?.basis ?? 'The assigned review did not complete.' })) },
    usage, diagnostics, semanticReview: { protocol: 'direct-citation-v1', sections, groups,
      ...(assessmentDocument ? { assessment_document: { text: assessmentDocument.text, feedbackStart: assessmentDocument.feedbackStart } } : {}),
      request_budget: { limit: 6, reserved, actual: diagnostics.requestCount } } };
}
