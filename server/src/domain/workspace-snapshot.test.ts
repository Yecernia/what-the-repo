import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceSnapshot } from './snapshot.js';
import { workspaceSnapshot, workspaceSnapshotDetail } from './workspace-snapshot.js';

test('workspace projection preserves topology and counts without mutating the complete snapshot', () => {
  const evidence = (id: string) => ({ stable_id: id, label: id, path: `${id}.ts`, start_line: 1, end_line: 2, kind: 'file' });
  const snapshot = {
    snapshot_id: 's1', display_language: 'en', summary: { component_count: 1 },
    graph: {
      semantic_mode: 'provider_supported', nodes: [{ id: 'n1', name: 'Node', members: [evidence('m1'), evidence('m2')],
        member_count: 2, evidence: [evidence('e1'), evidence('e2')], source_observations: [{ large: true }] }],
      edges: [{ id: 'r1', source: 'n1', target: 'n1', evidence: [evidence('r1a'), evidence('r1b')],
        source_observations: [{ large: true }] }],
      layers: [{ id: 'l1', evidence: [evidence('l1a'), evidence('l1b')], component_ids: ['n1'] }],
      unassigned_component_ids: [], overlays: [{ id: 'o1', member_entity_ids: ['n1'], relation_ids: ['r1'], evidence_ids: ['e1', 'e2'] }],
      projections: {
        human: { snapshot_id: 's1', nodes: [{ entity_id: 'n1', aggregate_member_entity_ids: ['n1'], evidence_ids: ['e1', 'e2'] }],
          edges: [{ aggregate_relation_ids: ['r1'], evidence_ids: ['r1a', 'r1b'] }] },
        agent: { snapshot_id: 's1', nodes: [{ evidence_ids: ['secret'] }], edges: [] },
      },
    },
    value_points: [{ title: 'Value', evidence: [evidence('v1'), evidence('v2')] }],
    languages: [], learning_plan: { snapshot_id: 's1', selected_value_point: null, steps: [] },
    static_analysis: { files: [{ large: true }] },
  } as unknown as EvidenceSnapshot;
  const original = JSON.stringify(snapshot);
  const view = workspaceSnapshot(snapshot);
  assert.equal(view.view, 'workspace-v1');
  assert.equal(view.graph.nodes[0]!.members.length, 1);
  assert.equal(view.graph.nodes[0]!.members_total, 2);
  assert.equal(view.graph.nodes[0]!.evidence_total, 2);
  assert.equal(view.graph.edges[0]!.evidence_total, 2);
  assert.equal(view.graph.layers[0]!.evidence_total, 2);
  assert.deepEqual(view.graph.overlays?.[0]?.member_entity_ids, ['n1']);
  assert.deepEqual(view.graph.projections?.human.edges[0]?.aggregate_relation_ids, ['r1']);
  assert.equal(view.graph.projections?.human.edges[0]?.evidence_total, 2);
  assert.equal('agent' in (view.graph.projections ?? {}), false);
  assert.equal('source_observations' in view.graph.edges[0]!, false);
  assert.equal('static_analysis' in view, false);
  assert.equal(view.value_points[0]?.evidence.length, 2);
  assert.equal(JSON.stringify(snapshot), original);
  assert.equal(workspaceSnapshotDetail(snapshot, 'component', 'n1'), snapshot.graph.nodes[0]);
  assert.equal(workspaceSnapshotDetail(snapshot, 'relation', 'r1'), snapshot.graph.edges[0]);
  assert.equal(workspaceSnapshotDetail(snapshot, 'layer', 'l1'), snapshot.graph.layers[0]);
  assert.equal(workspaceSnapshotDetail(snapshot, 'relation', 'missing'), null);
});
