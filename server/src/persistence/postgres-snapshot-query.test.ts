import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

test('exact evidence lookups are bounded, snapshot-scoped and never load object payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'what-the-repo-evidence-'));
  const store = new PostgresStore({ databaseUrl: 'postgresql://unused', root,
    migrationsRoot: join(root, 'migrations'), encryptionSecret: 'evidence-test-secret' });
  const originalPool = store.pool;
  let reads = 0;
  store.loadPublicSnapshot = async () => { throw new Error('unexpected object hydration'); };
  const pool = { async query(sql: string, values: unknown[]) {
    reads++;
    assert.match(sql, /JOIN snapshot_query_directories/);
    assert.match(sql, /e\.public_snapshot_key=\$1 AND e\.snapshot_id=\$2 AND e\.evidence_id=ANY\(\$3::text\[\]\)/);
    assert.deepEqual(values[2], ['b', 'a', 'missing']);
    return { rows: values[0] === 'public' && values[1] === 'snapshot' ? ['a', 'b'].map(id => ({
      evidence_id: id, label: id, path: 'src/a.ts', start_line: 1, end_line: 2, kind: 'symbol',
      source_id: null, target_id: null,
    })) : [] };
  } };
  (store as unknown as { pool: typeof pool }).pool = pool;
  try {
    const input = { publicKey: 'public', snapshotId: 'snapshot', evidenceIds: ['b', 'a', 'missing', 'b'] };
    assert.deepEqual((await store.readPublicSnapshotEvidence(input)).map(row => row.stable_id), ['b', 'a']);
    assert.deepEqual(await store.readPublicSnapshotEvidence({ ...input, snapshotId: 'other' }), []);
    assert.deepEqual(await store.readPublicSnapshotEvidence({ ...input, publicKey: 'other' }), []);
    assert.deepEqual(await store.readPublicSnapshotEvidence({ ...input, evidenceIds: [] }), []);
    await assert.rejects(store.readPublicSnapshotEvidence({ ...input, evidenceIds: Array(21).fill('a') }), /request_invalid/);
    assert.equal(reads, 3);
  } finally { await originalPool.end(); await rm(root, { recursive: true, force: true }); }
});

test("PostgreSQL snapshot queries apply the shared expand_hops semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-query-"));
  const publicKey = "a".repeat(64);
  const snapshotId = "snap:query-test";
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "postgres-query-test-secret",
  });
  const originalPool = store.pool;
  let released = false;
  const commands: string[] = [];
  const pool = {
    async connect() { return { query: pool.query, release() { released = true; } }; },
    async query(sql: string) {
      commands.push(sql);
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.startsWith("WITH RECURSIVE")) return { rows: [
        { kind: "node", local_key: "component:a", item_key: "0:component:a", score: 11 },
        { kind: "node", local_key: "component:b", item_key: "0:component:b", score: 1 },
        { kind: "edge", local_key: "semantic:edge-a-b", item_key: "1:semantic:edge-a-b", score: 1 },
      ], rowCount: 3 };
      if (sql.includes("FROM snapshot_query_directories")) {
        return { rows: [{ snapshot_id: snapshotId, directory_digest: "digest", ready_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes("FROM snapshot_query_nodes")) {
        return {
          rows: [
            {
              public_snapshot_key: publicKey,
              snapshot_id: snapshotId,
              node_key: "component:a",
              node_id: "component:a",
              node_kind: "component",
              label: "入口",
              name: "入口",
              responsibility: "入口组件",
              path: "src/a.ts",
              language: "typescript",
              layer_id: null,
              layer_name: null,
              certainty: "supported",
              lifecycle_status: "active",
              payload: {},
            },
            {
              public_snapshot_key: publicKey,
              snapshot_id: snapshotId,
              node_key: "component:b",
              node_id: "component:b",
              node_kind: "component",
              label: "服务",
              name: "服务",
              responsibility: "服务组件",
              path: "src/b.ts",
              language: "typescript",
              layer_id: null,
              layer_name: null,
              certainty: "supported",
              lifecycle_status: "active",
              payload: {},
            },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes("FROM snapshot_query_edges")) {
        return {
          rows: [{
            public_snapshot_key: publicKey,
            snapshot_id: snapshotId,
            edge_key: "semantic:edge-a-b",
            edge_id: "edge-a-b",
            edge_kind: "semantic",
            source_node_key: "component:a",
            target_node_key: "component:b",
            relation_kind: "calls",
            label: "调用",
            description: "入口调用服务",
            certainty: "supported",
            weight: 1,
            lifecycle_status: "active",
            payload: {},
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM snapshot_query_evidence_links") || sql.includes("FROM snapshot_directory_evidence_links")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_evidence")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_layers")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_value_points")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_overlay_memberships")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_projection_nodes")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM snapshot_query_projection_edges")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  (store as unknown as { pool: typeof pool }).pool = pool;
  try {
    const result = await store.queryPublicSnapshot({
      publicKey,
      snapshotId,
      query: { text: "入口", expand_hops: 1, limit: 20 },
    });
    assert.deepEqual(result.nodes.map((row) => row.node_id).sort(), ["component:a", "component:b"]);
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0]?.source_node_key, "component:a");
    assert.equal(result.edges[0]?.target_node_key, "component:b");
    assert.equal(commands[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(commands.at(-1), "COMMIT");
    assert.equal(released, true);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});
