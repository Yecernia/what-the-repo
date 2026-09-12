import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

test("PostgreSQL owner merge sends parameterized transfers as separate commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-owner-merge-"));
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push({ sql: normalized, values });
      if (values.length > 0 && normalized.includes(";")) {
        throw Object.assign(new Error("cannot insert multiple commands into a prepared statement"), {
          code: "42601",
        });
      }
      if (normalized.startsWith("SELECT owner_id FROM app_users")) {
        return {
          rows: [{ owner_id: "guest:source" }, { owner_id: "github:target" }],
          rowCount: 2,
        };
      }
      if (normalized.startsWith("SELECT COUNT(DISTINCT p.project_id)")) {
        return { rows: [{ projects: "1", messages: "2" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT COUNT(*)::text AS count FROM traces")) {
        return { rows: [{ count: "3" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT COUNT(*)::text AS count FROM evolution_feedback_requests")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "owner-merge-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() { return client; },
  };

  try {
    const summary = await store.mergeOwners({
      sourceOwnerId: "guest:source",
      targetOwnerId: "github:target",
      memoryCount: 4,
      sessionCount: 5,
    });

    assert.equal(summary.projects, 1);
    assert.equal(summary.messages, 2);
    assert.equal(summary.traces, 3);
    assert.equal(summary.memories, 4);
    assert.equal(summary.sessions, 5);
    assert.equal(released, true);
    const sql = queries.map((item) => item.sql);
    assert.deepEqual(
      sql.filter((statement) => statement.startsWith("UPDATE projects SET owner_id")
        || statement.startsWith("UPDATE traces SET owner_id")
        || statement.startsWith("UPDATE owner_quota_events SET owner_id")),
      [
        "UPDATE projects SET owner_id = $2, payload = jsonb_set(payload, '{owner_id}', to_jsonb($2::text), true) WHERE owner_id = $1",
        "UPDATE traces SET owner_id = $2, payload = jsonb_set(payload, '{owner_id}', to_jsonb($2::text), true) WHERE owner_id = $1",
        "UPDATE owner_quota_events SET owner_id = $2 WHERE owner_id = $1",
      ],
    );
    assert.deepEqual(
      queries.find((item) => item.sql.startsWith("UPDATE projects SET owner_id"))?.values,
      ["guest:source", "github:target"],
    );
    const projectTransferIndex = sql.findIndex((statement) => statement.startsWith("UPDATE projects SET owner_id"));
    assert.ok(projectTransferIndex >= 0);
    assert.ok(sql.indexOf("BEGIN") < projectTransferIndex);
    assert.ok(sql.indexOf("COMMIT") > sql.indexOf("UPDATE owner_quota_events SET owner_id = $2 WHERE owner_id = $1"));
    assert.ok(!sql.includes("ROLLBACK"));
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL project reads trust the owner column over stale JSON payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-owner-read-"));
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "owner-read-test-secret",
  });
  const originalPool = store.pool;
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM projects") && sql.includes("ORDER BY updated_at")) {
        return { rows: [{ owner_id: "github:target", payload: { project_id: "project-1", owner_id: "guest:source", messages: [] } }], rowCount: 1 };
      }
      if (sql.includes("FROM projects") && sql.includes("project_id = $1")) {
        return { rows: [{ owner_id: "github:target", payload: { project_id: "project-1", owner_id: "guest:source", messages: [] } }], rowCount: 1 };
      }
      if (sql.includes("FROM project_messages")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  (store as unknown as { pool: typeof pool }).pool = pool;
  try {
    const listed = await store.listProjects("github:target");
    assert.equal(listed[0]?.owner_id, "github:target");
    const loaded = await store.loadProject("project-1");
    assert.equal(loaded?.owner_id, "github:target");
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});
