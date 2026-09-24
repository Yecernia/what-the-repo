import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';
import { snapshotObjectDigest, type SnapshotObjectStore, type StoredObject } from './snapshot-object-store.js';

class MemoryObjects implements SnapshotObjectStore {
  readonly kind = 'local' as const;
  readonly values = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array): Promise<StoredObject> {
    this.values.set(key, Buffer.from(body));
    return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
  async delete(key: string) { this.values.delete(key); }
}

const KINDS = ['nodes', 'edges', 'evidence', 'evidence_links'] as const;

function snapshot(snapshotId: string, size: number) {
  const evidence = (id: string, line: number) => ({ stable_id: id, label: id, path: `src/${line % 7}.ts`,
    start_line: line, end_line: line, kind: 'symbol' });
  const nodes = Array.from({ length: size }, (_, index) => ({ id: `n${index}`, name: `n${index}`, members: [],
    certainty: 'verified', attributes: { path: `src/${index % 7}.ts` }, evidence: [evidence(`ev-n${index}`, index + 1)] }));
  const edges = Array.from({ length: size - 1 }, (_, index) => ({ id: `e${index}`, source: `n${index}`, target: `n${index + 1}`,
    relation_kind: 'calls', label: 'calls', description: 'calls', certainty: 'verified', weight: 1,
    evidence: [evidence(`ev-e${index}`, index + 2)] }));
  return {
    view: { snapshot_id: snapshotId, summary: { file_count: 7, symbol_count: size, call_count: size - 1 },
      graph: { semantic_mode: 'static', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
      value_points: [], languages: [], learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] } },
    analysis: { snapshot_id: snapshotId, fact_graph: { nodes, edges } },
  };
}

