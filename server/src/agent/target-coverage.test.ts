import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessage, createProject } from '../domain/conversation.js';
import type { Project } from '../domain/conversation.js';
import type { SnapshotLearningStep } from '../domain/snapshot.js';
import type { TeachingQuestion, TeachingTargetResult } from './teaching-question.js';
import type { ReplyEvidenceBlock } from './reply-evidence.js';
import { applyTargetAssessment, hasValidTargetPass, normalizeQuestionTargets, normalizeTargetCoverage,
  assessmentFeedbackScope, feedbackScopeValidationErrors, priorTargetCoverageForAssessment,
  targetCoverageForStep, targetsForStep, questionResultValidationErrors, qualifiedQuestionSupportsForAssessment } from './target-coverage.js';
import type { TeachingQuestionResult } from './teaching-question.js';
import { CONFIRMED_LESSON_TASK, confirmedLessonSourceId } from '../domain/confirmed-lesson.js';

const step: SnapshotLearningStep = { step_id: 'step', order: 1, title: 'Targets', objective: 'Targets',
  completion_check: 'Explain the targets', learning_targets: ['A', 'B', 'C', 'D'],
  learning_target_defs: ['A', 'B', 'C', 'D'].map(label => ({ target_id: label, label })),
  component_ids: [], evidence_refs: ['e'] };
const evidence = { stable_id: 'e', label: 'entry', path: 'entry.ts', start_line: 1, end_line: 2, kind: 'file' as const };
function fixture(targets = ['A', 'B', 'C', 'D']) {
  const project = createProject('owner', 'https://github.com/example/repo', 'repo', 'test');
  project.analysis.snapshot_id = 'snapshot';
  project.study.snapshot_id = 'snapshot';
  project.study.route_revision = 4;
  project.study.dynamic_learning_plan = [structuredClone(step)];
  project.study.total_steps = 1;
  const question: TeachingQuestion = { question_id: 'q', snapshot_id: 'snapshot', route_revision: 4, step_id: 'step',
    prompt: 'Choose any target', target_items: targets, target_ids: targets, evidence: [evidence],
    answers: [], answer_message_ids: [], created_message_id: 'lesson', assessment_sequence: 0 };
  project.study.teaching_question = question;
  displayQuestion(project, question);
  return { project, question };
}
function displayQuestion(project: Project, question: TeachingQuestion) {
  const source = createMessage('user', 'Ask the question'); source.message_id = question.created_message_id;
  source.analysis_snapshot_id = question.snapshot_id;
  if (!project.messages.some(message => message.message_id === source.message_id)) project.messages.push(source);
  const lesson = createMessage('assistant', question.prompt); lesson.message_id = 'display:' + question.question_id;
  lesson.teaching_context = { snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id };
  lesson.teaching_question = structuredClone(question);
  project.messages.push(lesson);
}
function message(project: Project, id: string, content: string) {
  const row = createMessage('user', content); row.message_id = id; project.messages.push(row);
}
function result(id: string, outcome: TeachingTargetResult['outcome'], span = id + ' correct'): TeachingTargetResult {
  return { target_id: id, outcome, reason: outcome, answer_spans: ['proven', 'contradicted'].includes(outcome) ? [span] : [],
    evidence_ids: ['proven', 'contradicted'].includes(outcome) ? ['e'] : [] };
}

test('TA09 lawful single-branch proof never certifies all declared question targets', () => {
  const { project, question } = fixture(); message(project, 'm1', 'A correct');
  const applied = applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven'),
    ...['B', 'C', 'D'].map(id => result(id, 'not_addressed'))]);
  assert.equal(applied.coverage.A!.proven, true);
  assert.deepEqual(Object.values(applied.coverage).filter(target => target.proven).map(target => target.target_id), ['A']);
  assert.equal(applied.stepPassed, false); assert.equal(project.study.step_passed, null);
  assert.equal(hasValidTargetPass(project, step), false);
});

