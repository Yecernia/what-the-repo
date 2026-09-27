import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { Pool } from 'pg';
import { streamSnapshotQueryDirectory } from '../domain/snapshot-query.js';
import { insertSnapshotRows } from './postgres-snapshot-rows.js';
import { stageSnapshotQueryDirectory } from './snapshot-directory-publication.js';
import { registerControlPool } from './control-pool.js';
import { parseDirectoryManifest, readDirectoryRows } from './directory-objects.js';
import { LocalSnapshotObjectStore } from './snapshot-object-store.js';
import { cachedObjectStore } from './cached-object-store.js';

const kinds = ['nodes', 'edges', 'evidence', 'evidence_links'] as const;

/** Opt-in synthetic comparison. Never contacts a model or a cloud object store. */
test('isolated PostgreSQL benchmark: identical graph bulk SQL storage before and after object-backed rows',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 120_000 }, async () => {
    const url = new URL(process.env.WTR_ADMIN_TEST_DATABASE_URL!);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const control = new Pool({ connectionString: url.toString(), max: 1 });
    registerControlPool(pool, control);
    const root = await mkdtemp(join(tmpdir(), 'wtr-directory-storage-benchmark-'));
    const local = new LocalSnapshotObjectStore(root);
    const publicKey = 'c'.repeat(64), count = 5000;
    const path = (index: number) => `packages/service-${index % 41}/src/features/module-${index % 317}/handler-${index}.ts`;
    const id = (index: number) => `${path(index)}::handleRequest${index}`;
    const evidence = (prefix: string, index: number) => ({ stable_id: `${prefix}:${index}:${path(index % count)}`,
      label: `Request handling evidence ${index}`, path: path(index % count), start_line: index % 300 + 1,
      end_line: index % 300 + 4, kind: 'symbol', excerpt: `export async function handleRequest${index}(context: RequestContext) { return context.service.execute(); }` });
    const nodes = Array.from({ length: count }, (_, index) => ({ id: id(index), name: `handleRequest${index}`,
      entity_kind: 'function', members: [], certainty: 'verified', evidence: [evidence('node', index)],
      attributes: { path: path(index), language: 'TypeScript', qualified_name: `Service${index % 41}.handleRequest${index}`,
        signature: '(context: RequestContext, options: ExecutionOptions): Promise<Response>',
        responsibilities: ['validate request inputs', 'read application state', 'delegate domain operation'] } }));
    const edges = Array.from({ length: count * 3 }, (_, index) => ({
      id: `call:${id(index % count)}->${id((index * 17 + 3) % count)}:${index}`,
      source: id(index % count), target: id((index * 17 + 3) % count), relation_kind: 'calls',
      label: 'delegates request', description: `Calls domain service from ${path(index % count)} to ${path((index * 17 + 3) % count)}`,
      certainty: 'verified', weight: 1, evidence: [evidence('edge', index)] }));
    const directory = streamSnapshotQueryDirectory(publicKey, 'synthetic-storage', {
      graph: { nodes: [], edges: [], layers: [] }, value_points: [],
    }, { fact_graph: { nodes, edges } });
    const measure = async (generation: string) => {
      const result: Record<string, { tableBytes: number; indexBytes: number }> = {};
      for (const kind of kinds) {
        const table = `snapshot_directory_${kind}_g${generation}`;
        const row = (await pool.query('SELECT pg_table_size($1::regclass)::text AS data,pg_indexes_size($1::regclass)::text AS indexes', [table])).rows[0];
        result[kind] = { tableBytes: Number(row.data), indexBytes: Number(row.indexes) };
      }
      return { families: result, tableBytes: Object.values(result).reduce((sum, row) => sum + row.tableBytes, 0),
        indexBytes: Object.values(result).reduce((sum, row) => sum + row.indexBytes, 0) };
    };
    try {
      const migrations = (await readdir(join(process.cwd(), 'migrations'))).filter(name => /^\d{4}_.+\.sql$/.test(name) && !name.endsWith('.down.sql')).sort();
      for (const name of migrations.filter(name => Number(name.slice(0, 4)) <= 37)) await pool.query(await readFile(join(process.cwd(), 'migrations', name), 'utf8'));
      const oldId = (await pool.query(`INSERT INTO snapshot_directory_generations(public_snapshot_key,snapshot_id,staging_expires_at)
        VALUES ($1,$2,clock_timestamp()+interval '1 hour') RETURNING directory_id`, [publicKey, directory.snapshot_id])).rows[0].directory_id;
      for (const kind of kinds) {
        const table = `snapshot_directory_${kind}_g${oldId}`;
        await pool.query('SELECT public.stage_snapshot_directory_child($1,$2)', [oldId, kind]);
        const columns = (await pool.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
          AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`, [table])).rows.map(row => String(row.attname));
        await insertSnapshotRows<object>(pool, table, columns, directory[kind], row => ({ ...row, directory_id: oldId }));
        await pool.query('SELECT public.finish_snapshot_directory_child($1,$2,$3)', [oldId, kind, directory[kind].length]);
      }
      const before = await measure(oldId);
      const selectedOrdinals = [0, 1, 4, 100, 500, 1024, 2048, 3000, 4096, 4999];
      const sourceRows = [...directory.nodes];
      const expected = selectedOrdinals.map(ordinal => sourceRows[ordinal]);
      // Drop only the four known benchmark children inside its disposable DB.
      assert.match(String(oldId), /^[1-9][0-9]*$/);
      await pool.query('DROP TABLE ' + kinds.map(kind => `snapshot_directory_${kind}_g${oldId}`).join(','));
      await pool.query('DELETE FROM snapshot_directory_generations WHERE directory_id=$1', [oldId]);
      for (const name of migrations.filter(name => Number(name.slice(0, 4)) > 37)) await pool.query(await readFile(join(process.cwd(), 'migrations', name), 'utf8'));
      const client = await pool.connect();
      let newId: string;
      try {
        await client.query('BEGIN');
        newId = await stageSnapshotQueryDirectory(pool, client, directory, { parallelism: 0, objectStore: local });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      const after = await measure(newId!);
      const metadata = (await pool.query('SELECT object_manifest FROM snapshot_directory_generations WHERE directory_id=$1', [newId!])).rows[0].object_manifest;
      const manifest = parseDirectoryManifest(metadata, { publicKey, directoryId: newId! });
      let reads = 0;
      const rawGet = local.get.bind(local);
      local.get = async key => { reads++; return rawGet(key); };
      const cache = cachedObjectStore(local, { maxBytes: 32 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024 });
      const cold = await readDirectoryRows(cache, manifest, 'nodes', selectedOrdinals);
      const coldReads = reads;
      const warm = await readDirectoryRows(cache, manifest, 'nodes', selectedOrdinals);
      const warmReads = reads - coldReads;
      assert.deepEqual(cold, expected);
      assert.deepEqual(warm, expected);
      assert.ok(coldReads > 0); assert.equal(warmReads, 0);
      assert.ok(after.tableBytes + after.indexBytes < before.tableBytes + before.indexBytes);
      const objectBytes = Object.values(manifest.sections).flat().reduce((sum, chunk) => sum + chunk.bytes, 0);
      console.log('SYNTHETIC_DIRECTORY_STORAGE ' + JSON.stringify({ nodes: directory.nodes.length, edges: directory.edges.length,
        evidence: directory.evidence.length, evidenceLinks: directory.evidence_links.length,
        before, after, objectBytes, sqlReductionPercent: 100 * (1 - (after.tableBytes + after.indexBytes) / (before.tableBytes + before.indexBytes)),
        selectedRows: selectedOrdinals.length, coldLocalObjectReads: coldReads, warmLocalObjectReads: warmReads,
        note: 'Synthetic graph; PostgreSQL physical bytes and local filesystem read counts; no cloud latency measurement.' }));
    } finally {
      await Promise.all([pool.end(), control.end()]);
      const target = resolve(root), parent = resolve(tmpdir());
      assert.ok(relative(parent, target).startsWith('wtr-directory-storage-benchmark-'));
      await rm(target, { recursive: true, force: true });
    }
  });
