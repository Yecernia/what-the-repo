import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../domain/conversation.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
import { extractSnapshotLanguageOverlay, SNAPSHOT_LANGUAGE_OVERLAY_VERSION } from '../domain/snapshot-language.js';
import { FileStore } from './file-store.js';
import { PostgresStore } from './postgres-store.js';

const key = 'a'.repeat(64);
const snapshotId = 'snapshot-ready';
const view = asEvidenceSnapshot({ snapshot_id: snapshotId, graph: {
  nodes: [{ id: 'component:a', name: 'A', responsibility: 'A', evidence: [], members: [] }],
  edges: [], layers: [],
}, value_points: [], learning_plan: { steps: [] } })!;

test('file snapshot availability distinguishes local placeholders, current views, and published overlays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-availability-file-'));
  const store = new FileStore(root);
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = snapshotId;
  project.display_language = 'zh-CN';
  try {
    await store.init();
    assert.equal(await store.snapshotAvailable(project), false);
    await store.saveSnapshot(project.project_id, {});
    assert.equal(await store.snapshotAvailable(project), false);
    await store.saveSnapshot(project.project_id, view);
    assert.equal(await store.snapshotAvailable(project), true);
    project.analysis.snapshot_id = 'stale-id';
    assert.equal(await store.snapshotAvailable(project), false);
    project.analysis.snapshot_id = snapshotId;
    project.analysis.canonical_snapshot_key = key;
    // A removed published binding must not be rescued by a local view.
    assert.equal(await store.snapshotAvailable(project), false);
    const directory = join(root, 'public-repository-snapshots', key);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'view.json'), JSON.stringify(view));
    const metadata = { analysis_snapshot_id: snapshotId, payload_purged_at: null,
      language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION };
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata));
    assert.equal(await store.snapshotAvailable(project), false);
    const zh = extractSnapshotLanguageOverlay(view, 'zh-CN');
    await store.saveSnapshotLanguageOverlay({ publicKey: key, language: 'zh-CN', status: 'degraded', payload: zh });
    assert.equal(await store.snapshotAvailable(project, 'en'), true, 'falls back to project language');
    project.analysis.snapshot_id = 'stale-id';
    assert.equal(await store.snapshotAvailable(project), false);
    project.analysis.snapshot_id = snapshotId;
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({ ...metadata, payload_purged_at: new Date().toISOString() }));
    assert.equal(await store.snapshotAvailable(project), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PostgreSQL snapshot availability uses metadata only and refuses stale or unbound views', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-availability-pg-'));
  const store = new PostgresStore({ databaseUrl: 'postgresql://unused', root,
    migrationsRoot: root, encryptionSecret: 'availability-test-secret' });
  const originalPool = store.pool;
  const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
  project.analysis.snapshot_id = snapshotId;
  project.display_language = 'zh-CN';
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  let bound: Record<string, unknown> | null = null;
  let local = false;
  Object.assign(store, { pool: { query: async (sql: string, args: unknown[]) => {
    queries.push({ sql, args });
    if (sql.includes('FROM project_public_snapshot_bindings b')) return { rows: bound ? [bound] : [] };
    if (sql.includes('FROM project_snapshots')) return { rows: [{ available: local }] };
    throw new Error(`unexpected availability query: ${sql}`);
  } } });
  try {
    assert.equal(await store.snapshotAvailable(project), false);
    local = true;
    assert.equal(await store.snapshotAvailable(project), true, 'unbound local view');
    assert.match(queries.at(-1)!.sql, /view_payload#>'\{graph,nodes\}'/);
    assert.match(queries.at(-1)!.sql, /analysis_snapshot_id = \$2/);
    project.analysis.canonical_snapshot_key = key;
    assert.equal(await store.snapshotAvailable(project), false, 'removed binding');
    assert.equal(queries.at(-1)!.sql.includes('FROM project_snapshots'), false);
    bound = { public_snapshot_key: key, analysis_snapshot_id: snapshotId,
      payload_purged_at: null, view_available: true,
      language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION, overlay_available: false };
    assert.equal(await store.snapshotAvailable(project, 'en'), false, 'missing language overlay');
    assert.deepEqual(queries.at(-1)!.args[2], ['en', 'zh-cn']);
    assert.equal(queries.at(-1)!.args[3], SNAPSHOT_LANGUAGE_OVERLAY_VERSION);
    assert.doesNotMatch(queries.at(-1)!.sql, /SELECT[^;]*\bview_payload\s*(?:,|FROM)/i);
    bound.overlay_available = true;
    assert.equal(await store.snapshotAvailable(project, 'en'), true, 'ready fallback language');
    bound.payload_purged_at = new Date();
    assert.equal(await store.snapshotAvailable(project), false, 'purged snapshot');
    bound.payload_purged_at = null;
    project.analysis.snapshot_id = 'stale-id';
    assert.equal(await store.snapshotAvailable(project), false, 'stale analysis.snapshot_id');
    project.analysis.snapshot_id = snapshotId;
    bound.analysis_snapshot_id = 'other-id';
    assert.equal(await store.snapshotAvailable(project), false, 'stale canonical metadata');
    bound.analysis_snapshot_id = snapshotId;
    bound.view_available = false;
    assert.equal(await store.snapshotAvailable(project), false, 'missing view');
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test('PostgreSQL parses and executes the availability query against isolated transaction tables',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtr-availability-pg-real-'));
    const store = new PostgresStore({ databaseUrl: process.env.WTR_ADMIN_TEST_DATABASE_URL!, root,
      migrationsRoot: root, encryptionSecret: 'availability-real-test-secret', poolMax: 1 });
    const originalPool = store.pool;
    const client = await originalPool.connect();
    const project = createProject('owner', 'https://github.com/example/repo', 'Example', 'free:test');
    project.analysis.snapshot_id = snapshotId;
    project.display_language = 'zh-CN';
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO pg_temp');
      await client.query('CREATE TEMP TABLE project_public_snapshot_bindings (project_id text, public_snapshot_key text) ON COMMIT DROP');
      await client.query(`CREATE TEMP TABLE canonical_public_repository_snapshots (
        public_snapshot_key text, analysis_snapshot_id text, payload_purged_at timestamptz,
        view_storage_key text, manifest_storage_key text, manifest_sha256 text, view_sha256 text, language_overlay_version text) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE public_snapshot_language_overlays (
        public_snapshot_key text, language text, status text, schema_version text, object_key text, object_sha256 text, object_bytes bigint) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE project_snapshots (
        project_id text, analysis_snapshot_id text, view_payload jsonb) ON COMMIT DROP`);
      Object.assign(store, { pool: { query: (sql: string, args?: unknown[]) => client.query(sql, args) } });
      assert.equal(await store.snapshotAvailable(project), false);
      await client.query('INSERT INTO project_snapshots VALUES ($1,$2,$3::jsonb)',
        [project.project_id, snapshotId, JSON.stringify({})]);
      assert.equal(await store.snapshotAvailable(project), false, 'empty local placeholder');
      await client.query('UPDATE project_snapshots SET view_payload=$2::jsonb WHERE project_id=$1',
        [project.project_id, JSON.stringify(view)]);
      assert.equal(await store.snapshotAvailable(project), true, 'complete local view');
      project.analysis.canonical_snapshot_key = key;
      assert.equal(await store.snapshotAvailable(project), false, 'removed binding');
      await client.query('INSERT INTO project_public_snapshot_bindings VALUES ($1,$2)', [project.project_id, key]);
      await client.query("INSERT INTO canonical_public_repository_snapshots VALUES ($1,$2,NULL,$3,'manifest.json','digest','digest',$4)",
        [key, snapshotId, 'snapshot-objects/view.json', SNAPSHOT_LANGUAGE_OVERLAY_VERSION]);
      assert.equal(await store.snapshotAvailable(project), false, 'missing overlay');
      await client.query("INSERT INTO public_snapshot_language_overlays VALUES ($1,$2,$3,$4,'overlay.json','digest',1)",
        [key, 'zh-cn', 'degraded', SNAPSHOT_LANGUAGE_OVERLAY_VERSION]);
      assert.equal(await store.snapshotAvailable(project, 'en'), true, 'fallback overlay');
      await client.query('UPDATE public_snapshot_language_overlays SET schema_version=$2 WHERE public_snapshot_key=$1',
        [key, "unsupported-overlay-schema"]);
      assert.equal(await store.snapshotAvailable(project), false, 'malformed ready overlay');
      await client.query('UPDATE public_snapshot_language_overlays SET schema_version=$2 WHERE public_snapshot_key=$1',
        [key, SNAPSHOT_LANGUAGE_OVERLAY_VERSION]);
      project.analysis.snapshot_id = 'stale-id';
      assert.equal(await store.snapshotAvailable(project), false, 'stale project snapshot id');
      project.analysis.snapshot_id = snapshotId;
      await client.query('UPDATE canonical_public_repository_snapshots SET payload_purged_at=now() WHERE public_snapshot_key=$1', [key]);
      assert.equal(await store.snapshotAvailable(project), false, 'purged snapshot');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await originalPool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
