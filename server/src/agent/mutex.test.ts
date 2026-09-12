import assert from "node:assert/strict";
import test from "node:test";
import { KeyedMutex } from "./mutex.js";

test("a cancelled waiter cannot let a later mutex task bypass the holder", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  let releaseHolder!: () => void;
  let holderEntered!: () => void;
  const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
  const holderBlock = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = mutex.runExclusive("shared", async () => {
    events.push("holder-entered");
    holderEntered();
    await holderBlock;
    events.push("holder-left");
  });
  await holderReady;

  const controller = new AbortController();
  const cancelled = mutex.runExclusive("shared", async () => {
    events.push("cancelled-entered");
  }, { signal: controller.signal });
  const later = mutex.runExclusive("shared", async () => {
    events.push("later-entered");
  });
  controller.abort(new Error("cancelled while waiting"));

  await assert.rejects(cancelled, /cancelled while waiting/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["holder-entered"]);

  releaseHolder();
  await Promise.all([holder, later]);
  assert.deepEqual(events, ["holder-entered", "holder-left", "later-entered"]);
});