test('a confirmed program lesson can support a later learner proof, but no system message is learner proof', () => {
  const { project, question } = fixture();
  const actionId = 'confirmed-action';
  const sourceId = confirmedLessonSourceId(actionId);
  question.created_message_id = sourceId;
  project.messages[1]!.teaching_question!.created_message_id = sourceId;
  project.messages[0] = createMessage('system', CONFIRMED_LESSON_TASK, {
    message_id: sourceId, original_run_id: 'lesson-first-run', analysis_snapshot_id: 'snapshot',
    lesson_request: { action_id: actionId, snapshot_id: 'snapshot', route_revision: 4, step_id: 'step' },
  });
  project.messages.unshift(createMessage('assistant', 'Confirmed route.', { learning_action: {
    action_id: actionId, action: 'start_learning_route', target: null, title: 'Route', description: 'Confirmed.',
    request: 'Teach the targets.', snapshot_id: 'snapshot', status: 'executed', progress: null,
    created_at: '2026-01-01T00:00:00Z', resolved_at: '2026-01-01T00:00:00Z', executed_at: '2026-01-01T00:00:00Z', error: null,
    outcome: { route_revision: 4, next_step_id: 'step', next_step_title: 'Targets', lesson_run_id: 'lesson-first-run' },
  } }));
  message(project, 'learner', 'A correct');
  const results = [result('A', 'proven'), ...['B', 'C', 'D'].map(id => result(id, 'not_addressed'))];
  const applied = applyTargetAssessment(project, question, 'learner', ['A correct'], results);
  assert.equal(applied.coverage.A!.proven, true);
  assert.equal(project.study.target_assessments![0]!.original_message_id, 'learner');
  assert.equal(targetCoverageForStep(project, step).coverage.A!.proven, true);
  const badAnswer = structuredClone(project);
  badAnswer.messages.at(-1)!.role = 'system';
  assert.throws(() => applyTargetAssessment(badAnswer, question, 'learner', ['A correct'], results), /question_not_displayed|answer_source_mismatch/);
  const badSource = structuredClone(project);
  badSource.messages[0]!.learning_action!.status = 'pending';
  assert.throws(() => applyTargetAssessment(badSource, question, 'learner', ['A correct'], results), /question_not_displayed/);
});

test('TA10 same-question and cross-question qualified answers accumulate without erasing omissions', () => {
  for (const sameQuestion of [true, false]) {
    const { project, question } = fixture(['A', 'B']);
    project.study.dynamic_learning_plan![0]!.learning_target_defs = step.learning_target_defs!.slice(0, 2);
    message(project, 'm1', 'A correct');
    applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven'), result('B', 'unproven')]);
    const second = sameQuestion ? question : { ...structuredClone(question), question_id: 'q2', answer_attempts: [] };
    if (!sameQuestion) displayQuestion(project, second);
    message(project, 'm2', 'B correct');
    const applied = applyTargetAssessment(project, second, 'm2', ['B correct'], [result('A', 'not_addressed'), result('B', 'proven')]);
    assert.equal(applied.stepPassed, true); assert.equal(hasValidTargetPass(project, project.study.dynamic_learning_plan![0]!), true);
    assert.equal(applied.coverage.A!.message_id, 'm1'); assert.equal(applied.coverage.B!.message_id, 'm2');
    assert.equal(question.answer_attempts!.length, sameQuestion ? 2 : 1);
    assert.deepEqual(question.answers, [], 'legacy whole-message history is not repopulated');
  }
});

test('TA11 a qualified contradiction revokes only its target and corrected proof restores coverage', () => {
  const { project, question } = fixture(['A', 'B']);
  const active = project.study.dynamic_learning_plan![0]!; active.learning_target_defs = step.learning_target_defs!.slice(0, 2);
  message(project, 'm1', 'A correct; B correct');
  applyTargetAssessment(project, question, 'm1', ['A correct; B correct'], [result('A', 'proven'), result('B', 'proven')]);
  const oldSequence = project.study.step_passed!.assessment_sequence;
  message(project, 'm2', 'A wrong');
  const applied = applyTargetAssessment(project, question, 'm2', ['A wrong'], [result('A', 'contradicted', 'A wrong'), result('B', 'not_addressed')]);
  assert.equal(applied.coverage.A!.proven, false); assert.equal(applied.coverage.B!.proven, true);
  assert.equal(hasValidTargetPass(project, active), false);
  message(project, 'm3', 'A correct');
  applyTargetAssessment(project, question, 'm3', ['A correct'], [result('A', 'proven'), result('B', 'unproven')]);
  assert.equal(hasValidTargetPass(project, active), true);
  assert.ok(project.study.step_passed!.assessment_sequence! > oldSequence!);
});

