import assert from "node:assert/strict";
import test from "node:test";
import { postgresApplicationName, postgresPoolSettings } from "./postgres-store.js";

test("PostgreSQL pool settings keep defaults and clamp unsafe deployment values", () => {
  assert.deepEqual(postgresPoolSettings(), {
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  assert.deepEqual(postgresPoolSettings({ poolMax: 500, idleTimeoutMs: 100, connectionTimeoutMs: 100 }), {
    max: 100,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 1_000,
  });
});

test("PostgreSQL application names keep deployment roles visible and bounded", () => {
  assert.equal(postgresApplicationName("analysis-worker"), "what-the-repo:analysis-worker");
  assert.equal(postgresApplicationName("  API replica #2  "), "what-the-repo:api-replica-2");
  assert.equal(postgresApplicationName("***"), "what-the-repo:runtime");
  assert.ok(postgresApplicationName("x".repeat(200)).length <= 63);
});
