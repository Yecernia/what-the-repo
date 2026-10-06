import assert from "node:assert/strict";
import test from "node:test";
import { createProject, createMessage } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotLearningStep } from "../domain/snapshot.js";
import { applyCompletedLearningRoute, applyConfirmedLearningAction, assertLearningActionStillCurrent, createLearningActionProposal, completeLearningAction, refreshLearningActionMessage } from "./learning-actions.js";
import type { LearningActionCard } from '../domain/conversation.js';
import { applyTargetAssessment, targetsForStep } from './target-coverage.js';

function fixture() {
  const project = createProject("test", "https://github.com/example/repo", "repo", null);
  project.analysis.snapshot_id = "snapshot:test";
  const steps: SnapshotLearningStep[] = ["first", "second"].map((id, index) => ({
    step_id: id, order: index + 1, title: id, objective: id, evidence_refs: [], component_ids: [], completion_check: id,
  }));
  project.study.dynamic_learning_plan = steps;
  project.study.total_steps = steps.length;
  project.study.phase = "explaining";
  const snapshot = { snapshot_id: "snapshot:test" } as EvidenceSnapshot;
  return { project, snapshot, steps };
}

test('receipt refresh preserves complete evidence blocks in every action state', () => {
  for (const status of ['pending', 'confirmed', 'executed', 'failed', 'expired', 'declined'] as LearningActionCard['status'][]) {
    const { project, snapshot } = fixture();
    const action = createLearningActionProposal(project, snapshot, { action: 'advance_learning_step', request: 'skip', skipUnderstandingCheck: true });
    const evidence = [{ stable_id: 'packet:range:1', kind: 'symbol', label: 'f', path: 'src/a.ts', start_line: 3, end_line: 7, snapshot_id: snapshot.snapshot_id }];
    const review = { status: 'reviewed' as const, supported: true, summary: 'supported', issues: [] };
    const blocks = [{ kind: 'assessment' as const, text: 'Feedback', evidence, review }];
    const message = createMessage('assistant', 'Feedback', { learning_action: action, evidence, evidence_review: review,
      content_parts: { body: 'Feedback', action_receipt: 'old', evidence_blocks: structuredClone(blocks) } });
    project.messages.push(message);
    action.status = status;
    refreshLearningActionMessage(project, action);
    assert.deepEqual(message.content_parts!.evidence_blocks, blocks, status);
    assert.deepEqual(message.evidence, evidence);
    assert.deepEqual(message.evidence_review, review);
    assert.equal(message.content_parts!.body, 'Feedback');
  }
});

test('legacy action receipts preserve exact teaching paragraphs and clear stale review on pure receipts', () => {
  for (const body of ['', '评价与追问回答。']) {
    const { project, snapshot } = fixture();
    const action = createLearningActionProposal(project, snapshot, { action: 'advance_learning_step', request: 'skip', skipUnderstandingCheck: true });
    const message = createMessage('assistant', [body, action.description].filter(Boolean).join('\n\n'), {
      learning_action: action, evidence_review: { status: 'unverified', supported: false, summary: 'not checked', issues: [] },
    });
    project.messages.push(message);
    applyConfirmedLearningAction(project, action);
    completeLearningAction(project, action);
    assert.equal(message.content_parts!.body, body);
    assert.equal(Boolean(message.evidence_review), Boolean(body));
    assert.equal(message.content.includes('评价与追问回答。'), Boolean(body));
  }
});

test("old route cards expire even when a replacement reuses the same snapshot and step ids", () => {
  const { project, snapshot, steps } = fixture();
  const stop = createLearningActionProposal(project, snapshot, { action: "stop_guided_learning", request: "stop" });
  const route = createLearningActionProposal(project, snapshot, { action: "switch_learning_target", targetKind: "repository", request: "replace" });
  applyCompletedLearningRoute(project, route, steps);
  assert.equal(project.study.route_revision, 1);
  for (const old of [stop, route]) {
    assert.throws(() => assertLearningActionStillCurrent(project, snapshot, old), /no_longer_current/);
  }
  assert.throws(() => applyConfirmedLearningAction(project, stop), /no_longer_current/);
  assert.throws(() => applyCompletedLearningRoute(project, route, steps), /no_longer_current/);
  assert.equal(project.study.total_steps, 2);
});

test("legacy and wrong-step cards cannot mutate progress", () => {
  const { project, snapshot } = fixture();
  const card = createLearningActionProposal(project, snapshot, { action: "stop_guided_learning", request: "stop" });
  delete card.route_revision;
  assert.throws(() => assertLearningActionStillCurrent(project, snapshot, card), /no_longer_current/);
  card.route_revision = 0;
  card.expected_step_id = "second";
  assert.throws(() => applyConfirmedLearningAction(project, card), /no_longer_current/);
});

