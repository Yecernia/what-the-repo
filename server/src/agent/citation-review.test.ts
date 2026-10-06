import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createModels, type Api, type Context, type Model } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ProductStore } from '../persistence/store.js';
import type { EvidencePacket } from './evidence-packets.js';
import { reviewAnswerEvidence, unavailableEvidenceReview } from './citation-review.js';
import { answerReviewSections, directReviewGroups, validateDirectReview, type DirectReviewValue, type ReviewSection } from './direct-citation-review.js';
import { withEvidenceReviewNotice } from './citations.js';
import { assessmentFindingSubject, assessmentReviewDocument, type AssessmentReviewContext } from './assessment-review-context.js';
const text = '**The function returns input.**';
const refs = [{ stable_id: 'entry', label: 'entry', kind: 'source_excerpt' as const, path: 'src/main.ts', start_line: 1, end_line: 1, snapshot_id: 'snapshot' }];
const store = { readSourceLines: async () => ({ lines: ['return input;'], truncated: false }) } as unknown as ProductStore;
const base = { text, evidence: refs, projectId: 'project', snapshotId: 'snapshot', store };
interface Payload { task_phase: string; final_answer: string; answer_sections: ReviewSection[]; focus_section_ids: number[];
  evidence: EvidencePacket[]; purpose: string; assessment_context?: unknown; structural_repair?: { candidate: unknown; errors: string[] } }
function payload(context: Context): Payload {
  const user = context.messages.find(message => message.role === 'user'); assert.ok(Array.isArray(user?.content));
  const part = user.content.find(part => part.type === 'text'); assert.ok(part?.type === 'text'); return JSON.parse(part.text);
}
// All faux conclusions are supplied outcomes. These tests verify protocols and gates, never semantic model accuracy.
function positive(input: Payload): DirectReviewValue { return { sections: input.focus_section_ids.map(section_id => ({ section_id, outcome: 'supported', basis: 'Controlled source comparison.',
  evidence_ids: [input.evidence.find(packet => !packet.incomplete && packet.excerpt.length)?.evidence_id ?? 'missing'], issues: [] })) }; }
function gap(input: Payload): DirectReviewValue { return { sections: input.focus_section_ids.map(section_id => ({ section_id, outcome: 'insufficient_evidence', basis: 'The source is missing.', evidence_ids: [],
  issues: [{ claim: input.final_answer.slice(input.answer_sections[section_id]!.start, input.answer_sections[section_id]!.end), actual_assertion: 'Controlled source assertion.', conditions: 'Original conditions.', reason: 'Missing evidence.', kind: 'insufficient_evidence' }] })) }; }
function negative(input: Payload, claim = text, proof: Record<string, unknown> | null = { evidence_id: 'entry', excerpt: 'return input;', claim_scope: 'javascript_runtime', evidence_scope: 'javascript_runtime' }): DirectReviewValue {
  const value = positive(input); const row = value.sections.find(row => input.final_answer.slice(input.answer_sections[row.section_id]!.start, input.answer_sections[row.section_id]!.end).includes(claim))!;
  row.outcome = 'contradicted'; row.issues = [{ claim, actual_assertion: 'Controlled actual assertion.', conditions: 'Original condition.', counterevidence: 'Controlled different source result.', reason: 'Controlled same-condition counterexample.', kind: 'contradicted',
    ...(proof ? { contradiction_proof: proof as never } : {}) }]; return value;
}
function runtime(response: (input: Payload, call: number) => Record<string, unknown>) {
  const faux = fauxProvider({ provider: 'direct-citation-fixture' }); const models = createModels(); models.setProvider(faux.provider); let calls = 0;
  faux.setResponses(Array.from({ length: 8 }, () => context => fauxAssistantMessage(fauxToolCall('submit_result', response(payload(context), calls++)))));
  return { modelRuntime: { models, model: faux.getModel() as Model<Api> }, calls: () => calls };
}
test('unavailable notice localizes without exposing private errors', () => {
  for (const answer of ['这是仓库说明。', 'Repository explanation.']) { const review = unavailableEvidenceReview('secret <script>', answer);
    assert.doesNotMatch(withEvidenceReviewNotice(answer, review), /secret|script/); assert.equal(review.stopReason, 'review_unavailable'); }
});
test('direct review contains complete original once and original source packets', async () => {
  const rt = runtime(input => { assert.equal(input.task_phase, 'direct_review'); assert.equal(input.final_answer, text);
    assert.deepEqual(input.answer_sections, [{ section_id: 0, start: 0, end: text.length }]); assert.deepEqual(input.focus_section_ids, [0]);
    assert.equal(input.evidence[0]!.excerpt[0], 'return input;'); assert.equal(JSON.stringify(input).split(text).length - 1, 1);
    assert.equal(Object.hasOwn(input, 'focus_claims'), false); assert.equal(Object.hasOwn(input, 'answer_units'), false); return positive(input); });
  const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime }); assert.equal(result.supported, true); assert.equal(result.completed, true);
  assert.equal(rt.calls(), 1); assert.equal(result.diagnostics?.requestCount, 1); assert.equal(result.answerCoverage?.complete, true); assert.deepEqual(result.answerCoverage?.sections[0]?.evidence_ids, ['entry']);
});

