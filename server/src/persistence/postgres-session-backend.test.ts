import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import type { PiSessionIdentity } from "../agent/types.js";
import { PostgresPiSessionBackend } from "./postgres-session-backend.js";

const identity: PiSessionIdentity = {
  sessionId: "postgres-session-cancel-test",
  ownerId: "owner-test",
  projectId: "project-test",
  snapshotId: "snapshot-test",
  skillId: "primary-supervisor",
  skillVersion: "test",
};

test("cancelled advisory-lock waiting stops after the current bounded lock attempt", async () => {
  let rejectLock!: (error: Error) => void;
  let queryStarted!: () => void;
  const started = new Promise<void>((resolve) => { queryStarted = resolve; });
  const queries: string[] = [];
  let releaseCalls = 0;
  const client = {
    query: (sql: string) => {
      queries.push(sql);
      if (!sql.includes("pg_advisory_lock")) return Promise.resolve({ rowCount: 1, rows: [] });
      return new Promise<never>((_resolve, reject) => {
        rejectLock = reject;
        queryStarted();
      });
    },
    release: (error?: Error | boolean) => {
      assert.equal(error, undefined);
      releaseCalls += 1;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const backend = new PostgresPiSessionBackend(pool);
  const controller = new AbortController();
  const pending = backend.withSession(identity, async () => {
    assert.fail("cancelled waiter entered the Session task");
  }, { signal: controller.signal });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  await started;
  controller.abort(new Error("cancelled while waiting"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  rejectLock(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
  await assert.rejects(pending, /cancelled while waiting/);
  assert.equal(settled, true);
  assert.equal(releaseCalls, 1);
  assert.ok(queries.includes("SET lock_timeout = '1s'"));
  assert.ok(queries.includes("SET lock_timeout = 0"));
});

test("PostgreSQL lock timeout retries without entering the Session early", async () => {
  const queries: string[] = [];
  let lockAttempts = 0;
  let releaseCalls = 0;
  const client = {
    query: (sql: string) => {
      queries.push(sql);
      if (sql.includes("pg_advisory_lock")) {
        lockAttempts += 1;
        if (lockAttempts === 1) {
          return Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
        }
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
    release: () => { releaseCalls += 1; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const backend = new PostgresPiSessionBackend(pool);
  let entered = 0;

  await backend.withSession(identity, async () => { entered += 1; });

  assert.equal(lockAttempts, 2);
  assert.equal(entered, 1);
  assert.equal(releaseCalls, 1);
  assert.ok(queries.some((sql) => sql.includes("pg_advisory_unlock")));
});