test('isolated PostgreSQL: parallel directory loading binds complete child generations and reclaims failed or abandoned staging',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
  const url = process.env.WTR_ADMIN_TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const root = await mkdtemp(join(tmpdir(), 'wtr-directory-parallel-'));
  const store = new PostgresStore({ root, databaseUrl: url, migrationsRoot: join(process.cwd(), 'migrations'),
    encryptionSecret: 'directory-parallel-test-only', poolMax: 4, objectStore: new MemoryObjects() });
  const publicKey = 'd'.repeat(64);
  const publish = async (snapshotId: string) => {
    const sourceRoot = join(root, 'source-' + snapshotId.replaceAll(':', '-'));
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'README.md'), 'source\n');
    const value = snapshot(snapshotId, 400);
    return store.savePublicSnapshot({ publicKey, repository: 'example/parallel', commitSha: 'a'.repeat(40), snapshotId,
      sourceRoot, view: value.view, analysis: value.analysis });
  };
  const current = async () => (await store.pool.query('SELECT directory_id, snapshot_id FROM snapshot_query_directories WHERE public_snapshot_key=$1',
    [publicKey])).rows[0] as { directory_id: string; snapshot_id: string } | undefined;
  const child = async (kind: string, id: string) =>
    (await store.pool.query('SELECT to_regclass($1) AS name', [`public.snapshot_directory_${kind}_g${id}`])).rows[0].name;
  const reclaimAll = async () => {
    for (let i = 0; i < 60; i++) {
      const result = await reclaimSnapshotDirectoryBatch(store.pool);
      if (result.status === 'idle') {
        const pending = await store.pool.query('SELECT 1 FROM snapshot_directory_reclamation');
        if (!pending.rowCount) return;
      }
    }
    assert.fail('reclamation did not finish');
  };
  try {
    await store.init();
    const first = await publish('snap:parallel:1');
    const bound = await current();
    assert.ok(bound);
    for (const kind of KINDS) assert.ok(await child(kind, bound.directory_id), kind + ' child exists');
    assert.ok(first.directory_evidence_links_index_build_ms! >= 0 && first.directory_nodes_index_build_ms! >= 0);
    const counts = (await store.pool.query(`SELECT
      (SELECT count(*) FROM snapshot_directory_nodes WHERE directory_id=$1)::int AS nodes,
      (SELECT count(*) FROM snapshot_directory_edges WHERE directory_id=$1)::int AS edges,
      (SELECT count(*) FROM snapshot_directory_evidence WHERE directory_id=$1)::int AS evidence,
      (SELECT count(*) FROM snapshot_directory_evidence_links WHERE directory_id=$1)::int AS links,
      (SELECT staging_expires_at FROM snapshot_directory_generations WHERE directory_id=$1) AS expires`, [bound.directory_id])).rows[0];
    assert.deepEqual({ ...counts }, { nodes: 400, edges: 399, evidence: 799, links: 799, expires: null });
    const read = await store.readPublicSnapshotEvidence({ publicKey, snapshotId: 'snap:parallel:1', evidenceIds: ['ev-n3', 'ev-e5'] });
    assert.deepEqual(read.map(row => row.stable_id), ['ev-n3', 'ev-e5']);
    // The links' evidence foreign key is validated against the same generation.
    await assert.rejects(store.pool.query(`INSERT INTO snapshot_directory_evidence_links_g${bound.directory_id}
      (directory_id, evidence_id, owner_kind, owner_key, role) VALUES ($1,'missing','node','x','evidence')`, [bound.directory_id]), /foreign key/);

    await publish('snap:parallel:2');
    const second = await current();
    assert.equal(second?.snapshot_id, 'snap:parallel:2');
    await reclaimAll();
    for (const kind of KINDS) assert.equal(await child(kind, bound.directory_id), null, kind + ' child dropped');
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1', [bound.directory_id])).rowCount, 0);

    // A failing lane leaves the published pointer untouched and queues its staging generation.
    const patched = new Map<PoolClient, PoolClient['query']>();
    // Every checkout, including pool.query, emits acquire; forward all arguments.
    const inject = (client: PoolClient) => {
      if (patched.has(client)) return;
      const query = client.query;
      patched.set(client, query);
      client.query = ((...args: unknown[]) => typeof args[0] === 'string' && args[0].includes('finish_snapshot_directory_child')
        && (args[1] as unknown[] | undefined)?.[1] === 'edges' ? Promise.reject(new Error('injected_edge_failure'))
        : (query as (...params: unknown[]) => unknown).apply(client, args)) as PoolClient['query'];
    };
    store.pool.on('acquire', inject);
    try {
      await assert.rejects(publish('snap:parallel:3'), /injected_edge_failure/);
    } finally {
      store.pool.off('acquire', inject);
      for (const [client, query] of patched) client.query = query;
    }
    assert.equal((await current())?.snapshot_id, 'snap:parallel:2');
    const failed = (await store.pool.query(`SELECT g.directory_id FROM snapshot_directory_generations g
      JOIN snapshot_directory_reclamation q USING(directory_id) WHERE g.public_snapshot_key=$1`, [publicKey])).rows;
    assert.equal(failed.length, 1);
    await reclaimAll();
    for (const kind of KINDS) assert.equal(await child(kind, failed[0].directory_id), null);

    // A crashed publication's expired staging generation is found by maintenance.
    const abandoned = (await store.pool.query(`INSERT INTO snapshot_directory_generations(public_snapshot_key, snapshot_id, staging_expires_at)
      VALUES ($1, 'snap:parallel:abandoned', clock_timestamp() - interval '1 minute') RETURNING directory_id`, [publicKey])).rows[0].directory_id;
    await store.pool.query('SELECT public.stage_snapshot_directory_child($1::bigint, $2::text)', [abandoned, 'evidence']);
    await reclaimAll();
    assert.equal(await child('evidence', abandoned), null);
    assert.equal((await store.pool.query('SELECT 1 FROM snapshot_directory_generations WHERE directory_id=$1', [abandoned])).rowCount, 0);
    assert.equal((await current())?.snapshot_id, 'snap:parallel:2');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