test('TA12 uncertain actual answers do not revoke established unrelated coverage', () => {
  const { project, question } = fixture(['A']); message(project, 'm1', 'A correct');
  applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
  message(project, 'm2', 'I am unsure');
  applyTargetAssessment(project, question, 'm2', ['I am unsure'], [result('A', 'unproven')]);
  assert.equal(targetCoverageForStep(project, step).coverage.A!.proven, true);
});

test('TA13 target identity, question scope, exact spans and own evidence reject fabricated authority', () => {
  for (const variant of ['unknown', 'duplicate', 'missing', 'span', 'evidence', 'snapshot', 'revision', 'step', 'same-turn']) {
    const { project, question } = fixture(['A']); message(project, 'm1', 'A correct');
    let results = [result('A', 'proven')];
    if (variant === 'unknown') results = [result('B', 'proven', 'A correct')];
    if (variant === 'duplicate') results.push(result('A', 'proven'));
    if (variant === 'missing') results = [];
    if (variant === 'span') results[0]!.answer_spans = ['rewritten answer'];
    if (variant === 'evidence') results[0]!.evidence_ids = ['global-evidence'];
    if (variant === 'snapshot') question.snapshot_id = 'other';
    if (variant === 'revision') question.route_revision++;
    if (variant === 'step') question.step_id = 'other';
    if (variant === 'same-turn') question.created_message_id = 'm1';
    const before = structuredClone(project.study);
    assert.throws(() => applyTargetAssessment(project, question, 'm1', ['A correct'], results), variant);
    assert.deepEqual(project.study, before, variant + ' cannot partly mutate study');
  }
});

test('TA19 editing one source replaces its ledger record and cannot retain old proof of a different target', () => {
  const { project, question } = fixture(['A', 'B']); message(project, 'm1', 'A correct');
  const first = applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven'), result('B', 'not_addressed')]);
  project.messages.find(message => message.message_id === 'm1')!.content = 'B correct';
  assert.equal(targetCoverageForStep(project, step).coverage.A!.proven, false, 'edit invalidates stale proof before regrading');
  const second = applyTargetAssessment(project, question, 'm1', ['B correct'], [result('A', 'not_addressed'), result('B', 'proven')]);
  assert.equal(second.coverage.A!.proven, false); assert.equal(second.coverage.B!.proven, true);
  assert.ok(second.sequence > first.sequence); assert.equal(project.study.target_assessments!.length, 1);
  assert.deepEqual(question.answer_attempts, [{ message_id: 'm1', original_message_id: 'm1', answer_parts: ['B correct'] }]);
});

test('TA19 long assessed parts stay exact and independent requests remain only in the original message', () => {
  const { project, question } = fixture(['A']); const answer = 'A correct ' + 'x'.repeat(4500);
  message(project, 'm1', answer + '\nExplain the independent example.');
  applyTargetAssessment(project, question, 'm1', [answer], [result('A', 'proven')]);
  assert.equal(question.answer_attempts![0]!.answer_parts[0], answer);
  assert.equal(project.study.target_assessments![0]!.answer_parts[0], answer);
  assert.ok(project.messages.find(message => message.message_id === 'm1')!.content.includes('independent example'));
});

test('TA13/TA29 lazy compatibility binds exact old labels without promoting legacy mastery or deleting history', () => {
  const { project, question } = fixture(['A']); delete question.target_ids;
  project.study.step_passed = { step_id: 'step', mastered_items: ['A', 'B', 'C', 'D'], evidence_ids: ['e'] };
  project.study.mastered_target_items = ['A', 'B', 'C', 'D'];
  project.study.mastered = ['old-completed-step']; project.study.skipped_steps = ['old-skipped-step'];
  project.study.latest_assessment = { question_id: 'old', snapshot_id: 'snapshot', route_revision: 4, step_id: 'step', sequence: 8, verdict: 'mastered', step_completed: true };
  normalizeTargetCoverage(project);
  assert.equal(project.study.step_passed, null); assert.deepEqual(project.study.mastered_target_items, []);
  assert.deepEqual(project.study.teaching_question!.target_ids, ['A']);
  assert.equal(project.study.latest_assessment!.verdict, 'mastered', 'historical assessment stays historical');
  assert.deepEqual(project.study.mastered, ['old-completed-step']); assert.deepEqual(project.study.skipped_steps, ['old-skipped-step']);
  assert.equal(project.study.dynamic_learning_plan!.length, 1);
  assert.throws(() => normalizeQuestionTargets({ ...question, target_items: ['a'], target_ids: undefined }, step));
});