test('review grants 64K output while respecting a smaller configured model ceiling', async () => {
  for (const [configured, expected] of [[131_072, 65_536], [16_384, 16_384]] as const) {
    const faux = fauxProvider({ provider: 'review-output-allowance-' + configured });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([(context, options) => {
      assert.equal(options?.maxTokens, expected);
      const original = payload(context);
      assert.equal(original.final_answer, text);
      assert.equal(original.evidence[0]!.excerpt[0], 'return input;');
      return fauxAssistantMessage(fauxToolCall('submit_result', positive(original)));
    }]);
    const result = await reviewAnswerEvidence({ ...base,
      modelRuntime: { models, model: { ...faux.getModel(), maxTokens: configured } as Model<Api> } });
    assert.equal(result.completed, true);
    assert.equal(result.supported, true);
    assert.equal(faux.state.callCount, 1);
  }
});
test('paragraph and complete list-item offsets retain continuation lines, code fences and emoji without truncation', () => {
  const answer = '  Intro 😀.\n\n- First item.\n  continued sentence.\n\n  ```ts\n  x();\n\n  y();\n  ```\n- Second item.\n\n' + 'Long 😀 '.repeat(600);
  const sections = answerReviewSections(answer); assert.equal(sections.map(section => answer.slice(section.start, section.end)).join(''), answer);
  assert.equal(sections[0]!.start, 0); assert.equal(sections.at(-1)!.end, answer.length);
  assert.ok(sections.some(section => answer.slice(section.start, section.end).includes('```ts\n  x();\n\n  y();\n  ```')));
  assert.ok(sections.some(section => answer.slice(section.start, section.end).includes('- First item.\n  continued sentence.')));
  assert.ok(sections.at(-1)!.end - sections.at(-1)!.start > 1000);
});
for (const [name, mutate, error] of [
  ['missing assigned section', (value: DirectReviewValue) => { value.sections = []; }, 'review_section_accounting'],
  ['duplicate assigned section', (value: DirectReviewValue) => { value.sections.push(structuredClone(value.sections[0]!)); }, 'review_section_accounting'],
  ['invented source', (value: DirectReviewValue) => { value.sections[0]!.evidence_ids = ['invented']; }, 'invalid_accepted_evidence_id'],
  ['unsupported positive', (value: DirectReviewValue) => { value.sections[0]!.evidence_ids = []; }, 'review_support_without_proof'],
] as const) test('explicit invalid submission repairs only structure: ' + name, async () => {
  const rt = runtime((input, call) => { const value = positive(input); if (!call) mutate(value); else assert.ok(input.structural_repair?.errors.includes(error)); return value; });
  const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime }); assert.equal(result.supported, true); assert.equal(rt.calls(), 2);
  const runs = result.semanticReview!.groups[0]!.runs; assert.equal(runs.length, 2); assert.ok(runs[0]!.attempts[0]!.validationErrors.includes(error)); assert.deepEqual(runs[1]!.validationErrors, []);
});
test('unfixed exact span failure keeps first value and never authorizes support', async () => {
  const rt = runtime(input => { const value = negative(input); value.sections[0]!.issues[0]!.claim = 'Paraphrased claim.'; return value; });
  const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime }); assert.equal(result.supported, false); assert.equal(result.completed, false);
  assert.equal(rt.calls(), 2); assert.ok(result.validationErrors?.includes('claim_not_in_focus_section')); assert.equal(result.answerCoverage?.sections[0]!.status, 'unreviewed');
});
test('an issue cannot belong to another focal paragraph', () => {
  const answer = 'First.\n\nSecond.'; const sections = answerReviewSections(answer);
  const value: DirectReviewValue = { sections: [{ section_id: 0, outcome: 'insufficient_evidence', basis: 'Gap.', evidence_ids: [],
    issues: [{ claim: 'Second.', actual_assertion: 'Second assertion.', conditions: 'Original.', reason: 'Missing.', kind: 'insufficient_evidence' }] }] };
  assert.ok(validateDirectReview(value, answer, sections, [0], [], 'answer').includes('claim_not_in_focus_section'));
});
test('valid negative is final and never resampled to support', async () => {
  const rt = runtime((input, call) => call === 0 ? negative(input) : positive(input)); const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime });
  assert.equal(result.completed, true); assert.equal(result.supported, false); assert.equal(result.issues[0]!.kind, 'contradicted'); assert.equal(rt.calls(), 1);
});
test('structural repair cannot change a valid negative because another section was missing', async () => {
  const answer = text + '\n\nAnother source assertion.';
  const rt = runtime((input, call) => {
    const value = negative(input);
    if (!call) value.sections = value.sections.filter(row => row.outcome === 'contradicted');
    else value.sections[0] = positive(input).sections[0]!;
    return value;
  });
  const result = await reviewAnswerEvidence({ ...base, text: answer, modelRuntime: rt.modelRuntime });
  assert.equal(result.completed, false); assert.equal(result.supported, false); assert.equal(rt.calls(), 2);
  assert.ok(result.validationErrors?.includes('review_repair_changed_valid_section'));
  assert.equal(result.semanticReview!.groups[0]!.runs[0]!.value!.sections[0]!.outcome, 'contradicted');
  assert.equal(result.issues[0]!.kind, 'contradicted'); assert.equal(result.issues[0]!.claim, text);
});
for (const [name, proof, kind] of [
  ['missing', null, 'insufficient_evidence'],
  ['invented excerpt', { evidence_id: 'entry', excerpt: 'invented', claim_scope: 'javascript_runtime', evidence_scope: 'javascript_runtime' }, 'insufficient_evidence'],
  ['public/internal boundary', { evidence_id: 'entry', excerpt: 'return input;', claim_scope: 'public_type_contract', evidence_scope: 'internal_implementation' }, 'insufficient_evidence'],
  ['runtime/type boundary', { evidence_id: 'entry', excerpt: 'return input;', claim_scope: 'javascript_runtime', evidence_scope: 'public_type_contract' }, 'insufficient_evidence'],
  ['complete same scope', { evidence_id: 'entry', excerpt: 'return input;', claim_scope: 'javascript_runtime', evidence_scope: 'javascript_runtime' }, 'contradicted'],
] as const) test('positive counterevidence provenance gate: ' + name, async () => {
  const rt = runtime(input => negative(input, text, proof)); const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime });
  assert.equal(result.issues[0]!.kind, kind); assert.equal(result.supported, false); assert.equal(rt.calls(), 1);
});
test('source gap is completed evidence judgment; unverified is incomplete semantic review', async () => {
  const rt = runtime(input => gap(input)); const result = await reviewAnswerEvidence({ ...base, evidence: [], modelRuntime: rt.modelRuntime });
  assert.equal(result.completed, true); assert.equal(result.status, 'unverified'); assert.equal(result.stopReason, 'no_evidence'); assert.equal(result.issues[0]!.kind, 'insufficient_evidence'); assert.equal(rt.calls(), 1);
  const unknown = runtime(input => ({ sections: input.focus_section_ids.map(section_id => ({ section_id, outcome: 'unverified', basis: 'Review unfinished.', evidence_ids: [], issues: [] })) }));
  const incomplete = await reviewAnswerEvidence({ ...base, modelRuntime: unknown.modelRuntime }); assert.equal(incomplete.completed, false); assert.equal(incomplete.supported, false);
  assert.equal(incomplete.stopReason, 'source_review_incomplete'); assert.equal(incomplete.answerCoverage?.sections[0]!.status, 'unreviewed'); assert.equal(unknown.calls(), 1);
});
test('incomplete packet cannot authorize supported semantics', async () => {
  const rt = runtime(input => gap(input)); const result = await reviewAnswerEvidence({ ...base, store: { readSourceLines: async () => { throw Error('private missing'); } } as unknown as ProductStore, modelRuntime: rt.modelRuntime });
  assert.equal(result.evidenceIncomplete, true); assert.equal(result.status, 'unverified'); assert.equal(result.supported, false); assert.deepEqual(result.acceptedEvidenceIds, []); assert.equal(rt.calls(), 1);
});
test('greetings use zero requests; ordinary nonclaim uses one; teaching subjects require review', async () => {
  const nonclaim = (input: Payload): DirectReviewValue => ({ sections: input.focus_section_ids.map(section_id => ({ section_id, outcome: 'no_repository_claim', basis: 'No source assertion.', evidence_ids: [], issues: [] })) });
  const rt = runtime(nonclaim); const greeting = await reviewAnswerEvidence({ ...base, text: '你好！', evidence: [], modelRuntime: rt.modelRuntime }); assert.equal(greeting.status, 'not_applicable'); assert.equal(rt.calls(), 0);
  const ordinary = await reviewAnswerEvidence({ ...base, text: 'Keep exploring.', evidence: [], modelRuntime: rt.modelRuntime }); assert.equal(ordinary.status, 'not_applicable'); assert.equal(ordinary.coverage?.complete, true); assert.equal(rt.calls(), 1);
  const teaching = runtime(nonclaim); const question = await reviewAnswerEvidence({ ...base, purpose: 'question', modelRuntime: teaching.modelRuntime });
  assert.equal(question.completed, false); assert.equal(question.supported, false); assert.ok(question.validationErrors?.includes('teaching_subject_not_reviewed'));
});
const assessmentContext: AssessmentReviewContext = {
  registered_question: { question_id:'q', created_message_id:'ask', snapshot_id:'snapshot',route_revision:1,step_id:'step',
    prompt:'What does entry return?',targets:[{target_id:'return-target',label:'Explain the return value.'}] },
  source_message_id:'answer',current_answer_parts:['It returns input.'],prior_target_coverage:[],
  question_result:{complete:true,requirements:[{prompt_span:'What does entry return?',target_ids:['return-target'],outcome:'satisfied',
    answer_spans:['It returns input.'],prior_answer_message_ids:[],evidence_ids:['entry'],reason:'The learner identified the returned value.'}]},
  target_results:[{target_id:'return-target',outcome:'proven',reason:'The learner identified the returned value.',answer_spans:['It returns input.'],evidence_ids:['entry']}],
};
test('assessment checks immutable judgments and editable feedback as separate document ranges without duplicating the record in premises', async () => {
  const document=assessmentReviewDocument(text,assessmentContext);
  const rt = runtime(input => {
    assert.equal(input.purpose,'assessment');assert.equal(input.final_answer,document.text);
    assert.deepEqual(input.assessment_context,document.premises);
    assert.ok(input.final_answer.includes(JSON.stringify(assessmentContext.question_result)));
    assert.equal(Object.hasOwn(input.assessment_context!,'question_result'),false);
    assert.equal(Object.hasOwn(input.assessment_context!,'target_results'),false);
    assert.equal(input.final_answer.slice(document.feedbackStart),text);
    return positive(input);
  });
  const result=await reviewAnswerEvidence({...base,purpose:'assessment',assessmentContext,modelRuntime:rt.modelRuntime});
  assert.equal(result.supported,true);assert.equal(rt.calls(),1);
  assert.deepEqual(result.semanticReview?.assessment_document,{text:document.text,feedbackStart:document.feedbackStart});
});
test('question purpose keeps original text; assessment without its bound record stops before a model request', async () => {
  const rt=runtime(input=>{assert.equal(input.purpose,'question');assert.equal(input.final_answer,text);assert.equal(input.assessment_context,undefined);return positive(input);});
  assert.equal((await reviewAnswerEvidence({...base,purpose:'question',modelRuntime:rt.modelRuntime})).supported,true);
  const missing=await reviewAnswerEvidence({...base,purpose:'assessment',modelRuntime:rt.modelRuntime});
  assert.equal(missing.stopReason,'assessment_context_missing');assert.equal(missing.supported,false);assert.equal(rt.calls(),1);
});
test('finding ownership follows the selected program range even when identical prose also appears in feedback', async () => {
  const quote=assessmentContext.target_results[0]!.reason;
  const document=assessmentReviewDocument(quote,assessmentContext);
  const sections=answerReviewSections(document.text);
  assert.equal(assessmentFindingSubject(document,sections[0]!,quote),'assessment_judgment');
  assert.equal(assessmentFindingSubject(document,sections.at(-1)!,quote),'assessment_feedback');
  for(const subject of ['assessment_judgment','assessment_feedback'] as const){
    const rt=runtime(input=>{
      const value=positive(input);
      const row=value.sections.find(row=>subject==='assessment_judgment'
        ? input.answer_sections[row.section_id]!.start<document.feedbackStart:input.answer_sections[row.section_id]!.start>=document.feedbackStart)!;
      row.outcome='insufficient_evidence';
      row.issues=[{claim:quote,actual_assertion:'Controlled claim.',conditions:'Controlled.',reason:'Controlled gap.',kind:'insufficient_evidence'}];
      return value;
    });
    const result=await reviewAnswerEvidence({...base,text:quote,purpose:'assessment',assessmentContext,modelRuntime:rt.modelRuntime});
    assert.equal(result.supported,false);assert.equal(result.issues[0]!.subject,subject);assert.equal(rt.calls(),1);
  }
});
test('a finding spanning a judgment and feedback cannot authorize feedback-only repair', () => {
  const document=assessmentReviewDocument(text,assessmentContext);const sections=answerReviewSections(document.text);
  const claim=document.text.slice(document.feedbackStart-5,document.feedbackStart+10);
  assert.equal(assessmentFindingSubject(document,sections.at(-1)!,claim),'assessment_judgment');
});
test('long original has continuous responsibility, at most four parallel first calls and six total including repairs', async () => {
  const answer = Array.from({ length: 16 }, (_, index) => 'Paragraph ' + index + '. ' + 'Original condition. '.repeat(90)).join('\n\n');
  const counts = new Map<number, number>(); const rt = runtime(input => {
    assert.equal(input.final_answer, answer); assert.equal(input.answer_sections.map(section => answer.slice(section.start, section.end)).join(''), answer);
    const first = input.focus_section_ids[0]!; const seen = counts.get(first) ?? 0; counts.set(first, seen + 1); const value = positive(input); if (!seen) value.sections = []; return value;
  });
  const result = await reviewAnswerEvidence({ ...base, text: answer, modelRuntime: rt.modelRuntime }); assert.equal(result.semanticReview!.groups.length, 4); assert.equal(rt.calls(), 6);
  assert.equal(result.supported, false); assert.equal(result.completed, false); assert.deepEqual(result.semanticReview!.groups.flatMap(group => group.focus_section_ids), answerReviewSections(answer).map(section => section.section_id));
  assert.equal(result.semanticReview!.request_budget.actual, 6); assert.deepEqual(result.semanticReview!.groups.map(group => group.runs.length), [2, 2, 1, 1]);
});
test('cancellation and provider failure never trigger semantic resampling', async () => {
  const controller = new AbortController(); controller.abort(); const rt = runtime(positive);
  const cancelled = await reviewAnswerEvidence({ ...base, signal: controller.signal, modelRuntime: rt.modelRuntime }); assert.equal(cancelled.completed, false); assert.equal(rt.calls(), 0);
  const faux = fauxProvider({ provider: 'direct-citation-failure' }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([{ ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: 'private provider failure' }]);
  const failed = await reviewAnswerEvidence({ ...base, modelRuntime: { models, model: faux.getModel() as Model<Api> } }); assert.equal(failed.completed, false); assert.equal(failed.supported, false); assert.equal(failed.semanticReview!.groups[0]!.runs.length, 1);
});
test('output truncation stops without spending repair allowance', async () => {
  const faux = fauxProvider({ provider: 'direct-citation-length' }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([{ ...fauxAssistantMessage('Incomplete output'), stopReason: 'length' }]);
  const result = await reviewAnswerEvidence({ ...base, modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(result.completed, false); assert.equal(result.supported, false); assert.equal(result.diagnostics?.requestCount, 1); assert.equal(result.semanticReview!.groups[0]!.runs.length, 1);
});
test('SDK schema rejection with no retained candidate stops without a new generation', async () => {
  const rt = runtime(input => ({ ...positive(input), legacy_output: true }));
  const result = await reviewAnswerEvidence({ ...base, modelRuntime: rt.modelRuntime });
  assert.equal(result.completed, false); assert.equal(result.supported, false); assert.equal(rt.calls(), 1);
  assert.equal(result.semanticReview!.groups[0]!.runs[0]!.value, null);
  assert.ok(result.semanticReview!.groups[0]!.runs[0]!.diagnostics?.toolDispatches?.some(item => item.schemaErrors?.length));
});
test('coverage budget refuses excessive paragraphs without cutting original tail', async () => {
  const answer = Array.from({ length: 129 }, (_, index) => 'Paragraph ' + index).join('\n\n'); const rt = runtime(positive);
  const result = await reviewAnswerEvidence({ ...base, text: answer, modelRuntime: rt.modelRuntime }); assert.equal(result.stopReason, 'answer_coverage_budget_exceeded'); assert.equal(rt.calls(), 0);
  assert.equal(answerReviewSections(answer).at(-1)!.end, answer.length); assert.ok(directReviewGroups(answerReviewSections(text), text.length).length === 1);
});
const completeFixture = JSON.parse(readFileSync(new URL('../../../eval/cases/citation-complete-answer-quality.json', import.meta.url), 'utf8'));
const counterfactualFixture = JSON.parse(readFileSync(new URL('../../../eval/cases/citation-counterfactual-quality.json', import.meta.url), 'utf8'));
test('independent frozen JS exception oracle preserves completed stages', () => {
  for (const fixture of completeFixture.cases) { const value = JSON.parse(runInNewContext(fixture.source + '\nJSON.stringify({log,caught})', Object.create(null), { timeout: 1000 }));
    assert.deepEqual(value.log, fixture.expected_log, fixture.id); assert.equal(value.caught, fixture.expected_error, fixture.id); }
  assert.equal(completeFixture.corrected_full_output, completeFixture.observed_first_output.replace(completeFixture.required_issue_span, completeFixture.corrected_span));
});
for (const [name, answer, evidence, bad] of [
  ['complete exception negative', completeFixture.observed_first_output, completeFixture.evidence, completeFixture.required_issue_span],
  ['complete exception positive', completeFixture.corrected_full_output, completeFixture.evidence, null],
  ['complete counterfactual negative', counterfactualFixture.retained_observations[0].observed_first_output, counterfactualFixture.retained_observations[0].evidence, counterfactualFixture.retained_observations[0].expected_review.required_issue_span],
] as const) test('fixed full original transport and controlled verdict: ' + name, async () => {
  const rt = runtime(input => { assert.equal(input.final_answer, answer); assert.deepEqual(input.evidence.map(packet => packet.excerpt), evidence.map((ref: { excerpt: string[] }) => ref.excerpt));
    assert.deepEqual(input.answer_sections.map(section => answer.slice(section.start, section.end)).join(''), answer);
    if (!bad || !input.focus_section_ids.some(id => answer.slice(input.answer_sections[id]!.start, input.answer_sections[id]!.end).includes(bad))) return positive(input);
    const packet = input.evidence.find(packet => packet.excerpt.length && !packet.incomplete)!;
    return negative(input, bad, { evidence_id: packet.evidence_id, excerpt: packet.excerpt.join('\n').slice(0, 600), claim_scope: 'javascript_runtime', evidence_scope: 'javascript_runtime' });
  });
  const result = await reviewAnswerEvidence({ ...base, text: answer, evidence: evidence.map((ref: Record<string, unknown>) => ({ ...ref, snapshot_id: 'snapshot' })),
    store: { readSourceLines: async (_p: string, _s: string, path: string, start: number, end: number) => {
      const ref = evidence.find((ref: { path: string; start_line: number; end_line: number }) => ref.path === path && ref.start_line === start && ref.end_line === end);
      assert.ok(ref, 'original frozen ranges only'); return { lines: ref.excerpt, truncated: false };
    } } as unknown as ProductStore, modelRuntime: rt.modelRuntime });
  assert.equal(result.completed, true); assert.equal(result.supported, !bad); if (bad) assert.equal(result.issues[0]!.claim, bad);
  assert.ok(rt.calls() <= 4);
});
