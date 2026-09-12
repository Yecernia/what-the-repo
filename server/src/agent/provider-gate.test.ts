import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalProviderCallGate,
  PostgresProviderCallGate,
} from "./provider-gate.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("local provider gate queues a call and releases permits exactly once", async () => {
  const gate = new LocalProviderCallGate(1);
  const first = await gate.acquire();
  let secondReady = false;
  const second = gate.acquire().then((permit) => {
    secondReady = true;
    return permit;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false);
  await first.release();
  const secondPermit = await second;
  assert.equal(secondReady, true);
  await secondPermit.release();
  await secondPermit.release();
});

test("waiting provider calls can be cancelled without consuming the next slot", async () => {
  const gate = new LocalProviderCallGate(1);
  const first = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  await first.release();
  const next = await gate.acquire();
  await next.release();
});

test("PostgreSQL provider gate shares advisory-lock slots across gate instances", async () => {
  const locked = new Set<string>();
  const calls: string[] = [];
  const pool = {
    async connect() {
      return {
        async query<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: T[] }> {
          calls.push(sql);
          const slot = String(params[1]);
          const key = `${String(params[0])}:${slot}`;
          if (sql.includes("try_advisory_lock")) {
            const acquired = !locked.has(key);
            if (acquired) locked.add(key);
            return { rows: [{ acquired } as unknown as T] };
          }
          locked.delete(key);
          return { rows: [] as T[] };
        },
        release() {},
      };
    },
  };
  const firstGate = new PostgresProviderCallGate(pool, "provider:test", 1, 10);
  const secondGate = new PostgresProviderCallGate(pool, "provider:test", 1, 10);
  const first = await firstGate.acquire();
  const secondReady = deferred<void>();
  const second = secondGate.acquire().then((permit) => {
    secondReady.resolve();
    return permit;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  let ready = false;
  secondReady.promise.then(() => { ready = true; });
  assert.equal(ready, false);
  await first.release();
  const secondPermit = await second;
  assert.ok(calls.some((sql) => sql.includes("pg_try_advisory_lock")));
  await secondPermit.release();
});