test('stable generated target IDs depend on exact step, index and label; explicit definitions stay authoritative', () => {
  const legacy = { ...step, learning_target_defs: undefined };
  assert.deepEqual(targetsForStep(legacy), targetsForStep(structuredClone(legacy)));
  assert.notEqual(targetsForStep(legacy)[0]!.target_id, targetsForStep({ ...legacy, step_id: 'other' })[0]!.target_id);
  assert.notEqual(targetsForStep(legacy)[0]!.target_id, targetsForStep({ ...legacy, learning_targets: ['a'] })[0]!.target_id);
  assert.deepEqual(targetsForStep(step), step.learning_target_defs);
  assert.throws(() => targetsForStep({ ...step, learning_target_defs: [{ target_id: 'A', label: 'A' }, { target_id: 'A', label: 'B' }] }));
});

test('TA29 snapshot or route change invalidates proof scope while retaining the ledger for history', () => {
  for (const change of ['snapshot', 'revision', 'step']) {
    const { project, question } = fixture(['A']); const active = project.study.dynamic_learning_plan![0]!;
    active.learning_target_defs = step.learning_target_defs!.slice(0, 1);
    message(project, 'm1', 'A correct'); applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
    assert.equal(hasValidTargetPass(project, active), true);
    if (change === 'snapshot') project.study.snapshot_id = 'new-snapshot';
    if (change === 'revision') project.study.route_revision = (project.study.route_revision ?? 0) + 1;
    if (change === 'step') active.step_id = 'new-step';
    normalizeTargetCoverage(project);
    assert.equal(hasValidTargetPass(project, active), false); assert.equal(project.study.step_passed, null);
    assert.equal(project.study.target_assessments!.length, 1);
  }
});

test('TA13 old records without target or displayed-question provenance cannot become pass authority', () => {
  for (const defect of ['binding', 'source', 'changed-question', 'rejected-question']) {
    const { project, question } = fixture(['A']); const active = project.study.dynamic_learning_plan![0]!;
    active.learning_target_defs = step.learning_target_defs!.slice(0, 1);
    message(project, 'm1', 'A correct'); applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
    const record = project.study.target_assessments![0]!;
    const displayed = project.messages.find(row => row.message_id === record.question_message_id)!;
    if (defect === 'binding') delete (record as Partial<typeof record>).target_ids;
    if (defect === 'source') delete (record as Partial<typeof record>).question_message_id;
    if (defect === 'changed-question') displayed.teaching_question!.prompt = 'An edited different question';
    if (defect === 'rejected-question') displayed.teaching_question!.commit_eligibility = { deterministic: false, review: 'disabled' };
    assert.equal(hasValidTargetPass(project, active), false, defect);
    normalizeTargetCoverage(project);
    assert.equal(project.study.step_passed, null, defect);
    assert.equal(project.study.target_assessments!.length, 1, 'invalid historical record is retained');
  }
});

test('TA13 applying a fabricated undisplayed question cannot create a ledger record', () => {
  const { project, question } = fixture(['A']); message(project, 'm1', 'A correct');
  question.question_id = 'fabricated';
  assert.throws(() => applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]), /question_not_displayed/);
  assert.equal(project.study.target_assessments, undefined);
});

