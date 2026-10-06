import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceSnapshot, SnapshotEvidence } from '../domain/snapshot.js';
import type { ProductStore } from '../persistence/store.js';
import { validateAnswerCitations } from './citations.js';

const anchor: SnapshotEvidence = { stable_id: 'source', label: 'source', path: 'src/index.ts', start_line: 1, end_line: 40, kind: 'symbol' };
const snapshot = { snapshot_id: 'snapshot', graph: { nodes: [{ evidence: [anchor], members: [] }], edges: [], layers: [] }, value_points: [] } as unknown as EvidenceSnapshot;
const store = { listSourceFiles: async () => ['src/index.ts'], readSourceLines: async (_p: string, _s: string, _f: string, start: number, end: number) => ({ lines: Array.from({ length: Math.max(0, Math.min(40, end) - start + 1) }, () => 'source'), truncated: false }) } as unknown as ProductStore;
const base = { snapshot, projectId: 'project', store, exposed: new Map<string, SnapshotEvidence>() };

test('all thirteen exact citations survive and ordering ignores prose order', async () => {
  const refs = Array.from({ length: 13 }, (_, i) => `\`src/index.ts:${i + 1}\``);
  const results = await Promise.all([refs, [...refs].reverse()].map(rows => validateAnswerCitations({ ...base, text: rows.join(' ') })));
  assert.deepEqual(results[0].evidence, results[1].evidence);
  assert.equal(results[0].evidence.length, 13);
  assert.equal(results[0].coverage.parsed, 13);
  assert.equal(results[0].coverage.resolved, 13);
});

test('overlaps remain exact while contained bare reads retain explicit coverage', async () => {
  const read: SnapshotEvidence = { ...anchor, stable_id: 'read', start_line: 5, end_line: 7, kind: 'source_excerpt' };
  const exposed = new Map([[read.stable_id, read]]);
  const refs = ['`src/index.ts`', '`src/index.ts:4-8`', '`src/index.ts:7-10`'];
  for (const rows of [refs, [...refs].reverse()]) {
    const result = await validateAnswerCitations({ ...base, exposed, text: rows.join(' ') });
    assert.deepEqual(result.evidence.map(row => [row.start_line, row.end_line]), [[4, 8], [7, 10]]);
    const bare = result.coverage.references.find(row => !row.explicit)!;
    assert.deepEqual(bare.evidence.map(row => [row.start_line, row.end_line]), [[5, 7]]);
    assert.deepEqual(bare.covered_by?.map(row => [row.start_line, row.end_line]), [[4, 8]]);
  }
  const uncovered = await validateAnswerCitations({ ...base, exposed, text: '`src/index.ts` `src/index.ts:6-8`' });
  assert.deepEqual(uncovered.evidence.map(row => [row.start_line, row.end_line]), [[5, 7], [6, 8]]);
  assert.equal(uncovered.coverage.references[0].covered_by, undefined);
});

test('invalid and read-failed references stay visible as distinct coverage reasons', async () => {
  const invalid = await validateAnswerCitations({ ...base, text: '`missing.ts:2` `src/index.ts:0` `src/index.ts:41`' });
  assert.equal(invalid.coverage.parsed, 3);
  assert.equal(invalid.coverage.resolved, 0);
  assert.ok(invalid.coverage.references.every(row => row.reason === 'invalid_reference'));
  const failed = await validateAnswerCitations({ ...base, text: '`src/index.ts:2`', store: { ...store, readSourceLines: async () => { throw new Error('secret'); } } as ProductStore });
  assert.equal(failed.coverage.references[0].reason, 'read_failed');
  assert.deepEqual(failed.errors, ['read_failed:src/index.ts:2']);
  const manifestFailed = await validateAnswerCitations({ ...base, text: '`src/index.ts:2`', store: { ...store, listSourceFiles: async () => { throw new Error('secret'); } } as ProductStore });
  assert.equal(manifestFailed.coverage.references[0].reason, 'read_failed');
  assert.equal(manifestFailed.coverage.parsed, 1);
});
