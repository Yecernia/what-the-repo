import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductStore } from '../persistence/store.js';
import type { EvidenceSnapshot, SnapshotEvidence } from '../domain/snapshot.js';
import { prepareReplyEvidence } from './reply-validation.js';
import type { ConversationReply } from './conversation-reply.js';

const evidence = (count: number) => new Map(Array.from({ length: count }, (_, i) => {
  const row: SnapshotEvidence = { stable_id: `source:${i}`, label: 'source', path: `src/file${i}.ts`,
    start_line: 1, end_line: 1, kind: 'source_excerpt' };
  return [row.stable_id, row] as const;
}));
const snapshot = { snapshot_id: 'snapshot', graph: { nodes: [], edges: [], layers: [] }, value_points: [] } as unknown as EvidenceSnapshot;

test('UJ-01 receipt-only actions do not read or inherit exploration evidence at any packet boundary', async () => {
  for (const count of [0, 12, 13, 29]) {
    const prepared = await prepareReplyEvidence({ reply: { kind: 'action', text: '', question: null, evidenceBlocks: [] },
      text: '', getSnapshot: async () => { assert.fail('receipt-only action must not load source'); }, snapshotId: 'snapshot',
      projectId: 'project', exposed: evidence(count), store: {
        readSourceLines: async () => { assert.fail('receipt-only action must not read packets'); },
      } as unknown as ProductStore });
    assert.deepEqual(prepared.errors, []);
    assert.deepEqual(prepared.blocks, []);
    assert.deepEqual(prepared.validation.evidence, []);
  }
});

test('UJ-01 action supplements and ordinary reply partitions still validate their real citations', async () => {
  for (const kind of ['action', 'answer', 'lesson', 'assessment'] as const) {
    const text = 'See `src/missing.ts:1`.';
    const blockKind = kind === 'assessment' ? 'assessment' : kind === 'lesson' ? 'question' : 'explanation';
    const reply: ConversationReply = { kind, text, question: null, evidenceBlocks: [{ kind: blockKind, text, evidence: [] }] };
    const result = await prepareReplyEvidence({ reply, text, getSnapshot: async () => snapshot, snapshotId: 'snapshot',
      projectId: 'project', exposed: evidence(29), store: { listSourceFiles: async () => [] } as unknown as ProductStore });
    assert.ok(result.errors.includes('unknown_path:src/missing.ts'));
    assert.equal(result.blocks[0].commit_eligible, false);
  }
});
