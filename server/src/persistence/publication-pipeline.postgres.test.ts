import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres-store.js';
import { parseAnalysisPayloadEnvelope } from './analysis-payload.js';
import { FACT_CHUNK_FORMAT } from './fact-chunk-dictionary.js';
import { LocalSnapshotObjectStore } from './snapshot-object-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';
import { buildSnapshot } from '../analysis/graph.js';
import { buildFullPlan, createAnalysisCache, takeCheckpointAnalysisCache } from '../analysis/incremental.js';
import { preparePublicationCache, preparePublicationSnapshot } from '../analysis/publication-snapshot.js';
import type { ParsedFile } from '../analysis/facts.js';
const databaseUrl = process.env.WTR_PUBLICATION_TEST_DATABASE_URL;

test('checkpoint publication persists and reloads facts, cache, sources and atomic query rows in PostgreSQL',
  { skip: !databaseUrl, timeout: 60_000 }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const runId = randomUUID().replaceAll('-', '');
  const repository = 'test/pipeline-' + runId;
  const failureFunction = 'wtr_publication_test_fail_' + runId;
  const publicKey = createHash('sha256').update(runId).digest('hex');
  const root = await mkdtemp(join(tmpdir(), 'wtr-publication-pipeline-'));
  const store = new PostgresStore({ root: join(root, 'state'), databaseUrl: databaseUrl!,
    migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'local-publication-test',
    objectStore: new LocalSnapshotObjectStore(join(root, 'objects')), objectAdmissionStore: new LocalPermitStore() });
  try {
    await store.init();
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot);
    const sourceText = 'export const entry = 1;\n';
    await writeFile(join(sourceRoot, 'entry.ts'), sourceText);
    const file: ParsedFile = { path: 'entry.ts', language: 'typescript', bytes: Buffer.byteLength(sourceText), digest: createHash('sha256').update(sourceText).digest('hex'),
      symbols: [], imports: [], calls: [], parseError: null };
    const manifest = [{ path: file.path, bytes: file.bytes, digest: file.digest }];
    const snapshot = buildSnapshot({ snapshotId: 'pipeline-test', repository,
      commitSha: 'b'.repeat(40), files: [file], sourceRoot });
    const fact = snapshot.fact_graph.nodes[0]!;
    snapshot.fact_graph.nodes = Array.from({ length: 2_101 }, (_, index) => ({ ...fact,
      id: index === 0 ? fact.id : `test-node:${index}`, label: `Unicode node ${index}`, name: `Unicode node ${index}` }));
    snapshot.fact_graph.edges = Array.from({ length: 2_101 }, (_, index) => ({ id: `test-edge:${index}`,
      source: snapshot.fact_graph.nodes[index]!.id, target: fact.id, relation_kind: 'calls', label: 'calls',
      description: 'A static call.', certainty: 'verified', weight: 1, evidence: [] }));
    const checkpoint = { stage: 'assembly', fetched: { manifest },
      plan: { ...buildFullPlan(manifest), affectedStableIds: snapshot.fact_graph.nodes.slice(0,32).map(row=>row.id) },
      parsed: [file], syntax_files: [], lsp_results: [] };
    await store.saveAnalysisCheckpoint('pipeline-checkpoint', checkpoint, snapshot);
    const loadedCheckpoint = await store.loadAnalysisCheckpoint<typeof checkpoint>('pipeline-checkpoint', { deferPublication: true });
    assert.ok(loadedCheckpoint?.loadPublication); assert.equal(loadedCheckpoint.snapshot, null);
    const expectedCache = createAnalysisCache({ manifest, parsedFiles: [file], lspResults: [] });
    const cache = await preparePublicationCache(takeCheckpointAnalysisCache(loadedCheckpoint.checkpoint), data =>
      store.preparePublicSnapshotAnalysisCache({ publicKey, snapshotId: snapshot.snapshot_id, cache: data }));
    assert.equal(await store.loadPublicSnapshot(publicKey), null, 'cache upload alone must not publish');
    const graphs = await loadedCheckpoint.loadPublication();
    const prepared = preparePublicationSnapshot({ snapshot: graphs.snapshot as typeof snapshot, plan: checkpoint.plan,
      currentParsedFiles: cache.files, previousFactGraph: null, displayLanguage: 'en' });
    const analysis = { ...prepared.analysis, analysis_cache: expectedCache };
    const preparedCache = cache.prepared;
    const input = { publicKey, repository, commitSha: 'b'.repeat(40),
      snapshotId: snapshot.snapshot_id, sourceRoot, view: prepared.view, analysis:prepared.analysis, preparedAnalysisCache:preparedCache };
    const timings = await store.savePublicSnapshot(input);
    assert.ok((timings.analysis_dictionary_chunks ?? 0) > 0);
    const envelopeKey = (await store.pool.query('SELECT analysis_storage_key FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[publicKey])).rows[0].analysis_storage_key;
    const envelopeBody = await store.snapshotObjects.get(envelopeKey); assert.ok(envelopeBody);
    const envelope = parseAnalysisPayloadEnvelope(JSON.parse(Buffer.from(envelopeBody).toString()));
    assert.ok(envelope?.chunks.some(chunk=>chunk.format===FACT_CHUNK_FORMAT));
    const expected = JSON.parse(JSON.stringify(analysis)) as typeof analysis;
    const bundle = await store.loadPublicSnapshot<typeof analysis>(publicKey);
    assert.ok(bundle);
    assert.deepEqual(bundle.analysis.fact_graph, expected.fact_graph);
    assert.deepEqual(bundle.analysis.analysis_cache, expected.analysis_cache);
    const source = await store.readPublicSourceLines(publicKey, snapshot.snapshot_id, 'entry.ts', 1, 2);
    assert.deepEqual(source.lines, ['export const entry = 1;', '']);
    const before = (await store.pool.query('SELECT directory_digest, node_count, edge_count FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0];
    assert.equal(Number(before.edge_count), 2_101);
    const rows = await store.pool.query('SELECT node_id FROM snapshot_query_nodes WHERE public_snapshot_key=$1 AND node_kind=$2', [publicKey, 'fact']);
    assert.deepEqual(rows.rows.map(row => row.node_id).sort(), analysis.fact_graph!.nodes.map(row => row.id).sort());
    const directoryId = String((await store.pool.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].directory_id);
    assert.match(directoryId, /^\d+$/);
    const children = async () => Number((await store.pool.query(`SELECT count(*)::int AS n FROM pg_inherits
      WHERE inhparent IN ('snapshot_directory_nodes'::regclass,'snapshot_directory_edges'::regclass)`)).rows[0].n);
    const beforeChildren = await children();
    await store.pool.query(`CREATE FUNCTION ${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.public_snapshot_key='${publicKey}'
        THEN RAISE EXCEPTION 'publication_test_injected_failure'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER ${failureFunction} BEFORE UPDATE ON snapshot_query_directories
      FOR EACH ROW EXECUTE FUNCTION ${failureFunction}();`);
    try {
      await assert.rejects(store.savePublicSnapshot(input), /publication_test_injected_failure/);
      assert.deepEqual((await store.pool.query('SELECT directory_digest, node_count, edge_count FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0], before);
      assert.deepEqual((await store.loadPublicSnapshot<typeof analysis>(publicKey))?.analysis, expected);
      const abandoned = (await store.pool.query(`SELECT g.directory_id FROM snapshot_directory_generations g
        JOIN snapshot_directory_reclamation q USING(directory_id)
        WHERE g.public_snapshot_key=$1 AND NOT EXISTS
          (SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id)`, [publicKey])).rows;
      assert.equal(abandoned.length, 1, 'failed parallel staging is invisible and durably queued');
      for (let pass = 0; pass < 40; pass++) {
        await reclaimSnapshotDirectoryBatch(store.pool);
        if (!(await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1',
          [abandoned[0].directory_id])).rowCount) break;
      }
      assert.equal(await children(),beforeChildren,'bounded reclamation removes failed staging children');
    } finally {
      await store.pool.query(`DROP TRIGGER ${failureFunction} ON snapshot_query_directories; DROP FUNCTION ${failureFunction}();`);
    }
  } finally {
    const ids = await store.pool.query('SELECT directory_id FROM snapshot_directory_generations WHERE public_snapshot_key=$1',[publicKey]).catch(() => ({rows:[]}));
    for (const row of ids.rows) {
      const id = String(row.directory_id);
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error('test_directory_id_invalid');
      await store.pool.query(`DROP TABLE IF EXISTS snapshot_directory_evidence_links_g${id}, snapshot_directory_evidence_g${id},
        snapshot_directory_edges_g${id}, snapshot_directory_nodes_g${id}`).catch(()=>undefined);
    }
    await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1', [publicKey]).catch(() => undefined);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
