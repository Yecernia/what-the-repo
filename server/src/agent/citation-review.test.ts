import assert from 'node:assert/strict';
import test from 'node:test';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ProductStore } from '../persistence/store.js';
import { reviewAnswerEvidence } from './citation-review.js';
import { withEvidenceReviewNotice } from './citations.js';

function runtime(claims: string[], support = false, evidenceIds: string[] = []) {
  const faux = fauxProvider({ provider: 'citation-applicability' });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([context => {
    assert.match(context.systemPrompt ?? '', /empty evidence list does not imply a repository claim/);
    return fauxAssistantMessage(fauxToolCall('submit_result', { repository_claims: claims, supported: support,
      accepted_evidence_ids: evidenceIds, unsupported_claims: [], issues: [], summary: claims.length ? 'Checked claims.' : 'No repository claims.' }));
  }]);
  return { models, model: faux.getModel() as Model<Api> };
}

const base = { projectId: 'project', snapshotId: 'snapshot', evidence: [],
  store: { readSourceLines: async () => { assert.fail('uncited chat must not fetch arbitrary source'); } } as unknown as ProductStore };

test('encouragement, long small talk and general advice are not applicable without arbitrary retrieval', async () => {
  for (const text of [
    '今天已经认真学了一段，休息一下，明天再来就好。',
    '你好，今天过得怎么样？愿你有一个平静的晚上。谢谢分享你的想法，下次见。',
    '学习时可以每次只选一个小目标，累了就先休息。',
    '本步已记录为主动跳过，不计入已掌握。当前步骤是第二步，可以开始学习。',
  ]) {
    const result = await reviewAnswerEvidence({ ...base, text, modelRuntime: runtime([]) });
    assert.equal(result.status, 'not_applicable');
    assert.equal(result.evidenceIncomplete, false);
    assert.deepEqual(result.issues, []);
    assert.equal(withEvidenceReviewNotice(text, result), text);
  }
});

test('uncited and mixed repository assertions are unverified without claiming a source-read failure', async () => {
  const claim = '这个仓库保证永远不会生成重复 ID。';
  for (const text of [claim, `今天已经做得很好，休息一下。${claim}`]) {
    const result = await reviewAnswerEvidence({ ...base, text, modelRuntime: runtime([claim]) });
    assert.equal(result.status, 'unverified');
    assert.equal(result.evidenceIncomplete, false);
    assert.equal(result.stopReason, 'no_evidence');
    assert.deepEqual(result.issues.map(issue => issue.claim), [claim]);
    assert.match(withEvidenceReviewNotice(text, result), /没有可复查/);
    assert.doesNotMatch(withEvidenceReviewNotice(text, result), /未完整读取|coverage is incomplete/);
  }
});

test('actual source coverage stays distinct from absent citations', async () => {
  const text = 'The function returns its input.';
  const evidence = [{ stable_id: 'entry', label: 'entry', path: 'src/entry.ts', start_line: 1, end_line: 3, kind: 'symbol', snapshot_id: 'snapshot' }];
  const store = { readSourceLines: async () => ({ lines: ['export function entry(input) {', 'return input;', '}'], truncated: false }) } as unknown as ProductStore;
  const supported = await reviewAnswerEvidence({ ...base, text, evidence, store, modelRuntime: runtime([text], true, ['entry']) });
  assert.equal(supported.supported, true);
  assert.equal(supported.status, 'reviewed');
  assert.equal(supported.evidenceIncomplete, false);
  for (const readSourceLines of [
    async () => { throw new Error('source unavailable'); },
    async (_project: string, _snapshot: string, _path: string, start: number) => ({
      lines: start === 1 ? ['export function entry(input) {'] : [], truncated: start === 1,
    }),
  ]) {
    const incomplete = await reviewAnswerEvidence({ ...base, text, evidence,
      store: { readSourceLines } as unknown as ProductStore, modelRuntime: runtime([text], true, ['entry']) });
    assert.equal(incomplete.status, 'unverified');
    assert.equal(incomplete.evidenceIncomplete, true);
    assert.equal(incomplete.supported, false);
    assert.match(withEvidenceReviewNotice(text, incomplete), /coverage is incomplete/);
  }
});

test('fabricated claims and contradictory applicability metadata never pass review', async () => {
  const invalid = await reviewAnswerEvidence({ ...base, text: 'Rest for today.', modelRuntime: runtime(['invented repository claim']) });
  assert.equal(invalid.status, 'unverified');
  assert.equal(invalid.completed, false);
  assert.equal(invalid.stopReason, 'invalid_review_result');
  const contradictory = await reviewAnswerEvidence({ ...base, text: 'Rest for today.', modelRuntime: runtime([], true, ['invented']) });
  assert.equal(contradictory.stopReason, 'invalid_review_result');
});