test('TA13/TA29 legacy question reviews with explicit ineligibility cannot create or restore target proofs', async t => {
  for (const defect of ['not-applicable', 'incomplete-review', 'incomplete-evidence', 'incomplete-coverage'] as const) await t.test(defect, () => {
    const { project, question } = fixture(['A']);
    const active = project.study.dynamic_learning_plan![0]!;
    active.learning_target_defs = step.learning_target_defs!.slice(0, 1);
    message(project, 'm1', 'A correct');
    applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
    const displayed = project.messages.find(row => row.message_id === 'display:q')!;
    const block: ReplyEvidenceBlock = { kind: 'question', text: question.prompt, evidence: [evidence],
      // Legacy blocks deliberately omit commit_eligible and the newer review fields.
      review: { status: 'reviewed', supported: true, summary: 'Supported legacy question', issues: [] } };
    if (defect === 'not-applicable') block.review!.status = 'not_applicable';
    if (defect === 'incomplete-review') block.review!.completed = false;
    if (defect === 'incomplete-evidence') block.review!.evidenceIncomplete = true;
    if (defect === 'incomplete-coverage') block.review!.coverage = { complete: false, packets: [], reasons: ['read_failed'] };
    displayed.content_parts = { body: displayed.content, action_receipt: null, evidence_blocks: [block] };
    assert.equal(block.commit_eligible, undefined);
    const history = structuredClone(project.messages);
    const ledger = structuredClone(project.study.target_assessments);
    message(project, 'm2', 'A correct again');
    assert.throws(() => applyTargetAssessment(project, question, 'm2', ['A correct again'], [result('A', 'proven', 'A correct again')]),
      /question_not_displayed/, 'an explicit legacy review failure cannot grant a new proof');
    assert.equal(hasValidTargetPass(project, active), false, 'a retained older ledger cannot resurrect rejected question authority');
    normalizeTargetCoverage(project);
    assert.equal(project.study.step_passed, null);
    assert.deepEqual(project.study.target_assessments, ledger, 'historical proofs remain inspectable');
    assert.deepEqual(project.messages.slice(0, history.length), history, 'legacy question and source messages remain unchanged');
    assert.equal(project.study.teaching_question!.question_id, question.question_id, 'normalization retains the historical question');
  });
});

test('TA13/TA29 supported legacy question review without new eligibility fields remains assessable', () => {
  const { project, question } = fixture(['A']);
  const active = project.study.dynamic_learning_plan![0]!;
  active.learning_target_defs = step.learning_target_defs!.slice(0, 1);
  const displayed = project.messages.find(row => row.message_id === 'display:q')!;
  delete displayed.teaching_question!.target_ids;
  displayed.content_parts = { body: displayed.content, action_receipt: null, evidence_blocks: [{
    kind: 'question', text: question.prompt, evidence: [evidence],
    review: { status: 'reviewed', supported: true, summary: 'Supported legacy question', issues: [] },
  }] };
  const block = displayed.content_parts.evidence_blocks![0]!;
  assert.equal(block.commit_eligible, undefined);
  assert.equal(block.review!.completed, undefined);
  assert.equal(block.review!.evidenceIncomplete, undefined);
  assert.equal(block.review!.coverage, undefined);
  message(project, 'm1', 'A correct');
  const applied = applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
  assert.equal(applied.stepPassed, true);
  assert.equal(hasValidTargetPass(project, active), true);
  normalizeTargetCoverage(project);
  assert.equal(hasValidTargetPass(project, active), true);
  assert.equal(project.study.target_assessments!.length, 1);
});

test('R4-1 scope previews retain same-question and cross-question source proofs without restating them as current', () => {
  for (const sameQuestion of [true, false]) {
    const { project, question } = fixture(['A', 'B']);
    const active = project.study.dynamic_learning_plan![0]!; active.learning_target_defs = step.learning_target_defs!.slice(0, 3);
    message(project, 'm1', 'A correct');
    applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven'), result('B', 'not_addressed')]);
    const second = sameQuestion ? question : { ...structuredClone(question), question_id: 'q2', target_ids: ['B'], target_items: ['B'],
      answer_attempts: [], created_message_id: 'second-lesson' };
    if (!sameQuestion) displayQuestion(project, second);
    message(project, 'm2', 'B correct');
    const prior = priorTargetCoverageForAssessment(project, second, active, 'm2');
    assert.equal(prior.coverage.A!.proven, true);
    assert.deepEqual([prior.coverage.A!.question_id, prior.coverage.A!.message_id, prior.coverage.A!.sequence], ['q', 'm1', 1]);
    const current = sameQuestion ? [result('A', 'unproven'), result('B', 'proven')] : [result('B', 'proven')];
    const scope = assessmentFeedbackScope(prior, second, current);
    assert.deepEqual(scope.prior_proven_target_ids, ['A']);
    assert.deepEqual(scope.current_proven_target_ids, ['B']);
    assert.deepEqual(scope.question_covered_target_ids, sameQuestion ? ['A', 'B'] : ['B']);
    assert.deepEqual(scope.question_remaining_target_ids, []);
    assert.deepEqual(scope.step_remaining_target_ids, ['C']);
    const invalid = { ...scope, follow_up_target_ids: ['A'] };
    assert.match(feedbackScopeValidationErrors(scope, invalid).join(' '), /already_proven/);
    assert.deepEqual(feedbackScopeValidationErrors(scope, { ...scope, follow_up_target_ids: ['C'] }), []);
    const applied = applyTargetAssessment(project, second, 'm2', ['B correct'], current);
    assert.equal(applied.coverage.A!.message_id, 'm1'); assert.equal(applied.coverage.B!.message_id, 'm2');
    assert.equal(applied.stepPassed, false, 'the completed question does not certify remaining step target C');
  }
});

