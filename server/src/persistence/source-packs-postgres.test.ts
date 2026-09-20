import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from './postgres-store.js';
import { LocalSnapshotObjectStore, type StoredSourceSnapshot } from './snapshot-object-store.js';

test('isolated PostgreSQL: packed sources survive JSONB checkpoints, restart and reclamation',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL, timeout: 120_000 }, async () => {
    const databaseUrl = process.env.WTR_ADMIN_TEST_DATABASE_URL!;
    const url = new URL(databaseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const root = await mkdtemp(join(tmpdir(), 'wtr-source-pack-pg-'));
    const objects = new LocalSnapshotObjectStore(join(root, 'objects'));
    const options = { root, databaseUrl, migrationsRoot: join(process.cwd(), 'migrations'),
      encryptionSecret: 'source-pack-isolated-test', poolMax: 2, objectStore: objects };
    const writer = new PostgresStore(options);
    const reader = new PostgresStore(options);
    let writerClosed = false;
    const publicKey = '7'.repeat(64), snapshotId = 'snap:source-pack-pg';
    try {
      await writer.init();
      const sourceRoot = writer.publicSourceSnapshotRoot(publicKey, snapshotId);
      await mkdir(sourceRoot, { recursive: true });
      const source = 'export const answer = 42;\n'.repeat(100);
      await writeFile(join(sourceRoot, 'a.ts'), source);
      await writeFile(join(sourceRoot, 'b.ts'), 'second\n');
      await writeFile(join(sourceRoot, 'c.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
      await writeFile(join(sourceRoot, 'd.bin'), Buffer.alloc(2 * 1024 * 1024, 9));
      const prepared = await writer.preparePublicSnapshotSource({ publicKey, snapshotId, sourceRoot });
      assert.equal(prepared.manifest.packs?.length, 2);
      // PostgreSQL JSONB changes object key order in persisted stage checkpoints.
      const roundtrip = await writer.pool.query('SELECT $1::jsonb AS checkpoint', [JSON.stringify(prepared)]);
      const restored = roundtrip.rows[0].checkpoint as StoredSourceSnapshot;
      await rm(sourceRoot, { recursive: true, force: true });
      await writer.savePublicSnapshot({ publicKey, snapshotId, repository: 'example/source-pack-pg',
        commitSha: 'a'.repeat(40), preparedSource: restored,
        view: { snapshot_id: snapshotId, summary: { file_count: 4, symbol_count: 0, call_count: 0 },
          graph: { semantic_mode: 'static', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
          value_points: [], languages: [], learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] } },
        analysis: { snapshot_id: snapshotId, fact_graph: { nodes: [], edges: [] } } });
      await writer.close();
      writerClosed = true;
      await reader.init();
      assert.equal((await reader.loadPublicSnapshot(publicKey))?.metadata.analysis_snapshot_id, snapshotId);
      assert.deepEqual(await reader.readPublicSourceLines(publicKey, snapshotId, 'a.ts', 1, 2),
        { lines: ['export const answer = 42;', 'export const answer = 42;'], truncated: false });
      assert.deepEqual(await reader.readPublicSourceLines(publicKey, snapshotId, 'b.ts', 1, 2),
        { lines: ['second', ''], truncated: false });
      await assert.rejects(reader.readPublicSourceLines(publicKey, 'another', 'a.ts', 1, 2), /snapshot/);
      await reader.saveRepositoryHead({ repository_identity: 'example/source-pack-pg',
        analyzer_bundle_version: 'typescript-0.1.0', analysis_config_digest: 'tree-sitter-nine-language-v1',
        current_public_snapshot_key: publicKey, current_commit_sha: 'a'.repeat(40),
        last_checked_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
      await reader.pool.query("UPDATE canonical_public_repository_snapshots SET purge_after='2020-01-01' WHERE public_snapshot_key=$1", [publicKey]);
      assert.equal(await reader.purgePublicSnapshotPayload(publicKey, '2030-01-01T00:00:00.000Z'), false,
        'current head still protects every shared pack');
      await reader.pool.query('DELETE FROM canonical_public_repository_heads WHERE current_public_snapshot_key=$1', [publicKey]);
      assert.equal(await reader.purgePublicSnapshotPayload(publicKey, '2030-01-01T00:00:00.000Z'), true);
      assert.deepEqual(await objects.inventory(), []);
    } finally {
      if (!writerClosed) await writer.close();
      await reader.close();
      await rm(root, { recursive: true, force: true });
    }
  });
