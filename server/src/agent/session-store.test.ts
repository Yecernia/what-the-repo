import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { PiSessionStore, projectSessionId } from "./session-store.js";
import type { PiSessionBackend } from "./session-store.js";
import type { PiSessionIdentity } from "./types.js";

const identity: PiSessionIdentity = {
  sessionId: projectSessionId("guest:owner-test", "project/test", "snapshot:test"),
  ownerId: "guest:owner-test",
  projectId: "project/test",
  snapshotId: "snapshot:test",
  skillId: "primary-supervisor",
  skillVersion: "test",
};

test("project session ids are stable, snapshot-scoped, and Pi-compatible", () => {
  const first = projectSessionId("guest:owner", "project/test", "snapshot:one");
  assert.match(first, /^project-[a-f0-9]{64}$/);
  assert.equal(first, projectSessionId("guest:owner", "project/test", "snapshot:one"));
  assert.notEqual(first, projectSessionId("guest:owner", "project/test", "snapshot:two"));
});

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function textOf(message: AgentMessage): string {
  if (message.role === "user") return typeof message.content === "string" ? message.content : "";
  if (message.role === "compactionSummary") return message.summary;
  if (message.role === "assistant") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }).join("");
    }
  }
  return "";
}

test("Pi session survives a process-style reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-session-"));
  try {
    const first = new PiSessionStore(root);
    await first.withSession(identity, async ({ session }) => {
      await first.appendMessages(session, [user("你好"), user("请继续")]);
    });

    const second = new PiSessionStore(root);
    const context = await second.snapshot(identity);
    assert.deepEqual(context.messages.map(textOf), ["你好", "请继续"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visible conversation recovery preserves the original log and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-history-recovery-"));
  try {
    const store = new PiSessionStore(root);
    const question = user("讲最简单的文件");
    const next = user("你好");
    await store.withSession(identity, async ({ session }) => store.appendMessages(session, [question, next]));
    const answer = { role: "assistant", content: [{ type: "text", text: "这是已经展示的回答。引用尚未核实。" }], timestamp: Date.now() } as AgentMessage;
    const restored = [question, answer, next];
    assert.equal(await store.recoverVisibleConversation(identity, restored), true);
    assert.equal(await store.recoverVisibleConversation(identity, restored), false);
    const reopened = await new PiSessionStore(root).snapshot(identity);
    assert.equal(reopened.entries.length, 3);
    assert.deepEqual(reopened.messages.slice(1).map(textOf), restored.map(textOf));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi session wait timeout stops when the backend reports the lock before initialization", async () => {
  const backend: PiSessionBackend = {
    async withSession(_identity, task, options) {
      options?.onAcquired?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return task({ findEntriesOnBranch: async () => [] } as never);
    },
    async delete() {},
    async listOwnerSessions() { return []; },
    async deleteOwner() { return 0; },
  };
  const store = new PiSessionStore(backend);

  const result = await store.withSession(
    identity,
    async () => "initialized after lock",
    { waitTimeoutMs: 5 },
  );
  assert.equal(result, "initialized after lock");
});

test("Pi compaction entry is restored as a native summary message", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-compaction-"));
  try {
    const store = new PiSessionStore(root);
    await store.withSession(identity, async ({ session }) => {
      await store.appendMessages(session, [user("旧消息")]);
      await store.appendCompaction(session, {
        summary: "## Goal\n保留用户目标",
        tokensBefore: 42,
        retainedTail: [user("保留的最近消息")],
      });
      await store.appendMessages(session, [user("压缩后的新消息")]);
    });

    const reopened = new PiSessionStore(root);
    const context = await reopened.snapshot(identity);
    assert.equal(context.messages[0]?.role, "compactionSummary");
    assert.equal((context.messages[0] as { summary: string }).summary, "## Goal\n保留用户目标");
    assert.deepEqual(context.messages.slice(1).map(textOf), ["保留的最近消息", "压缩后的新消息"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi sessions rebuild under a new owner-derived id and deleteOwner removes the old owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-session-merge-"));
  try {
    const store = new PiSessionStore(root);
    const oldIdentity: PiSessionIdentity = {
      sessionId: projectSessionId("guest:merge", "project/merge", "snapshot:old"),
      ownerId: "guest:merge",
      projectId: "project/merge",
      snapshotId: "snapshot:old",
      skillId: "primary-supervisor",
      skillVersion: "test",
    };
    await store.withSession(oldIdentity, async ({ session }) => {
      await store.appendMessages(session, [user("旧用户消息"), user("旧助手消息")]);
    });
    const rebuiltIdentity: PiSessionIdentity = {
      ...oldIdentity,
      ownerId: "github:42",
      sessionId: projectSessionId("github:42", oldIdentity.projectId, oldIdentity.snapshotId),
    };
    await store.rebuildFromMessages(rebuiltIdentity, [
      { role: "user", content: "权威项目消息", createdAt: "2026-08-21T00:00:00.000Z" },
      { role: "assistant", content: "权威回答", createdAt: "2026-08-21T00:00:01.000Z" },
    ]);
    assert.equal((await store.listOwnerSessions("github:42")).length, 1);
    assert.deepEqual((await store.snapshot(rebuiltIdentity)).messages.map(textOf), ["权威项目消息", "权威回答"]);
    assert.equal((await store.listOwnerSessions("guest:merge")).length, 1);
    assert.equal(await store.deleteOwner("guest:merge"), 1);
    assert.equal((await store.listOwnerSessions("guest:merge")).length, 0);
    assert.equal((await store.listOwnerSessions("github:42")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
