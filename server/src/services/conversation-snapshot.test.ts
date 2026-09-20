import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductStore } from '../persistence/store.js';
import { loadConversationSnapshot } from './conversation-snapshot.js';

test('canonical chat loads only the view, while local snapshots retain their fact graph', async () => {
  let reads = 0;
  const graph = { nodes: [], edges: [] };
  const store = {
    loadSnapshot: async () => ({ snapshot_id: 'snapshot:test', graph }),
    loadAnalysisResult: async () => { reads++; return { fact_graph: graph }; },
  } as unknown as ProductStore;
  const canonical = await loadConversationSnapshot(store, 'project', true);
  assert.equal(canonical?.snapshot_id, 'snapshot:test');
  assert.equal(canonical?.fact_graph, undefined);
  assert.equal(reads, 0);
  const local = await loadConversationSnapshot(store, 'project', false);
  assert.equal(local?.fact_graph, graph);
  assert.equal(reads, 1);
});

test('missing views do not hydrate the analysis cache', async () => {
  const store = { loadSnapshot: async () => null,
    loadAnalysisResult: async () => { throw new Error('unexpected full read'); },
  } as unknown as ProductStore;
  assert.equal(await loadConversationSnapshot(store, 'missing', false), null);
});
