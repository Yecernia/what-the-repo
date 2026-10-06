import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentStatusText } from './assessment-feedback.js';
import type { TeachingFeedbackScope } from './teaching-question.js';

const scope: TeachingFeedbackScope = { prior_proven_target_ids: ['A'], current_proven_target_ids: [],
  question_covered_target_ids: ['A', 'B'], question_remaining_target_ids: [], step_remaining_target_ids: ['B'], follow_up_target_ids: [] };

test('a completed narrow question still displays the unproven whole target separately', () => {
  const text = assessmentStatusText({ verdict: 'mastered', questionResult: { complete: true, requirements: [] }, feedbackScope: scope }, '补充回答');
  assert.match(text, /本题已回答完整/);
  assert.match(text, /还有 1 项学习目标尚未获得完整证明/);
  assert.doesNotMatch(text, /遗漏|漏答|下一步|确认/);
});

test('irrelevant or unclear input never receives a program grading summary', () => {
  for (const input of [{ answerRelevant: false, verdict: 'mastered' }, { verdict: 'unclear' }])
    assert.equal(assessmentStatusText({ ...input, questionResult: { complete: true, requirements: [] }, feedbackScope: scope }, 'hello'), '');
});

test('complete target coverage describes qualification without claiming advancement', () => {
  const text = assessmentStatusText({ verdict: 'mastered', questionResult: { complete: true, requirements: [] },
    feedbackScope: { ...scope, step_remaining_target_ids: [] } }, 'My answer');
  assert.match(text, /All learning targets in this step have valid proof/);
  assert.doesNotMatch(text, /advanced|next step|confirm/i);
});
