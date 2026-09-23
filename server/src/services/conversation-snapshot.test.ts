import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductStore } from '../persistence/store.js';
import { createProject } from '../domain/conversation.js';
import { conversationSummaryFromSource } from '../domain/conversation-summary.js';
import { createConversationSnapshotReader, createConversationSummaryReader, loadConversationSnapshot } from './conversation-snapshot.js';

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

test('per-turn snapshot reader stays idle and shares one full view for parallel callers', async () => {
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = 'snapshot:test';
  project.analysis.canonical_snapshot_key = 'canonical';
  let reads = 0;
  const store = {
    loadProject: async () => project,
    loadSnapshot: async () => { reads++; await Promise.resolve(); return {
      snapshot_id: 'snapshot:test', graph: { nodes: [], edges: [] },
    }; },
    loadAnalysisResult: async () => { throw new Error('canonical analysis must stay cold'); },
  } as unknown as ProductStore;
  const getSnapshot = createConversationSnapshotReader(store, {
    projectId: project.project_id, ownerId: project.owner_id,
    snapshotId: 'snapshot:test', publicSnapshotKey: 'canonical',
  });
  assert.equal(reads, 0);
  const [first, second] = await Promise.all([getSnapshot(), getSnapshot()]);
  assert.strictEqual(first, second);
  assert.equal(reads, 1);
  assert.strictEqual(await getSnapshot(), first);
  assert.equal(reads, 1);
});

test('deferred view refuses a changed binding or returned snapshot and retains read failures', async () => {
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = 'snapshot:test';
  project.analysis.canonical_snapshot_key = 'canonical';
  let reads = 0;
  const store = {
    loadProject: async () => project,
    loadSnapshot: async () => { reads++; return {
      snapshot_id: 'snapshot:other', graph: { nodes: [], edges: [] },
    }; },
  } as unknown as ProductStore;
  const input = { projectId: project.project_id, ownerId: project.owner_id,
    snapshotId: 'snapshot:test', publicSnapshotKey: 'canonical' };
  const stale = createConversationSnapshotReader(store, input);
  await assert.rejects(stale(), { code: 'snapshot_changed' });
  await assert.rejects(stale(), { code: 'snapshot_changed' });
  assert.equal(reads, 1);
  project.analysis.canonical_snapshot_key = 'new-binding';
  const rebound = createConversationSnapshotReader(store, input);
  await assert.rejects(rebound(), { code: 'snapshot_changed' });
  assert.equal(reads, 1, 'changed binding is rejected before full read');
  project.analysis.canonical_snapshot_key = 'canonical';
  const failed = new Error('storage unavailable');
  store.loadSnapshot = async () => { reads++; throw failed; };
  const unreadable = createConversationSnapshotReader(store, input);
  await assert.rejects(unreadable(), error => error === failed);
  await assert.rejects(unreadable(), error => error === failed);
  assert.equal(reads, 2);
});

test('summary reader stays idle, shares parallel reads, and never opens a full view', async () => {
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = 'snapshot:test';
  const summary = conversationSummaryFromSource({ snapshot_id: 'snapshot:test', summary: {}, languages: [],
    graph: { semantic_mode: 'provider_supported', nodes: [] }, value_points: [] })!;
  let reads = 0;
  const store = { loadConversationSummary: async () => { reads++; await Promise.resolve(); return summary; },
    loadSnapshot: async () => { throw new Error('unexpected full view'); } } as unknown as ProductStore;
  const getSummary = createConversationSummaryReader(store, {
    project, snapshotId: 'snapshot:test', assertSnapshotBinding: async () => undefined,
  });
  assert.equal(reads, 0);
  const [a, b] = await Promise.all([getSummary(), getSummary()]);
  assert.strictEqual(a, b);
  assert.equal(reads, 1);
  assert.strictEqual(await getSummary(), a);
});

test('summary reader keeps null, wrong identity, binding and storage failures distinct', async () => {
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = 'snapshot:test';
  let reads = 0;
  const store = { loadConversationSummary: async () => { reads++; return null; } } as unknown as ProductStore;
  const input = { project, snapshotId: 'snapshot:test', assertSnapshotBinding: async () => undefined };
  const missing = createConversationSummaryReader(store, input);
  assert.equal(await missing(), null);
  assert.equal(await missing(), null);
  assert.equal(reads, 1);
  store.loadConversationSummary = async () => { reads++; return conversationSummaryFromSource({
    snapshot_id: 'snapshot:other', summary: {}, languages: [],
    graph: { semantic_mode: 'provider_supported', nodes: [] }, value_points: [],
  }); };
  const stale = createConversationSummaryReader(store, input);
  await assert.rejects(stale(), { code: 'snapshot_changed' });
  await assert.rejects(stale(), { code: 'snapshot_changed' });
  assert.equal(reads, 2);
  const failed = new Error('summary storage unavailable');
  store.loadConversationSummary = async () => { reads++; throw failed; };
  const unreadable = createConversationSummaryReader(store, input);
  await assert.rejects(unreadable(), error => error === failed);
  await assert.rejects(unreadable(), error => error === failed);
  assert.equal(reads, 3);
  const rebound = createConversationSummaryReader(store, { ...input,
    assertSnapshotBinding: async () => { throw new Error('binding changed'); } });
  await assert.rejects(rebound(), /binding changed/);
  assert.equal(reads, 3);
});
