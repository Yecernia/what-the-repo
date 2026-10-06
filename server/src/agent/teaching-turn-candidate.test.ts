import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../domain/conversation.js';
import type { ReplyEvidenceBlock } from './reply-evidence.js';
import type { TeachingQuestion } from './teaching-question.js';
import { reduceTeachingTurnCommit } from './teaching-turn-candidate.js';

function fixture() {
  const baseline = createProject('owner', 'https://github.com/example/repo', 'Repo', 'free:test');
  const candidate = structuredClone(baseline);
  candidate.study.mastered_target_items = ['candidate proof'];
  const question = { question_id: 'new' } as TeachingQuestion;
  const block = (kind: ReplyEvidenceBlock['kind'], commit_eligible = true): ReplyEvidenceBlock => ({ kind, text: kind, evidence: [], commit_eligible });
  return { baseline, candidate, question, block };
}

test('TA23 accepts the assessment partition while a failed supplement denies its new question and action', () => {
  const f = fixture(); const original = { baseline: structuredClone(f.baseline), candidate: structuredClone(f.candidate) };
  const result = reduceTeachingTurnCommit({ ...f, completed: true, cancelled: false, replyKind: 'assessment', hasAssessment: true,
    blocks: [f.block('assessment'), f.block('explanation', false), f.block('question')], validationErrors: ['failed supplement'] });
  assert.equal(result.assessmentEligible, true);
  assert.equal(result.questionEligible, false);
  assert.equal(result.turnEligible, false);
  assert.equal(result.question, null);
  assert.deepEqual(result.project.study.mastered_target_items, ['candidate proof']);
  assert.deepEqual(f.baseline, original.baseline);
  assert.deepEqual(f.candidate, original.candidate);
});

test('TA22 a rejected assessment retains the baseline and rejects a replacement question', () => {
  const f = fixture();
  const result = reduceTeachingTurnCommit({ ...f, completed: true, cancelled: false, replyKind: 'assessment', hasAssessment: true,
    blocks: [f.block('assessment', false), f.block('question')], validationErrors: [] });
  assert.equal(result.assessmentEligible, false);
  assert.equal(result.questionEligible, false);
  assert.equal(result.turnEligible, false);
  assert.deepEqual(result.project, f.baseline);
});

test('TA24 TA25 unavailable, cancellation and unfinished runs discard every candidate partition', () => {
  for (const condition of [{ replyKind: 'unavailable' as const, completed: true, cancelled: false },
    { replyKind: 'assessment' as const, completed: true, cancelled: true },
    { replyKind: 'assessment' as const, completed: false, cancelled: false }]) {
    const f = fixture();
    const result = reduceTeachingTurnCommit({ ...f, ...condition, hasAssessment: true,
      blocks: [f.block('assessment'), f.block('question')], validationErrors: [] });
    assert.deepEqual(result.project, f.baseline);
    assert.equal(result.assessedQuestion, null);
    assert.equal(result.question, null);
    assert.equal(result.turnEligible, false);
  }
});

test('a fully checked question and assessment commit together without mutating the inputs', () => {
  const f = fixture();
  const result = reduceTeachingTurnCommit({ ...f, completed: true, cancelled: false, replyKind: 'lesson', hasAssessment: true,
    blocks: [f.block('assessment'), f.block('explanation'), f.block('question')], validationErrors: [] });
  assert.equal(result.turnEligible, true);
  assert.equal(result.project.study.teaching_question?.question_id, 'new');
  assert.equal(f.candidate.study.teaching_question, undefined);
});