test('R4-1 a valid contradiction makes only that prior target a gap until a current correction restores it', () => {
  const { project, question } = fixture(['A', 'B']);
  const active = project.study.dynamic_learning_plan![0]!; active.learning_target_defs = step.learning_target_defs!.slice(0, 2);
  message(project, 'm1', 'A correct; B correct');
  applyTargetAssessment(project, question, 'm1', ['A correct; B correct'], [result('A', 'proven'), result('B', 'proven')]);
  message(project, 'm2', 'A wrong');
  const contradiction = [result('A', 'contradicted', 'A wrong'), result('B', 'not_addressed')];
  const scope = assessmentFeedbackScope(priorTargetCoverageForAssessment(project, question, active, 'm2'), question, contradiction);
  assert.deepEqual(scope.prior_proven_target_ids, ['A', 'B']);
  assert.deepEqual(scope.question_remaining_target_ids, ['A']); assert.deepEqual(scope.step_remaining_target_ids, ['A']);
  assert.deepEqual(feedbackScopeValidationErrors(scope, { ...scope, follow_up_target_ids: ['A'] }), []);
  applyTargetAssessment(project, question, 'm2', ['A wrong'], contradiction);
  message(project, 'm3', 'A correct');
  const prior = priorTargetCoverageForAssessment(project, question, active, 'm3');
  assert.equal(prior.coverage.A!.proven, false); assert.equal(prior.coverage.A!.message_id, 'm2');
  const restored = assessmentFeedbackScope(prior, question, [result('A', 'proven'), result('B', 'not_addressed')]);
  assert.deepEqual(restored.prior_proven_target_ids, ['B']);
  assert.deepEqual(restored.current_proven_target_ids, ['A']);
  assert.deepEqual(restored.question_remaining_target_ids, []); assert.deepEqual(restored.step_remaining_target_ids, []);
});

test('R4-1 unchanged retries and edited old messages never count their replaced record as prior coverage', () => {
  const { project, question } = fixture(['A', 'B']); const active = project.study.dynamic_learning_plan![0]!;
  active.learning_target_defs = step.learning_target_defs!.slice(0, 2);
  message(project, 'm1', 'A correct');
  applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven'), result('B', 'unproven')]);
  let prior = priorTargetCoverageForAssessment(project, question, active, 'm1');
  assert.equal(prior.coverage.A!.proven, false, 'even an identical retry cannot borrow the replaced record');
  project.messages.find(message => message.message_id === 'm1')!.content = 'B correct';
  prior = priorTargetCoverageForAssessment(project, question, active, 'm1');
  const scope = assessmentFeedbackScope(prior, question, [result('A', 'not_addressed'), result('B', 'proven')]);
  assert.deepEqual(scope.prior_proven_target_ids, []); assert.deepEqual(scope.current_proven_target_ids, ['B']);
  assert.deepEqual(scope.question_remaining_target_ids, ['A']);
  applyTargetAssessment(project, question, 'm1', ['B correct'], [result('A', 'not_addressed'), result('B', 'proven')]);
  assert.equal(project.study.target_assessments!.length, 1);
});

test('R4-1 prior context rejects stale version scope and unverifiable historical sources', () => {
  const { project, question } = fixture(['A']); const active = project.study.dynamic_learning_plan![0]!;
  message(project, 'm1', 'A correct'); applyTargetAssessment(project, question, 'm1', ['A correct'], [result('A', 'proven')]);
  message(project, 'm2', 'A correct');
  project.messages.find(message => message.message_id === 'm1')!.content = 'Changed original answer';
  assert.equal(priorTargetCoverageForAssessment(project, question, active, 'm2').coverage.A!.proven, false);
  assert.throws(() => priorTargetCoverageForAssessment(project, { ...question, route_revision: 99 }, active, 'm2'), /scope_mismatch/);
});

