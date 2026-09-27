import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotLearningStep } from "../domain/snapshot.js";
import { applyCompletedLearningRoute, applyConfirmedLearningAction, assertLearningActionStillCurrent, createLearningActionProposal } from "./learning-actions.js";

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
  project.study.step_passed = { step_id: "first", snapshot_id: snapshot.snapshot_id, route_revision: 0, assessment_sequence: 1, mastered_items: ["current mastery"], evidence_ids: [] };
  const card = createLearningActionProposal(project, snapshot, { action: "advance_learning_step", request: "advance", progress: { mastered_items: ["stale mastery"], evidence_ids: [] } });
  const pass = project.study.step_passed;
  project.study.step_passed = null;
  assert.throws(() => applyConfirmedLearningAction(project, card), /not_passed/);
  project.study.step_passed = pass;
  project.study.latest_assessment = { question_id: "q", snapshot_id: snapshot.snapshot_id, route_revision: 0, step_id: "first", sequence: 2, verdict: "misconception", step_completed: false };
  assert.throws(() => applyConfirmedLearningAction(project, card), /not_passed/);
  assert.equal(project.study.current_step, 0);
  assert.equal(project.study.step_passed, pass, "a rejected action does not clear assessment state");
  project.study.latest_assessment = null;
  applyConfirmedLearningAction(project, card);
  assert.deepEqual(project.study.mastered, ["current mastery"]);
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
