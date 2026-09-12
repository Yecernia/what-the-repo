import assert from "node:assert/strict";
import test from "node:test";
import { RetentionScheduler } from "./retention-scheduler.js";

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("retention scheduler coalesces overlapping sweeps and waits during stop", async () => {
  let started!: () => void;
  let release!: () => void;
  const startedSignal = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const scheduler = new RetentionScheduler(async () => {
    runs += 1;
    started();
    await blocked;
  }, 60_000);

  const first = scheduler.runNow();
  const second = scheduler.runNow();
  assert.equal(first, second);
  await startedSignal;
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await nextTick();
  assert.equal(stopped, false);
  release();
  await first;
  await stopping;
  assert.equal(stopped, true);
  assert.equal(runs, 1);
});
