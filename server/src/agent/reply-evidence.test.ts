import assert from 'node:assert/strict';
import test from 'node:test';
import { assignBlockEvidenceIds, distinctEvidence, combineBlockReviews, type ReplyEvidenceBlock } from './reply-evidence.js';
import { unavailableEvidenceReview } from './citation-review.js';
const ref = { stable_id: 'same', label: 'same', path: 'src/index.ts', start_line: 1, end_line: 10, kind: 'source_excerpt', snapshot_id: 'snapshot' };

test('independent block IDs ignore order and citation coverage retains assigned IDs', () => {
  const make = (): ReplyEvidenceBlock[] => [
    { kind: 'assessment', text: 'feedback', evidence: [ref] },
    { kind: 'question', text: 'question', evidence: [{ ...ref, start_line: 2, end_line: 3 }], citation_coverage: { parsed: 1, resolved: 1,
      references: [{ reference: 'src/index.ts:2-3', resolved: true, evidence: [{ ...ref, start_line: 2, end_line: 3 }], reason: null }] } },
  ];
  const forward = make(), reverse = make().reverse();
  assignBlockEvidenceIds(forward); assignBlockEvidenceIds(reverse);
  assert.deepEqual(forward.map(block => block.evidence), reverse.reverse().map(block => block.evidence));
  assert.equal(forward[1].evidence.length, 1);
  assert.notEqual(forward[0].evidence[0].stable_id, forward[1].evidence[0].stable_id);
  assert.equal(forward[1].citation_coverage?.references[0].evidence[0].stable_id, forward[1].evidence[0].stable_id);
});

test('dedup requires identical snapshot path range and identity', () => {
  assert.equal(distinctEvidence([ref, { ...ref }, { ...ref, stable_id: 'other' }, { ...ref, snapshot_id: 'other' }, { ...ref, start_line: 2 }]).length, 4);
});

test('non-applicable blocks with incomplete coverage prevent whole-turn support without rewriting semantic findings', () => {
  const supported = { ...unavailableEvidenceReview(), status: 'reviewed' as const, completed: true, supported: true,
    acceptedEvidenceIds: ['same'], summary: 'Assessment is supported.', coverage: { complete: true, packets: [], reasons: [] } };
  for (const failure of ['source', 'coverage'] as const) {
    const nonClaim = { ...unavailableEvidenceReview(), status: 'not_applicable' as const, completed: true,
      summary: 'No repository claim.', evidenceIncomplete: failure === 'source',
      coverage: { complete: failure !== 'coverage', packets: [], reasons: failure === 'coverage' ? ['read_failed' as const] : [] } };
    const combined = combineBlockReviews([supported, nonClaim]);
    assert.equal(combined.status, 'unverified');
    assert.equal(combined.supported, false);
    assert.equal(combined.completed, true);
    assert.equal(combined.evidenceIncomplete, true);
    assert.deepEqual(combined.acceptedEvidenceIds, ['same']);
    assert.deepEqual(combined.issues, []);
    assert.deepEqual(combined.unsupportedClaims, []);
    assert.equal(combined.summary, 'Assessment is supported.\nNo repository claim.');
  }
});
