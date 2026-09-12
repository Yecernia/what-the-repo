import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage, createProject } from "../domain/conversation.js";
import { newAnalysisJob } from "../domain/jobs.js";
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore, projectSessionId } from "../agent/session-store.js";
import { FileStore } from "../persistence/file-store.js";
import { runRetentionSweep } from "./lifecycle-service.js";

const now = "2026-08-21T00:00:00.000Z";
const old = "2026-07-01T00:00:00.000Z";

async function saveGuest(store: FileStore, ownerId: string, lastSeen = old): Promise<void> {
  await store.saveUser(ownerId, {
    owner_id: ownerId,
    login: "guest",
    display_name: "访客",
    avatar_url: null,
    kind: "guest",
    last_seen_at: lastSeen,
  });
}

test("retention applies 7/30/7 day guest rules and restores a soft-deleted owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-retention-rules-"));
  try {
    const store = new FileStore(root);
    const sessions = new PiSessionStore(join(root, "pi-sessions"));
    const memories = new PiMemoryStore(join(root, "pi-memory"));
    await store.init();

    await saveGuest(store, "guest:empty");
    await saveGuest(store, "guest:recover");
    await saveGuest(store, "guest:delete");
    await saveGuest(store, "guest:active");

    const recover = createProject("guest:recover", "https://github.com/example/recover", "recover", "free:test");
    const deleteProject = createProject("guest:delete", "https://github.com/example/delete", "delete", "free:test");
    const active = createProject("guest:active", "https://github.com/example/active", "active", "free:test");
    for (const project of [recover, deleteProject, active]) {
      const job = newAnalysisJob(project.project_id, `analysis:${project.project_id}`);
      await store.createProjectWithJob(project, job);
      if (project !== active) {
        await store.saveJob({
          ...job,
          status: "succeeded",
          completed_at: now,
          updated_at: now,
          heartbeat_at: now,
          lease_owner: null,
          lease_expires_at: null,
        });
      }
    }

    await memories.upsert({
      memoryId: "memory:delete",
      ownerId: "guest:delete",
      scope: "user",
      key: "goal",
      value: "清理测试",
      sourceMessageIds: [],
      confidence: 1,
      createdAt: old,
      updatedAt: old,
    });
    await sessions.withSession({
      sessionId: projectSessionId("guest:delete", deleteProject.project_id, null),
      ownerId: "guest:delete",
      projectId: deleteProject.project_id,
      snapshotId: null,
      skillId: "primary-supervisor",
      skillVersion: "test",
    }, async ({ session }) => {
      await sessions.appendMessages(session, [{ role: "user", content: "需要删除", timestamp: Date.parse(old) }]);
    });
    const traceId = "trace:delete";
    await store.saveTrace(traceId, { trace_id: traceId, event_type: "test", owner_id: "guest:delete", project_id: deleteProject.project_id });
    await store.saveEvolutionFeedbackRequest({
      request_id: "feedback:delete",
      dedupe_key: "delete",
      trigger: "human_feedback",
      skill_ids: ["primary-conversational-supervisor"],
      reasons: ["test"],
      strengths: [],
      source_trace_ids: [traceId],
      source_message_ids: [],
      sample_count: 1,
      owner_ids: ["guest:delete"],
      owner_id: "guest:delete",
      status: "pending",
      task_ids: [],
      created_at: old,
      updated_at: old,
    });
    await store.saveEvolutionFeedbackRequest({
      request_id: "feedback:shared",
      dedupe_key: "shared",
      trigger: "human_feedback",
      skill_ids: ["primary-conversational-supervisor"],
      reasons: ["shared"],
      strengths: [],
      source_trace_ids: [traceId],
      source_message_ids: [],
      sample_count: 2,
      owner_ids: ["guest:delete", "github:other"],
      owner_id: "guest:delete",
      status: "pending",
      task_ids: [],
      created_at: old,
      updated_at: old,
    });

    const first = await runRetentionSweep({ store, sessions, memories, now });
    assert.deepEqual(first.softDeletedOwners.sort(), ["guest:delete", "guest:recover"]);
    assert.deepEqual(first.deletedOwners, ["guest:empty"]);
    assert.ok(await store.loadUser("guest:recover"));
    assert.equal((await store.loadUser("guest:recover"))?.deleted_at !== undefined, true);
    assert.ok(await store.loadProject(deleteProject.project_id, "guest:delete"));
    assert.ok(await store.loadUser("guest:active"));

    const restored = await store.touchOwner("guest:recover", "2026-08-22T00:00:00.000Z", 0);
    assert.equal(restored?.deleted_at, null);
    assert.equal((await store.loadUser("guest:recover"))?.deleted_at, null);

    const second = await runRetentionSweep({
      store,
      sessions,
      memories,
      now: "2026-08-29T00:00:01.000Z",
    });
    assert.deepEqual(second.deletedOwners, ["guest:delete"]);
    assert.equal(await store.loadUser("guest:delete"), null);
    assert.equal(await store.loadProject(deleteProject.project_id), null);
    assert.deepEqual(await memories.list("guest:delete"), []);
    assert.equal((await sessions.listOwnerSessions("guest:delete")).length, 0);
    assert.deepEqual(await store.listTraces(deleteProject.project_id), []);
    const remainingFeedback = await store.listEvolutionFeedbackRequests();
    assert.equal(remainingFeedback.some((row) => row.request_id === "feedback:delete"), false);
    assert.deepEqual(remainingFeedback.find((row) => row.request_id === "feedback:shared")?.owner_ids, ["github:other"]);
    assert.equal((await store.listJobs()).some((job) => job.project_id === deleteProject.project_id), false);
    assert.ok(await store.loadUser("guest:active"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active analysis excludes a guest from retention candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-retention-active-"));
  try {
    const store = new FileStore(root);
    await store.init();
    await saveGuest(store, "guest:busy");
    const project = createProject("guest:busy", "https://github.com/example/busy", "busy", "free:test");
    await store.createProjectWithJob(project, newAnalysisJob(project.project_id, "analysis:busy"));
    const candidates = await store.listGuestRetentionCandidates(now);
    assert.equal(candidates.some((candidate) => candidate.owner_id === "guest:busy"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
