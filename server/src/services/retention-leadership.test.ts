import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  PostgresRetentionLeadership,
  waitForRetentionLeadership,
} from "./retention-leadership.js";

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  released: boolean | Error | undefined;

  constructor(private readonly acquired: boolean) {
    super();
  }

  async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.queries.push(sql);
    return {
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ acquired: this.acquired } as unknown as T],
    };
  }

  release(error?: boolean | Error): void {
    this.released = error ?? false;
  }
}

test("PostgreSQL retention leadership keeps the acquired session until release", async () => {
  const client = new FakeClient(true);
  const leadership = new PostgresRetentionLeadership({
    connect: async () => client as unknown as PoolClient,
  });

  const lease = await leadership.tryAcquire();
  assert.ok(lease);
  assert.equal(client.released, undefined);
  assert.match(client.queries[0], /pg_try_advisory_lock/);

  await lease.release();
  await lease.release();
  assert.equal(client.queries.filter((sql) => sql.includes("pg_advisory_unlock")).length, 1);
  assert.equal(client.released, false);
});

test("PostgreSQL retention leadership releases a contended connection", async () => {
  const client = new FakeClient(false);
  const leadership = new PostgresRetentionLeadership({
    connect: async () => client as unknown as PoolClient,
  });

  assert.equal(await leadership.tryAcquire(), null);
  assert.equal(client.released, false);
});

test("retention leadership waits for a later lease and reports waiting once", async () => {
  const lease = { lost: new Promise<Error>(() => undefined), release: async () => undefined };
  let attempts = 0;
  let waitingReports = 0;
  const acquired = await waitForRetentionLeadership({
    tryAcquire: async () => {
      attempts += 1;
      return attempts === 3 ? lease : null;
    },
  }, {
    retryMs: 10,
    onWaiting: () => { waitingReports += 1; },
  });

  assert.equal(acquired, lease);
  assert.equal(attempts, 3);
  assert.equal(waitingReports, 1);
});

test("retention leadership exposes an acquired connection failure", async () => {
  const client = new FakeClient(true);
  const leadership = new PostgresRetentionLeadership({
    connect: async () => client as unknown as PoolClient,
  });
  const lease = await leadership.tryAcquire();
  assert.ok(lease);

  const failure = new Error("database connection lost");
  client.emit("error", failure);
  assert.equal(await lease.lost, failure);
  await lease.release();
  assert.equal(client.released, true);
});
