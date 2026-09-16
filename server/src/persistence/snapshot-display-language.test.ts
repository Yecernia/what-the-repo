import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { PostgresStore } from './postgres-store.js';
import { createProject } from '../domain/conversation.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
import { extractSnapshotLanguageOverlay, snapshotMatchesDisplayLanguage, SNAPSHOT_LANGUAGE_OVERLAY_VERSION } from '../domain/snapshot-language.js';

test('a real repository name does not degrade a complete Chinese snapshot', () => {
  const snapshot = asEvidenceSnapshot({repository:'example/repo',snapshot_id:'language-root',graph:{
    nodes:[{id:'root',entity_kind:'repository',name:'example/repo',responsibility:'仓库整体结构',evidence:[],members:[]},
      {id:'part',entity_kind:'component',name:'能力 seam',responsibility:'由接口连接提供方和使用方',evidence:[],members:[]}],edges:[],layers:[],
  },value_points:[],learning_plan:{steps:[]}})!;
  assert.equal(snapshotMatchesDisplayLanguage(snapshot,'zh-CN'),true);
  snapshot.graph.nodes[1]!.responsibility='Untranslated responsibility';
  assert.equal(snapshotMatchesDisplayLanguage(snapshot,'zh-CN'),false);
});

test('an idle PostgreSQL disconnect is handled without exposing the client', async (t) => {
  const store = new PostgresStore({databaseUrl:'postgresql://unused',root:tmpdir(),migrationsRoot:tmpdir(),encryptionSecret:'test-only-long-secret'});
  const messages:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>messages.push(args));
  try {
    assert.doesNotThrow(()=>store.pool.emit('error',Object.assign(new Error('sensitive connection detail'),{code:'57P01'}),{password:'sensitive'}));
    assert.deepEqual(messages,[['postgres_idle_connection_error','57P01']]);
  } finally { await store.close(); }
});

for (const kind of ['file', 'postgres'] as const) {
  test(`${kind} display reads existing overlays and falls back without changing project language or facts`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtr-language-'));
    const store = kind === 'file' ? new FileStore(root) : new PostgresStore({
      databaseUrl: 'postgresql://unused', root, migrationsRoot: root, encryptionSecret: 'language-test-secret',
    });
    const key = 'a'.repeat(64);
    const project = createProject('guest:test', 'https://github.com/example/repo', 'Example', 'free:test');
    project.display_language = 'zh-CN';
    project.analysis.canonical_snapshot_key = key;
    const source = asEvidenceSnapshot({ snapshot_id: 'same-id', graph: {
      nodes: [{ id: 'component:a', name: '队列', responsibility: '处理任务', evidence: [], members: [] }], edges: [], layers: [],
    }, value_points: [], learning_plan: { steps: [] } })!;
    const zh = extractSnapshotLanguageOverlay(source, 'zh-CN');
    const en = structuredClone(zh);
    en.language = 'en'; en.components[0]!.name = 'Queue'; en.components[0]!.responsibility = 'Runs tasks';
    const overlays = new Map([['zh-CN', { public_snapshot_key: key, language: 'zh-CN', status: 'ready' as const, payload: zh, error: null, generated_at: null, updated_at: '' }]]);
    const originalPool = store instanceof PostgresStore ? store.pool : null;
    try {
      if (store instanceof PostgresStore) {
        Object.assign(store, { pool: { query: async () => ({ rows: [{ public_snapshot_key: key }] }) } });
        // This test isolates language selection; payload integrity is tested in snapshot-parts.test.ts.
        Object.assign(store, { readPublicSnapshotParts: async () => ({ metadata: { language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION }, view: source }) });
        store.loadProject = async () => structuredClone(project);
        store.loadSnapshotLanguageOverlay = async (_key, language) => {
          const overlay = overlays.get(language);
          return overlay ? { ...overlay, payload: { ...overlay.payload } } : null;
        };
      } else {
        await store.init(); await store.saveProject(project);
        const dir = join(root, 'public-repository-snapshots', key); await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'view.json'), JSON.stringify(source));
        await writeFile(join(dir, 'metadata.json'), JSON.stringify({ language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION }));
        await store.saveSnapshotLanguageOverlay({ publicKey: key, language: 'zh-CN', status: 'ready', payload: zh });
      }
      const load = async (language?: string) => asEvidenceSnapshot(await store.loadSnapshot(project.project_id, language))!;
      assert.equal((await load('en')).display_language, 'zh-CN');
      if (store instanceof PostgresStore) overlays.set('en', { ...overlays.get('zh-CN')!, language: 'en', payload: en });
      else await store.saveSnapshotLanguageOverlay({ publicKey: key, language: 'en', status: 'ready', payload: en });
      const translated = await load('en');
      assert.equal(translated.display_language, 'en');
      assert.equal(translated.snapshot_id, source.snapshot_id);
      assert.equal(translated.graph.nodes[0]!.name, 'Queue');
      assert.deepEqual(translated.graph.nodes[0]!.members, source.graph.nodes[0]!.members);
      assert.deepEqual(translated.graph.edges, source.graph.edges);
      assert.equal((await load()).graph.nodes[0]!.name, '队列');
      assert.equal((await store.loadProject(project.project_id))!.display_language, 'zh-CN');
      assert.equal(source.graph.nodes[0]!.name, '队列');
    } finally {
      if (originalPool) await originalPool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
}
