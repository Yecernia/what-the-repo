import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";
import {
  parseSourceSnapshotManifest,
  parseSnapshotManifest,
  type SnapshotObjectStore,
  type StoredObject,
  snapshotObjectDigest,
} from "./snapshot-object-store.js";

class MemorySnapshotObjects implements SnapshotObjectStore {
  readonly kind = "local" as const;
  readonly values = new Map<string, Uint8Array>();
  readonly writes: string[] = [];

  async put(key: string, body: Uint8Array): Promise<StoredObject> {
    this.writes.push(key);
    this.values.set(key, Buffer.from(body));
    return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.values.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function view(snapshotId: string) {
  return {
    snapshot_id: snapshotId,
    summary: { file_count: 1, symbol_count: 0, call_count: 0 },
    graph: {
      semantic_mode: "static",
      nodes: [],
      edges: [],
      layers: [],
      unassigned_component_ids: [],
    },
    value_points: [],
    languages: [],
    learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] },
  };
}

test("PostgreSQL publishes snapshot metadata and query directory in one transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-snapshot-publish-"));
  const objects = new MemorySnapshotObjects();
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      return { rows: sql.includes("RETURNING directory_id") ? [{ directory_id: "1" }] : [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "snapshot-test-secret",
    objectStore: objects,
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() { return client; },
  };
  try {
    const publicKey = "f".repeat(64);
    const snapshotId = "snap:atomic-publication";
    const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "source\n", "utf8");
    const preparedSource = await store.preparePublicSnapshotSource({ publicKey, snapshotId, sourceRoot });
    const sourceWrites = objects.writes.length;
    assert.ok(sourceWrites > 0);
    await rm(sourceRoot, { recursive: true, force: true });
    const timings = await store.savePublicSnapshot({
      publicKey,
      repository: "example/atomic",
      commitSha: "a".repeat(40),
      snapshotId,
      preparedSource,
      view: view(snapshotId),
      analysis: { snapshot_id: snapshotId, fact_graph: { nodes: [], edges: [] } },
    });
    assert.ok(timings.total_ms >= timings.directory_write_ms);
    assert.equal(objects.writes.filter(key => /\/source\/|\/source-manifest-/.test(key)).length, sourceWrites,
      "publication must reuse prepared source even when the local directory is no longer present");

    const sql = queries.map((item) => item.sql);
    const begin = sql.indexOf("BEGIN");
    const snapshotInsert = sql.findIndex((item) => item.startsWith("INSERT INTO canonical_public_repository_snapshots"));
    const directoryInsert = sql.findIndex((item) => item.startsWith("INSERT INTO snapshot_query_directories"));
    const commit = sql.indexOf("COMMIT");
    assert.ok(begin >= 0 && snapshotInsert > begin && directoryInsert > snapshotInsert && commit > directoryInsert);
    assert.equal(released, true);

    const manifestEntry = [...objects.values.entries()].find(([key]) => key.includes("/manifest-"));
    assert.ok(manifestEntry);
    const manifest = parseSnapshotManifest(manifestEntry[1], { publicKey, snapshotId });
    assert.equal(manifest.objects.length, 2);
    assert.ok(manifest.objects.every((item) => objects.values.has(item.key)));
    const sourceManifestEntry = [...objects.values.entries()].find(([key]) => key.includes("/source-manifest-"));
    assert.ok(sourceManifestEntry);
    const sourceManifest = parseSourceSnapshotManifest(sourceManifestEntry[1], { publicKey, snapshotId });
    assert.deepEqual(sourceManifest.files.map((file) => file.path), ["README.md"]);
    assert.ok(sourceManifest.files.every((item) => objects.values.has(item.key)));
    const insertValues = queries[snapshotInsert]?.values ?? [];
    assert.equal(insertValues[11], manifestEntry[0]);
    assert.equal(insertValues[8], sourceManifestEntry[0]);
    assert.ok(Number(insertValues[18]) > Buffer.byteLength("source\n", "utf8"));
    const snapshotRow = {
      repository_identity: "example/atomic",
      commit_sha: "a".repeat(40),
      analyzer_bundle_version: "typescript-0.1.0",
      analysis_config_digest: "tree-sitter-nine-language-v1",
      analysis_snapshot_id: snapshotId,
      source_storage_key: insertValues[8],
      reuse_count: "0",
      logical_bytes: String(insertValues[18]),
      created_at: "2026-08-24T00:00:00.000Z",
      last_used_at: "2026-08-24T00:00:00.000Z",
      view_payload: null,
      analysis_payload: null,
      view_storage_key: insertValues[9],
      analysis_storage_key: insertValues[10],
      manifest_storage_key: insertValues[11],
      manifest_sha256: insertValues[12],
      manifest_bytes: String(insertValues[13]),
      view_sha256: insertValues[14],
      view_bytes: String(insertValues[15]),
      analysis_sha256: insertValues[16],
      analysis_bytes: String(insertValues[17]),
      source_manifest_sha256: insertValues[19],
      source_manifest_bytes: String(insertValues[20]),
      source_file_count: insertValues[21],
      language_overlay_version: null,
      retired_at: null,
      purge_after: null as string | null,
      payload_purged_at: null,
    };
    await rm(sourceRoot, { recursive: true, force: true });
    (store as unknown as { pool: { query(sql?: string): Promise<unknown> } }).pool = {
      async query(sql = "") {
        return sql.includes("FROM projects AS project")
          ? {
              rows: [{
                ...snapshotRow,
                project_snapshot_id: snapshotId,
                public_snapshot_key: publicKey,
              }],
              rowCount: 1,
            }
          : { rows: [snapshotRow], rowCount: 1 };
      },
    };
    const loaded = await store.loadPublicSnapshot(publicKey);
    assert.equal((loaded?.view as { snapshot_id?: string }).snapshot_id, snapshotId);
    assert.deepEqual(await store.listSourceFiles("project-1", snapshotId), ["README.md"]);
    assert.deepEqual(
      await store.readPublicSourceLines(publicKey, snapshotId, "README.md", 1, 10),
      { lines: ["source", ""], truncated: false },
    );
    assert.deepEqual(
      await store.readSourceLines("project-1", snapshotId, "README.md", 1, 1),
      { lines: ["source"], truncated: false },
    );
    const sourceObject = sourceManifest.files[0]!;
    const changedSource = Buffer.from(objects.values.get(sourceObject.key) ?? []);
    changedSource[0] = changedSource[0] === 115 ? 83 : 115;
    objects.values.set(sourceObject.key, changedSource);
    await assert.rejects(
      store.readPublicSourceLines(publicKey, snapshotId, "README.md", 1, 10),
      /source_snapshot_object_integrity_mismatch/,
    );
    const viewObject = manifest.objects.find((item) => item.kind === "view");
    assert.ok(viewObject);
    const changed = Buffer.from(objects.values.get(viewObject.key) ?? []);
    changed[0] = changed[0] === 123 ? 91 : 123;
    objects.values.set(viewObject.key, changed);
    await assert.rejects(
      store.loadPublicSnapshot(publicKey),
      /snapshot_object_integrity_mismatch/,
    );
    await assert.rejects(
      stat(join(root, "public-repository-snapshots", publicKey, "view.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    snapshotRow.purge_after = "2026-08-23T00:00:00.000Z";
    const purgeClient = {
      async query(sql: string) {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        if (normalized.includes("FROM canonical_public_repository_snapshots")
          && normalized.includes("FOR UPDATE")) {
          return { rows: [snapshotRow], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT 1 WHERE EXISTS")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    (store as unknown as { pool: { connect(): Promise<typeof purgeClient> } }).pool = {
      async connect() { return purgeClient; },
    };
    assert.equal(await store.purgePublicSnapshotPayload(publicKey, "2026-08-24T01:00:00.000Z"), true);
    assert.equal(objects.values.size, 0);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL stores and reloads large analysis payload chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-large-pg-analysis-"));
  const objects = new MemorySnapshotObjects();
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      return { rows: sql.includes("RETURNING directory_id") ? [{ directory_id: "1" }] : [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "snapshot-test-secret",
    objectStore: objects,
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() { return client; },
  };
  try {
    const publicKey = "d".repeat(64);
    const snapshotId = "snap:large-pg-analysis";
    const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "source\n", "utf8");
    const nodes = Array.from({ length: 2_100 }, (_, index) => ({
      id: `fact-node-${index}`,
      label: `Fact ${index}`,
      name: `Fact ${index}`,
      responsibility: "test",
      members: [],
      member_count: 0,
      evidence: [],
      certainty: "verified",
      review_status: "accepted",
      fan_in: 0,
      fan_out: 0,
    }));
    const edges = Array.from({ length: 2_100 }, (_, index) => ({
      id: `fact-edge-${index}`,
      source: `fact-node-${index}`,
      target: `fact-node-${(index + 1) % 2_100}`,
      relation_kind: "calls",
      label: "calls",
      description: "test",
      certainty: "verified",
      evidence: [],
      weight: 1,
    }));
    const analysis = { snapshot_id: snapshotId, fact_graph: { nodes, edges } };
    await store.savePublicSnapshot({
      publicKey,
      repository: "example/large-pg-analysis",
      commitSha: "b".repeat(40),
      snapshotId,
      sourceRoot,
      view: view(snapshotId),
      analysis,
    });

    const snapshotInsert = queries.find((item) => item.sql.startsWith("INSERT INTO canonical_public_repository_snapshots"));
    assert.ok(snapshotInsert);
    const values = snapshotInsert.values;
    assert.equal(values[7], null, "chunked analysis must not be duplicated in PostgreSQL jsonb");
    const analysisKey = String(values[10]);
    const chunkKeys = [...objects.values.keys()].filter((key) => key.includes("/analysis-chunks/"));
    assert.ok(chunkKeys.length >= 2);
    assert.ok(Number(values[18]) > Number(values[17]));

    const row = {
      repository_identity: "example/large-pg-analysis",
      commit_sha: "b".repeat(40),
      analyzer_bundle_version: "typescript-0.1.0",
      analysis_config_digest: "tree-sitter-nine-language-v1",
      analysis_snapshot_id: snapshotId,
      source_storage_key: values[8],
      reuse_count: "0",
      logical_bytes: String(values[18]),
      created_at: "2026-08-24T00:00:00.000Z",
      last_used_at: "2026-08-24T00:00:00.000Z",
      view_payload: view(snapshotId),
      analysis_payload: null,
      view_storage_key: values[9],
      analysis_storage_key: analysisKey,
      manifest_storage_key: values[11],
      manifest_sha256: values[12],
      manifest_bytes: String(values[13]),
      view_sha256: values[14],
      view_bytes: String(values[15]),
      analysis_sha256: values[16],
      analysis_bytes: String(values[17]),
      source_manifest_sha256: values[19],
      source_manifest_bytes: String(values[20]),
      source_file_count: values[21],
      language_overlay_version: null,
      retired_at: null,
      purge_after: null,
      payload_purged_at: null,
    };
    (store as unknown as { pool: { query(sql?: string): Promise<unknown> } }).pool = {
      async query() { return { rows: [row], rowCount: 1 }; },
    };
    const loaded = await store.loadPublicSnapshot(publicKey);
    assert.deepEqual((loaded?.analysis as typeof analysis).fact_graph.nodes, nodes);
    assert.deepEqual((loaded?.analysis as typeof analysis).fact_graph.edges, edges);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL rolls back snapshot metadata when query directory publication fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-snapshot-rollback-"));
  const objects = new MemorySnapshotObjects();
  const queries: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("INSERT INTO snapshot_query_directories")) {
        throw new Error("query_directory_write_failed");
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "snapshot-test-secret",
    objectStore: objects,
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() { return client; },
  };
  try {
    const publicKey = "e".repeat(64);
    const snapshotId = "snap:rollback-publication";
    const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "source\n", "utf8");

    await assert.rejects(
      store.savePublicSnapshot({
        publicKey,
        repository: "example/rollback",
        commitSha: "b".repeat(40),
        snapshotId,
        view: view(snapshotId),
        analysis: { snapshot_id: snapshotId, fact_graph: { nodes: [], edges: [] } },
      }),
      /query_directory_write_failed/,
    );

    assert.ok(queries.includes("BEGIN"));
    assert.ok(queries.some((sql) => sql.startsWith("INSERT INTO canonical_public_repository_snapshots")));
    assert.ok(queries.some((sql) => sql.startsWith("INSERT INTO snapshot_query_directories")));
    assert.ok(queries.includes("ROLLBACK"));
    assert.equal(queries.includes("COMMIT"), false);
    assert.equal(released, true);
    assert.equal(objects.values.size, 5);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});