// Structural tests use declared semantic judgments; they do not validate a real model's interpretation.
function narrowResult(prompt: string, target: string, answer: string, outcome: 'satisfied' | 'missing' | 'contradicted' | 'not_selected' = 'satisfied', prior: string[] = []): TeachingQuestionResult {
  return { complete: ['satisfied', 'not_selected'].includes(outcome), requirements: [{ prompt_span: prompt,
    target_ids: [target], outcome, answer_spans: answer ? [answer] : [], prior_answer_message_ids: prior,
    evidence_ids: ['satisfied', 'contradicted'].includes(outcome) ? ['e'] : [], reason: 'Declared synthetic requirement judgment' }] };
}
function compositeFixture(prompt = 'Explain B only') {
  const input = fixture(['AB']);
  input.project.study.dynamic_learning_plan![0]!.learning_target_defs = [{ target_id: 'AB', label: 'Explain A and B' }];
  input.question.target_items = ['Explain A and B']; input.question.prompt = prompt;
  input.project.messages = []; displayQuestion(input.project, input.question);
  return input;
}

test('R6-2 narrow legacy A+B label binds complete B question independently of whole target', () => {
  const { project, question } = compositeFixture();
  delete question.target_ids; // Saved label-only data still follows its exact prompt.
  const normalized = normalizeQuestionTargets(question, project.study.dynamic_learning_plan![0]!);
  message(project, 'm1', 'B correct');
  const qr = narrowResult(question.prompt, 'AB', 'B correct');
  const unproven = [result('AB', 'unproven')];
  const scope = assessmentFeedbackScope(priorTargetCoverageForAssessment(project, normalized, project.study.dynamic_learning_plan![0]!), normalized, unproven, qr);
  assert.equal(scope.question_complete, true); assert.deepEqual(scope.question_covered_target_ids, ['AB']);
  assert.deepEqual(scope.question_remaining_target_ids, []); assert.deepEqual(scope.step_remaining_target_ids, ['AB']);
  assert.equal(applyTargetAssessment(project, normalized, 'm1', ['B correct'], unproven, undefined, qr).stepPassed, false);
  assert.equal(qualifiedQuestionSupportsForAssessment(project, normalized, project.study.dynamic_learning_plan![0]!).length, 1);
});

test('R6-2 choice and actually missing A preserve distinct requirement outcomes', () => {
  const { project, question } = compositeFixture('Explain A and B'); message(project, 'm1', 'B correct');
  const qr = narrowResult('B', 'AB', 'B correct');
  qr.requirements.push(...narrowResult('A', 'AB', '', 'missing').requirements); qr.complete = false;
  assert.deepEqual(questionResultValidationErrors(question, ['B correct'], qr, new Set(['e'])), []);
  const scope = assessmentFeedbackScope(priorTargetCoverageForAssessment(project, question, project.study.dynamic_learning_plan![0]!), question, [result('AB', 'unproven')], qr);
  assert.deepEqual(scope.question_remaining_target_ids, ['AB']); assert.deepEqual(scope.question_covered_target_ids, []);
  const choice = { ...question, prompt: 'Explain either A or B' };
  const choiceResult = narrowResult('B', 'AB', 'B correct');
  choiceResult.requirements.push(...narrowResult('either A or B', 'AB', '', 'not_selected').requirements);
  assert.deepEqual(questionResultValidationErrors(choice, ['B correct'], choiceResult, new Set(['e'])), []);
  choiceResult.requirements[0]!.prompt_span = 'unasked C';
  assert.match(questionResultValidationErrors(choice, ['B correct'], choiceResult, new Set(['e'])).join(), /exact saved question/);
});

