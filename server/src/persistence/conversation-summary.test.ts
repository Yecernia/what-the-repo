import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../domain/conversation.js";
import { conversationSummaryFromSource } from "../domain/conversation-summary.js";
import { asEvidenceSnapshot } from "../domain/snapshot.js";
import { applySnapshotLanguageOverlay, extractSnapshotLanguageOverlay, SNAPSHOT_LANGUAGE_OVERLAY_VERSION } from "../domain/snapshot-language.js";
import { FileStore } from "./file-store.js";
import { PostgresStore } from "./postgres-store.js";

const key = "b".repeat(64);
const snapshotId = "snapshot:conversation-summary";
const view = asEvidenceSnapshot({
  snapshot_id: snapshotId, summary: { files: 24 },
  languages: [{ language: "TypeScript", quality_tier: "complete", files_seen: 24,
    files_analyzed: 24, files_failed: 0, reason_codes: [] }],
  static_analysis: { completeness: { inventoryComplete: true, knownSourceFiles: 24, omitted: [], reasons: [] },
    limitations: ["limited fixture"] },
  graph: { semantic_mode: "model_supported", nodes: [
    { id: "repository:root", name: "Root", responsibility: "Root", evidence: [], members: [] },
    ...Array.from({ length: 22 }, (_, index) => ({ id: `component:${index}`, name: `Component ${index}`,
      responsibility: `Does ${index}`, architecture_layer_id: "layer:main",
      architecture_layer_name: "Base layer", evidence: [], members: [] })),
  ], edges: [], layers: [{ id: "layer:main", name: "Base layer", responsibility: "Base",
    component_ids: [], evidence: [], certainty: "provider_supported" }] },
  value_points: Array.from({ length: 10 }, (_, index) => ({ stable_id: `value:${index}`, kind: "architecture",
    title: `Value ${index}`, claim: `Claim ${index}`, problem: "Problem", implementation: "Implementation",
    tradeoffs: "Tradeoffs", transfer_conditions: "Transfer", certainty: "provider_supported",
    component_ids: [`component:${index}`], connectivity: index,
    evidence: Array.from({ length: 8 }, (_, evidenceIndex) => ({ stable_id: `evidence:${index}:${evidenceIndex}`,
      label: "Evidence", path: "src/example.ts", start_line: 1, end_line: 1, kind: "source" })) })),
  learning_plan: { steps: [] },
})!;

function overlay() {
  const translated = extractSnapshotLanguageOverlay(view, "zh-CN");
  translated.components = translated.components.map(row => ({ ...row, name: `中文 ${row.id}`, responsibility: `职责 ${row.id}` }));
  translated.layers = translated.layers.map(row => ({ ...row, name: "中文层" }));
  translated.value_points = translated.value_points.map(row => ({ ...row, title: `价值 ${row.stable_id}`, claim: "结论" }));
  return translated;
}

