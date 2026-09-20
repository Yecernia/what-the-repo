import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot } from './graph.js';
import type { ParsedFile } from './facts.js';
import { applyIncrementalProvenance, buildFullPlan, buildIncrementalPlan, createAnalysisCache } from './incremental.js';
import { preparePublicationSnapshot } from './publication-snapshot.js';
import { extractSnapshotLanguageOverlay, stripSnapshotLanguage } from '../domain/snapshot-language.js';
import { assertValidEvidenceSnapshot } from '../domain/snapshot-validation.js';
import { snapshotPublicView } from '../domain/snapshot-public-view.js';

function fixture() {
  const file: ParsedFile = { path: 'entry.ts', language: 'typescript', digest: 'a'.repeat(64),
    bytes: 10, symbols: [], imports: [], calls: [], parseError: null };
  const manifest = [{ path: file.path, digest: file.digest, bytes: file.bytes }];
  const snapshot = buildSnapshot({ snapshotId: 'publish-test', repository: 'test/publication',
    commitSha: 'b'.repeat(40), files: [file], sourceRoot: '/not-used' });
  snapshot.fact_graph.edges.push({ id: 'test-edge', source: snapshot.fact_graph.nodes[0]!.id,
    target: snapshot.fact_graph.nodes[0]!.id, relation_kind: 'calls', label: 'calls',
    description: 'The function calls itself.', certainty: 'verified', evidence: [], weight: 1 });
  return { file, manifest, snapshot, plan: buildFullPlan(manifest) };
}

test('shared publication preparation preserves output without copying owned fact edges', () => {
  const { snapshot, plan, file } = fixture();
  const old = applyIncrementalProvenance({ snapshot: structuredClone(snapshot), plan,
    previousFactGraph: null, currentParsedFiles: [file] });
  const expectedOverlay = extractSnapshotLanguageOverlay(old, 'en');
  const expected = assertValidEvidenceSnapshot(stripSnapshotLanguage(old));
  const edge = snapshot.fact_graph.edges[0];
  const result = preparePublicationSnapshot({ snapshot, plan, previousFactGraph: null,
    currentParsedFiles: [file], displayLanguage: 'en' });
  assert.strictEqual(result.analysis.fact_graph?.edges[0], edge);
  assert.deepEqual(result.analysis.fact_graph, expected.fact_graph);
  assert.deepEqual(result.view, snapshotPublicView(expected));
  assert.deepEqual({ ...result.languageOverlay, generated_at: '' }, { ...expectedOverlay, generated_at: '' });
  assert.equal(result.analysis.active_fact_fingerprint, old.active_fact_fingerprint);
  assert.ok(result.timings.preparation_validation_rss_bytes! > 0);
  assert.equal(result.view.fact_graph, undefined);
});

test('already-provenanced publication does not require compiler facts or a recomputation plan', () => {
  const { snapshot } = fixture();
  assert.doesNotThrow(() => preparePublicationSnapshot({ snapshot, previousFactGraph: null,
    currentParsedFiles: [], displayLanguage: 'en', provenanceApplied: true }));
  assert.throws(() => preparePublicationSnapshot({ snapshot, previousFactGraph: null,
    currentParsedFiles: [], displayLanguage: 'en' }), /analysis_publication_plan_missing/);
});

test('owned incremental publication protects facts aliased from the previous snapshot', () => {
  const { snapshot, plan: full, file, manifest } = fixture();
  const previous = applyIncrementalProvenance({ snapshot, plan: full,
    previousFactGraph: null, currentParsedFiles: [file] });
  const saved = structuredClone(previous.fact_graph);
  for (const row of [...previous.fact_graph.nodes, ...previous.fact_graph.edges]) Object.freeze(row);
  const current = { ...buildSnapshot({ snapshotId: 'next-snapshot', repository: 'test/publication',
    commitSha: 'b'.repeat(40), files: [file], sourceRoot: '/not-used' }), fact_graph: {
    nodes: [...previous.fact_graph.nodes], edges: [...previous.fact_graph.edges],
  } };
  const plan = buildIncrementalPlan({ parentSnapshotId: previous.snapshot_id,
    previousCache: createAnalysisCache({ manifest, parsedFiles: [file], lspResults: [] }),
    previousFactGraph: previous.fact_graph, currentManifest: manifest,
    currentCompleteness: { inventoryComplete: true, knownSourceFiles: 1, omitted: [], reasons: [] } });
  const result = preparePublicationSnapshot({ snapshot: current, plan,
    previousFactGraph: previous.fact_graph, currentParsedFiles: [file], displayLanguage: 'en' });
  assert.deepEqual(previous.fact_graph, saved);
  assert.notStrictEqual(result.analysis.fact_graph?.nodes[0], previous.fact_graph.nodes[0]);
  assert.notStrictEqual(result.analysis.fact_graph?.edges[0], previous.fact_graph.edges[0]);
});