test('R6-2 two same-question partial answers retain qualified prompt proof, never arbitrary history', () => {
  const { project, question } = compositeFixture('Explain A and B'); message(project, 'm1', 'A correct');
  const first = narrowResult('A', 'AB', 'A correct'); first.requirements.push(...narrowResult('B', 'AB', '', 'missing').requirements); first.complete = false;
  applyTargetAssessment(project, question, 'm1', ['A correct'], [result('AB', 'unproven')], undefined, first);
  message(project, 'm2', 'B correct');
  const second = narrowResult('B', 'AB', 'B correct'); second.requirements.push(...narrowResult('A', 'AB', '', 'satisfied', ['m1']).requirements);
  const prior = qualifiedQuestionSupportsForAssessment(project, question, project.study.dynamic_learning_plan![0]!, 'm2');
  assert.deepEqual(questionResultValidationErrors(question, ['B correct'], second, new Set(['e']), prior), []);
  second.requirements[1]!.prior_answer_message_ids = ['fabricated'];
  assert.match(questionResultValidationErrors(question, ['B correct'], second, new Set(['e']), prior).join(), /qualified same-question/);
  second.requirements[1]!.prior_answer_message_ids = ['m1'];
  const whole = { ...result('AB', 'proven', 'B correct'), prior_answer_message_ids: ['m1'] };
  assert.equal(applyTargetAssessment(project, question, 'm2', ['B correct'], [whole], undefined, second).stepPassed, true);
});

test('R6-2 cross-question composite semantic proof depends on unedited unretracted sources', () => {
  for (const revoke of ['edit', 'contradiction']) {
    const { project, question } = compositeFixture('Explain B only'); message(project, 'm1', 'B correct');
    applyTargetAssessment(project, question, 'm1', ['B correct'], [result('AB', 'unproven')], undefined, narrowResult(question.prompt, 'AB', 'B correct'));
    const next = { ...structuredClone(question), question_id: 'q2', created_message_id: 'lesson2', prompt: 'Explain A only' };
    displayQuestion(project, next); message(project, 'm2', 'A correct');
    const whole = { ...result('AB', 'proven', 'A correct'), prior_answer_message_ids: ['m1'] };
    assert.equal(applyTargetAssessment(project, next, 'm2', ['A correct'], [whole], undefined, narrowResult(next.prompt, 'AB', 'A correct')).stepPassed, true);
    if (revoke === 'edit') project.messages.find(row => row.message_id === 'm1')!.content = 'B changed';
    else { message(project, 'm3', 'B wrong'); applyTargetAssessment(project, next, 'm3', ['B wrong'], [result('AB', 'contradicted', 'B wrong')], undefined,
      narrowResult(next.prompt, 'AB', 'B wrong', 'contradicted')); }
    assert.equal(targetCoverageForStep(project, project.study.dynamic_learning_plan![0]!).stepPassed, false, revoke);
    const supports = qualifiedQuestionSupportsForAssessment(project, next, project.study.dynamic_learning_plan![0]!);
    assert.equal(supports.some(row => row.message_id === 'm1'), false);
    message(project, 'm4', 'A correct');
    assert.throws(() => applyTargetAssessment(project, next, 'm4', ['A correct'], [whole], undefined, narrowResult(next.prompt, 'AB', 'A correct')), /qualified unretracted/);
  }
});

test('R6-2 explicit contradicted constituent cannot retain its broad target as merely unproven', () => {
  const { project, question } = compositeFixture('Explain B only'); message(project, 'm1', 'B correct');
  applyTargetAssessment(project, question, 'm1', ['B correct'], [result('AB', 'unproven')], undefined, narrowResult(question.prompt, 'AB', 'B correct'));
  message(project, 'm2', 'B wrong');
  const contradicted = narrowResult(question.prompt, 'AB', 'B wrong', 'contradicted');
  assert.throws(() => applyTargetAssessment(project, question, 'm2', ['B wrong'], [result('AB', 'unproven')], undefined, contradicted), /contradicted constituent/);
  assert.equal(project.study.target_assessments!.length, 1, 'inconsistent assessment cannot partially commit');
  applyTargetAssessment(project, question, 'm2', ['B wrong'], [result('AB', 'contradicted', 'B wrong')], undefined, contradicted);
  assert.deepEqual(qualifiedQuestionSupportsForAssessment(project, question, project.study.dynamic_learning_plan![0]!), []);
  const saved = project.study.target_assessments![1]!;
  saved.results = [result('AB', 'unproven')]; // Stored malformed inconsistency is also excluded from authority.
  assert.equal(targetCoverageForStep(project, project.study.dynamic_learning_plan![0]!).stepPassed, false);
});
