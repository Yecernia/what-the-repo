import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresStore } from './postgres-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { conversationSummarySource, MAX_CONVERSATION_SUMMARY_BYTES } from '../domain/conversation-summary.js';
import { SNAPSHOT_LANGUAGE_OVERLAY_VERSION, type SnapshotLanguageOverlayPayload } from '../domain/snapshot-language.js';
import { jsonBytes, snapshotObjectDigest, type SnapshotObjectStore } from './snapshot-object-store.js';

const publicKey = 'd'.repeat(64), snapshotId = 'snapshot:object-overlay';
const source = conversationSummarySource({ snapshot_id: snapshotId, summary: { files: 2 }, languages: [],
  graph: { semantic_mode: 'model_supported', nodes: [{ id: 'component:a', name: 'A', responsibility: 'Does A',
    architecture_layer_id: null, architecture_layer_name: null }] }, value_points: [] })!;
function fixture(): SnapshotLanguageOverlayPayload {
  return { schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION, language: 'zh-CN', generated_at: '2026-09-27T00:00:00Z',
    components: [{ id: 'component:a', name: '组件', responsibility: '实现职责'.repeat(20_000),
      grouping_rationale: '', architecture_layer_rationale: null }], layers: [], relations: [], value_points: [] };
}
function memoryObjects() {
  const bodies = new Map<string, Uint8Array>(), reads: string[] = [];
  const storage: SnapshotObjectStore = { kind: 'local', get: async key => { reads.push(key); return bodies.get(key) ?? null; },
    put: async (key, body) => { bodies.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) }; },
    delete: async key => { bodies.delete(key); } };
  return { bodies, reads, storage };
}

test('language overlays keep only descriptors and bounded localized context in PostgreSQL; object reads fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-overlay-objects-'));
  const objects = memoryObjects();
  const store = new PostgresStore({ databaseUrl: 'postgresql://unused', root, migrationsRoot: root,
    encryptionSecret: 'overlay-object-test-secret', objectAdmissionStore: new LocalPermitStore(), objectCacheBytes: 0,
    objectStore: objects.storage });
  const originalPool = store.pool;
  let row: Record<string, unknown> | undefined;
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SELECT conversation_summary_payload FROM canonical')) return { rows: [{ conversation_summary_payload: source }] };
    if (sql.includes('INSERT INTO public_snapshot_language_overlays')) {
      assert.doesNotMatch(sql, /\bpayload\b/);
      row = Object.fromEntries(['public_snapshot_key', 'language', 'status', 'object_key', 'object_sha256', 'object_bytes',
        'schema_version', 'conversation_summary_payload', 'generated_at', 'error'].map((key, i) => [key, args[i]]));
      return { rows: [] };
    }
    if (sql.includes('FROM public_snapshot_language_overlays')) return { rows: row ? [row] : [] };
    return { rows: [] };
  };
  Object.assign(store, { pool: { query, connect: async () => ({ query, release() {} }) } });
  try {
    const payload = fixture();
    await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'degraded', payload, error: 'fixture' });
    assert.ok(Number(row!.object_bytes) > MAX_CONVERSATION_SUMMARY_BYTES);
    assert.ok(Buffer.byteLength(String(row!.conversation_summary_payload)) <= MAX_CONVERSATION_SUMMARY_BYTES);
    assert.equal(JSON.parse(String(row!.conversation_summary_payload)).snapshot_id, snapshotId);
    assert.match(String(row!.object_key), /\/language-overlays\/zh-cn-[a-f0-9]{64}\.json$/);
    assert.deepEqual((await store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'))?.payload, payload);
    assert.equal((await store.listSnapshotLanguageOverlays(publicKey)).length, 1);
    const key = String(row!.object_key), body = objects.bodies.get(key)!;
    objects.bodies.delete(key);
    await assert.rejects(store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'), /snapshot_object_missing/);
    objects.bodies.set(key, jsonBytes({ broken: true }));
    await assert.rejects(store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'), /snapshot_object_integrity_mismatch/);
    const wrongLanguage = jsonBytes({ ...payload, language: 'en' });
    row!.object_sha256 = snapshotObjectDigest(wrongLanguage);
    row!.object_bytes = wrongLanguage.byteLength;
    row!.object_key = `public-repository-snapshots/${publicKey}/language-overlays/zh-cn-${row!.object_sha256}.json`;
    objects.bodies.set(String(row!.object_key), wrongLanguage);
    await assert.rejects(store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'), /language_overlay_object_invalid/);
    objects.bodies.set(key, body);
    row!.object_sha256 = null;
    await assert.rejects(store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'), /language_overlay_object_metadata_invalid/);
    const reads = objects.reads.length;
    await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'failed', payload: null, error: 'failed' });
    assert.equal((await store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'))?.payload, null);
    assert.equal(row!.conversation_summary_payload, null);
    assert.equal(objects.reads.length, reads, 'failed metadata does not download a body');
    await assert.rejects(store.saveSnapshotLanguageOverlay({ publicKey, language: 'en', status: 'ready', payload }),
      /language_overlay_payload_invalid/);
  } finally { await originalPool.end(); await rm(root, { recursive: true, force: true }); }
});

test('isolated PostgreSQL overlay publication enforces byte bounds and accounts active objects across transitions',
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtr-overlay-pg-'));
    const objects = memoryObjects();
    const store = new PostgresStore({ databaseUrl: process.env.WTR_ADMIN_TEST_DATABASE_URL!, root,
      migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'overlay-object-pg-secret',
      objectAdmissionStore: new LocalPermitStore(), objectCacheBytes: 0, objectStore: objects.storage });
    try {
      await store.init();
      await store.pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,
        commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,source_storage_key,
        conversation_summary_payload,logical_bytes) VALUES($1,'test/overlay','commit','test','test',$2,'',$3::jsonb,100)`,
      [publicKey, snapshotId, JSON.stringify(source)]);
      const bytes = async () => Number((await store.pool.query(
        'SELECT logical_bytes FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1', [publicKey])).rows[0].logical_bytes);
      const payload = fixture();
      await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'ready', payload });
      assert.equal(await bytes(), 100 + jsonBytes(payload).byteLength);
      assert.deepEqual((await store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'))?.payload, payload);
      await assert.rejects(store.pool.query(`UPDATE public_snapshot_language_overlays
        SET object_sha256=NULL WHERE public_snapshot_key=$1`, [publicKey]), /language_overlay_object_descriptor/);
      const smaller = { ...payload, components: [] };
      await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'degraded', payload: smaller });
      assert.equal(await bytes(), 100 + jsonBytes(smaller).byteLength, 'replace counts current object only');
      await assert.rejects(store.pool.query(`UPDATE public_snapshot_language_overlays
        SET conversation_summary_payload=jsonb_build_object('oversized',repeat('x',40000)) WHERE public_snapshot_key=$1`, [publicKey]),
      /language_overlay_summary_byte_limit/);
      await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'failed', payload: null });
      assert.equal(await bytes(), 100);
      assert.equal((await store.loadSnapshotLanguageOverlay(publicKey, 'zh-CN'))?.payload, null);
      await store.saveSnapshotLanguageOverlay({ publicKey, language: 'zh-CN', status: 'ready', payload });
      await store.pool.query('DELETE FROM public_snapshot_language_overlays WHERE public_snapshot_key=$1', [publicKey]);
      assert.equal(await bytes(), 100);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
