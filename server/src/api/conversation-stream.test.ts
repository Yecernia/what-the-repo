import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStreamHub, type ConversationStreamClient } from "./conversation-stream.js";

class FakeClient implements ConversationStreamClient {
  readonly frames: Array<{ type: string; payload: unknown }> = [];
  open = true;

  write(type: string, payload: unknown): void {
    if (!this.open) throw new Error("closed");
    this.frames.push({ type, payload });
  }

  end(): void {
    this.open = false;
  }

  isOpen(): boolean {
    return this.open;
  }
}

test("conversation stream hub replays only frames after the requested sequence", () => {
  const hub = new ConversationStreamHub({ terminalRetentionMs: 1_000 });
  const run = hub.create({ runId: "run-replay", projectId: "project-1", ownerId: "owner-1" });
  const first = new FakeClient();
  hub.attach(run, first, 0);
  hub.publishProgress(run, { run_id: run.runId, sequence: 1, stage: "one" });
  hub.publishProgress(run, { run_id: run.runId, sequence: 2, stage: "two" });
  hub.detach(run, first);

  const resumed = new FakeClient();
  hub.attach(run, resumed, 1);

  assert.deepEqual(resumed.frames.map(frame => frame.type), ["connected", "progress"]);
  assert.deepEqual(resumed.frames[0]?.payload, {
    project_id: "project-1",
    run_id: "run-replay",
    resumed: true,
  });
  assert.deepEqual(resumed.frames[1]?.payload, { run_id: run.runId, sequence: 2, stage: "two" });
});

test("conversation stream hub retains a terminal result for a late subscriber", () => {
  const hub = new ConversationStreamHub({ terminalRetentionMs: 1_000 });
  const run = hub.create({ runId: "run-terminal", projectId: "project-1", ownerId: "owner-1" });
  hub.finish(run, { type: "result", payload: { answer: "ok" } });

  const late = new FakeClient();
  hub.attach(run, late, 0);

  assert.deepEqual(late.frames.map(frame => frame.type), ["connected", "result", "done"]);
  assert.deepEqual(late.frames[1]?.payload, { answer: "ok" });
});