test("an explicit skip advances only once and clears the current check", () => {
  const { project, snapshot } = fixture();
  const card = createLearningActionProposal(project, snapshot, { action: "advance_learning_step", request: "skip", skipUnderstandingCheck: true });
  applyConfirmedLearningAction(project, card);
  assert.equal(project.study.current_step, 1);
  assert.equal(project.study.route_revision, 1);
  assert.equal(project.study.teaching_question, null);
  assert.equal(project.study.latest_assessment, null);
  assert.deepEqual(project.study.mastered_target_items, []);
  assert.deepEqual(project.study.skipped_steps, ["first"]);
  assert.deepEqual(project.study.mastered, []);
  assert.throws(() => applyConfirmedLearningAction(project, card), /no_longer_current/);
  assert.equal(project.study.current_step, 1);
});

test("normal advancement rechecks current mastery instead of trusting card progress", () => {
  const { project, snapshot } = fixture();
  const answer = createMessage('user', 'current mastery');
  project.messages.push(answer);
  const targets = targetsForStep(project.study.dynamic_learning_plan![0]!);
  const question = { question_id: 'q', snapshot_id: snapshot.snapshot_id, route_revision: 0, step_id: 'first',
    prompt: 'first', target_ids: targets.map(target => target.target_id), target_items: targets.map(target => target.label),
    evidence: [{ stable_id: 'proof', label: 'proof', path: 'src/a.ts', start_line: 1, end_line: 1, kind: 'symbol' }],
    answers: [], answer_message_ids: [], created_message_id: 'lesson', assessment_sequence: 0 };
  project.messages.unshift(createMessage('user', 'Start', { message_id: 'lesson', analysis_snapshot_id: snapshot.snapshot_id }),
    createMessage('assistant', question.prompt, { analysis_snapshot_id: snapshot.snapshot_id, teaching_question: structuredClone(question),
      teaching_context: { snapshot_id: snapshot.snapshot_id, route_revision: 0, step_id: 'first' } }));
  applyTargetAssessment(project, question, answer.message_id, [answer.content],
    targets.map(target => ({ target_id: target.target_id, outcome: 'proven', reason: 'Controlled valid proof.', answer_spans: [answer.content], evidence_ids: ['proof'] })));
  const card = createLearningActionProposal(project, snapshot, { action: "advance_learning_step", request: "advance", progress: { mastered_items: ["stale mastery"], evidence_ids: [] } });
  const pass = project.study.step_passed;
  project.study.step_passed = null;
  assert.throws(() => applyConfirmedLearningAction(project, card), /not_passed/);
  project.study.step_passed = pass;
  project.study.latest_assessment = { question_id: "q", snapshot_id: snapshot.snapshot_id, route_revision: 0, step_id: "first", sequence: 2, verdict: "misconception", step_completed: false };
  project.study.target_assessments![0]!.results[0]!.outcome = 'contradicted';
  assert.throws(() => applyConfirmedLearningAction(project, card), /not_passed/);
  assert.equal(project.study.current_step, 0);
  assert.equal(project.study.step_passed, pass, "a rejected action does not clear assessment state");
  project.study.latest_assessment = null;
  project.study.target_assessments![0]!.results[0]!.outcome = 'proven';
  applyConfirmedLearningAction(project, card);
  assert.deepEqual(project.study.mastered, ["first"]);
  assert.equal(project.study.step_passed, null);
});

test("a pass from another snapshot or revision cannot authorize normal advance", () => {
  const { project, snapshot } = fixture();
  const card = createLearningActionProposal(project, snapshot, { action: "advance_learning_step", request: "advance" });
  for (const pass of [
    { step_id: "first", mastered_items: [], evidence_ids: [] },
    { step_id: "first", snapshot_id: "old", route_revision: 0, mastered_items: [], evidence_ids: [] },
    { step_id: "first", snapshot_id: snapshot.snapshot_id, route_revision: 1, mastered_items: [], evidence_ids: [] },
  ]) {
    project.study.step_passed = pass;
    assert.throws(() => applyConfirmedLearningAction(project, card), /not_passed/);
  }
  assert.equal(project.study.current_step, 0);
});

test("stopping clears mastery qualification and expires other cards", () => {
  const { project, snapshot } = fixture();
  project.study.step_passed = { step_id: "first", snapshot_id: snapshot.snapshot_id, route_revision: 0, mastered_items: [], evidence_ids: [] };
  const stop = createLearningActionProposal(project, snapshot, { action: "stop_guided_learning", request: "stop" });
  const advance = createLearningActionProposal(project, snapshot, { action: "advance_learning_step", request: "skip", skipUnderstandingCheck: true });
  applyConfirmedLearningAction(project, stop);
  assert.equal(project.study.route_revision, 1);
  assert.equal(project.study.step_passed, null);
  assert.deepEqual(project.study.dynamic_learning_plan, []);
  assert.throws(() => assertLearningActionStillCurrent(project, snapshot, advance), /no_longer_current/);
});
