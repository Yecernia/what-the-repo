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


test('a cancelled Session pool wait ends immediately and releases a connection returned later', async () => {
  let deliver!: (client: PoolClient) => void;
  let released=0, entered=0;
  const pool = { connect: () => new Promise<PoolClient>(resolve => deliver=resolve) } as unknown as Pool;
  const controller = new AbortController();
  const task = new PostgresPiSessionBackend(pool).withSession(identity,async () => { entered++; },{signal:controller.signal});
  controller.abort(new Error('cancelled waiting'));
  await assert.rejects(task,/cancelled waiting/);
  deliver({release:()=>released++} as unknown as PoolClient);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(released,1); assert.equal(entered,0);
});