test("file conversation summary rejects placeholders and stale bindings, and follows language fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-conversation-summary-file-"));
  const store = new FileStore(root);
  const project = createProject("owner", "https://github.com/example/repo", "Example", "free:test");
  project.analysis.snapshot_id = snapshotId;
  project.display_language = "zh-CN";
  try {
    await store.init();
    await store.saveProject(project);
    await store.saveSnapshot(project.project_id, {});
    assert.equal(await store.loadConversationSummary(project), null);
    await store.saveSnapshot(project.project_id, view);
    assert.deepEqual(await store.loadConversationSummary(project), conversationSummaryFromSource(view));
    const stale = structuredClone(project); stale.analysis.snapshot_id = "stale";
    await assert.rejects(store.loadConversationSummary(stale), /snapshot_not_bound/);
    project.analysis.canonical_snapshot_key = key;
    await store.saveProject(project);
    assert.equal(await store.loadConversationSummary(project), null, "missing canonical metadata cannot use local view");
    const directory = join(root, "public-repository-snapshots", key);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "view.json"), JSON.stringify(view));
    const metadata = { public_snapshot_key: key, identity: { repository_identity: "example/repo" },
      analysis_snapshot_id: snapshotId, payload_purged_at: null, language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION };
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata));
    assert.equal(await store.loadConversationSummary(project), null, "missing overlay is unavailable");
    await store.saveSnapshotLanguageOverlay({ publicKey: key, language: "zh-CN", status: "degraded", payload: overlay() });
    const summary = await store.loadConversationSummary(project, "en");
    assert.equal(summary?.components[0]?.name, "中文 component:0");
    assert.equal(summary?.components[0]?.layer, "中文层");
    assert.equal(summary?.value_points[0]?.title, "价值 value:0");
    assert.deepEqual(summary?.value_points[0]?.evidence.map(row => row.stable_id),
      view.value_points[0]?.evidence.slice(0, 6).map(row => row.stable_id));
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ ...metadata, payload_purged_at: new Date().toISOString() }));
    await assert.rejects(store.loadConversationSummary(project), /snapshot_not_bound/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PostgreSQL conversation summary queries only bounded JSON and refuses changed or purged bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-conversation-summary-pg-mock-"));
  const store = new PostgresStore({ databaseUrl: "postgresql://unused", root,
    migrationsRoot: root, encryptionSecret: "conversation-summary-test-secret" });
  const originalPool = store.pool;
  const project = createProject("owner", "https://github.com/example/repo", "Example", "free:test");
  project.analysis.snapshot_id = snapshotId;
  project.analysis.canonical_snapshot_key = key;
  project.display_language = "zh-CN";
  const source = { snapshot_id: view.snapshot_id, summary: view.summary, languages: view.languages,
    static_analysis: view.static_analysis, graph: { semantic_mode: view.graph.semantic_mode, nodes: view.graph.nodes },
    value_points: view.value_points };
  const bound: { current_snapshot_id: string; current_public_key: string;
    public_snapshot_key: string | null; analysis_snapshot_id: string | null; payload_purged_at: Date | null;
    view_storage_key: string | null; inline_view: boolean; language_overlay_version: string | null;
    summary_payload: unknown } = {
    current_snapshot_id: snapshotId, current_public_key: key,
    public_snapshot_key: key, analysis_snapshot_id: snapshotId, payload_purged_at: null,
    view_storage_key: null, inline_view: true, language_overlay_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
    summary_payload: source };
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  Object.assign(store, { pool: { query: async (sql: string, args: unknown[]) => {
    queries.push({ sql, args });
    if (sql.includes("FROM projects AS p")) return { rows: [bound] };
    if (sql.includes("FROM public_snapshot_language_overlays AS o")) return { rows: args[1] === "zh-cn"
      ? [{ status: "ready", payload: overlay() }] : [] };
    throw new Error(`unexpected summary query: ${sql}`);
  } } });
  try {
    const summary = await store.loadConversationSummary(project, "en");
    assert.equal(summary?.components[0]?.name, "中文 component:0");
    assert.equal(summary?.value_points[0]?.evidence.length, 6);
    assert.equal(queries.length, 3, "requested language is tried before project fallback");
    assert.deepEqual(queries.slice(1).map(query => query.args[1]), ["en", "zh-cn"]);
    assert.match(queries[0]!.sql, /WITH ORDINALITY/);
    assert.match(queries[0]!.sql, /LIMIT 20/);
    assert.match(queries[0]!.sql, /point\.ordinal <= 8/);
    assert.match(queries[0]!.sql, /ev\.ordinal <= 6/);
    assert.doesNotMatch(queries[0]!.sql, /SELECT\s+(?:s\.)?view_payload\s*(?:,|FROM)/i);
    bound.analysis_snapshot_id = null;
    assert.equal(await store.loadConversationSummary(project), null, "missing canonical metadata is unavailable");
    bound.analysis_snapshot_id = snapshotId;
    bound.public_snapshot_key = null;
    assert.equal(await store.loadConversationSummary(project), null, "missing binding cannot use a local checkpoint");
    bound.public_snapshot_key = key;
    bound.inline_view = false;
    bound.view_storage_key = "snapshot-objects/view.json";
    bound.summary_payload = null;
    let fallbackReads = 0;
    Object.assign(store, { loadSnapshot: async () => { fallbackReads++;
      return applySnapshotLanguageOverlay(view, overlay()); } });
    assert.equal((await store.loadConversationSummary(project))?.components[0]?.name, "中文 component:0",
      "COS-only views explicitly use the existing full-read fallback");
    bound.inline_view = true;
    bound.view_storage_key = null;
    assert.equal((await store.loadConversationSummary(project))?.components[0]?.name, "中文 component:0",
      "older inline schemas also use the full-read fallback");
    assert.equal(fallbackReads, 2);
    Object.assign(store, { loadSnapshot: async () => ({ ...view, snapshot_id: "replaced" }) });
    await assert.rejects(store.loadConversationSummary(project), /snapshot_not_bound/);
    bound.current_snapshot_id = "changed";
    await assert.rejects(store.loadConversationSummary(project), /snapshot_not_bound/);
    bound.current_snapshot_id = snapshotId;
    bound.payload_purged_at = new Date();
    await assert.rejects(store.loadConversationSummary(project), /snapshot_not_bound/);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL conversation summary SQL runs against isolated temporary tables",
  { skip: !process.env.WTR_ADMIN_TEST_DATABASE_URL }, async () => {
    const root = await mkdtemp(join(tmpdir(), "wtr-conversation-summary-pg-real-"));
    const store = new PostgresStore({ databaseUrl: process.env.WTR_ADMIN_TEST_DATABASE_URL!, root,
      migrationsRoot: root, encryptionSecret: "conversation-summary-real-test-secret", poolMax: 1 });
    const client = await store.pool.connect();
    const originalPool = store.pool;
    const project = createProject("owner", "https://github.com/example/repo", "Example", "free:test");
    project.analysis.snapshot_id = snapshotId;
    project.analysis.canonical_snapshot_key = key;
    project.display_language = "zh-CN";
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path TO pg_temp");
      await client.query("CREATE TEMP TABLE projects (project_id text, payload jsonb) ON COMMIT DROP");
      await client.query("CREATE TEMP TABLE project_public_snapshot_bindings (project_id text, public_snapshot_key text) ON COMMIT DROP");
      await client.query(`CREATE TEMP TABLE canonical_public_repository_snapshots (
        public_snapshot_key text, analysis_snapshot_id text, payload_purged_at timestamptz,
        view_storage_key text, view_payload jsonb, language_overlay_version text) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE public_snapshot_language_overlays (
        public_snapshot_key text, language text, status text, payload jsonb) ON COMMIT DROP`);
      await client.query("INSERT INTO projects VALUES ($1,$2::jsonb)", [project.project_id, JSON.stringify(project)]);
      await client.query("INSERT INTO project_public_snapshot_bindings VALUES ($1,$2)", [project.project_id, key]);
      await client.query("INSERT INTO canonical_public_repository_snapshots VALUES ($1,$2,NULL,NULL,$3::jsonb,$4)",
        [key, snapshotId, JSON.stringify(view), SNAPSHOT_LANGUAGE_OVERLAY_VERSION]);
      await client.query("INSERT INTO public_snapshot_language_overlays VALUES ($1,$2,'ready',$3::jsonb)",
        [key, "zh-cn", JSON.stringify(overlay())]);
      Object.assign(store, { pool: { query: (sql: string, args?: unknown[]) => client.query(sql, args) } });
      const summary = await store.loadConversationSummary(project, "en");
      assert.equal(summary?.components.length, 20);
      assert.equal(summary?.value_points.length, 8);
      assert.ok(summary?.value_points.every(point => point.evidence.length === 6));
      assert.equal(summary?.components[0]?.name, "中文 component:0");
      assert.equal(summary?.components[0]?.layer, "中文层");
      assert.equal(summary?.value_points[0]?.title, "价值 value:0");
      await client.query("UPDATE canonical_public_repository_snapshots SET payload_purged_at=now() WHERE public_snapshot_key=$1", [key]);
      await assert.rejects(store.loadConversationSummary(project), /snapshot_not_bound/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await originalPool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
