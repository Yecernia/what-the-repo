import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvolutionStateStore } from "../src/state-store.js";
import { SkillVersionRegistry } from "../src/versions.js";
import {
  promoteFeedbackRequests,
  type FeedbackEvolutionRequest,
  type FeedbackEvolutionRequestStore,
} from "../src/feedback-queue.js";

test("feedback outbox is promoted into one reviewed task per target Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-queue-"));
  try {
    const queueRoot = join(root, "queue");
    const versions = new SkillVersionRegistry(join(root, "versions"));
    const content = "---\nname: teaching\ndescription: 用于测试。\n---\n只读 Skill。\n";
    const skillsRoot = join(root, "skills");
    await mkdir(join(skillsRoot, "teaching"), { recursive: true });
    await writeFile(join(skillsRoot, "teaching", "SKILL.md"), content, "utf8");
    await mkdir(queueRoot, { recursive: true });
    const requestPath = join(queueRoot, "feedback-request-1.json");
    await writeFile(requestPath, JSON.stringify({
      request_id: "feedback-request-1",
      dedupe_key: "b".repeat(64),
      trigger: "human_feedback",
      skill_ids: ["teaching"],
      reasons: ["解释没有回应问题"],
      strengths: [],
      source_trace_ids: ["trace-1"],
      source_message_ids: ["message-1"],
      sample_count: 3,
      status: "pending",
      task_ids: [],
      task_id: null,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
    }), "utf8");
    const digest = "a".repeat(64);
    const promoted = await promoteFeedbackRequests({
      queueRoot,
      state: new EvolutionStateStore(join(root, "state")),
      versions,
      skillsRoot,
      policies: {
        teaching: {
          whitelist: ["SKILL.md"],
          checkIds: ["skill-contract"],
          checkDefinitionDigests: { "skill-contract": digest },
          evaluation: {
            checkId: "skill-eval",
            suiteId: "teaching-contract",
            datasetVersion: "v1",
            definitionDigest: digest,
            metrics: { score: { direction: "higher", maxRegression: 0 } },
          },
        },
      },
    });
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]?.taskIds.length, 1);
    const taskId = promoted[0]?.taskIds[0];
    assert.ok(taskId);
    const task = await new EvolutionStateStore(join(root, "state")).loadTask(taskId);
    assert.equal(task.trigger, "human_feedback");
    assert.equal(task.skillId, "teaching");
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { status: string; task_ids: string[] };
    assert.equal(request.status, "task_created");
    assert.deepEqual(request.task_ids, [taskId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request-backed promotion uses the requested Redis wake-up ID and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-request-store-"));
  try {
    const skillsRoot = join(root, "skills");
    await mkdir(join(skillsRoot, "teaching"), { recursive: true });
    await writeFile(
      join(skillsRoot, "teaching", "SKILL.md"),
      "---\nname: teaching\ndescription: 用于测试。\n---\n只读 Skill。\n",
      "utf8",
    );
    const request = (id: string): FeedbackEvolutionRequest => ({
      request_id: id,
      dedupe_key: id === "request-one" ? "a".repeat(64) : "b".repeat(64),
      trigger: "human_feedback",
      skill_ids: ["teaching"],
      reasons: ["解释没有回应问题"],
      strengths: [],
      source_trace_ids: [],
      source_message_ids: [],
      sample_count: 1,
      status: "pending",
      task_ids: [],
      task_id: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
    });
    const rows = new Map([
      ["request-one", request("request-one")],
      ["request-two", request("request-two")],
    ]);
    const requestStore: FeedbackEvolutionRequestStore = {
      async list(requestIds, limit) {
        const ids = requestIds ?? [...rows.keys()];
        return ids.slice(0, limit).flatMap((id) => {
          const row = rows.get(id);
          return row ? [structuredClone(row)] : [];
        });
      },
      async save(row) {
        rows.set(row.request_id, structuredClone(row));
      },
    };
    const state = new EvolutionStateStore(join(root, "state"));
    const versions = new SkillVersionRegistry(join(root, "versions"));
    const digest = "c".repeat(64);
    const options = {
      queueRoot: join(root, "unused-file-queue"),
      requestStore,
      state,
      versions,
      skillsRoot,
      policies: {
        teaching: {
          whitelist: ["SKILL.md"],
          checkIds: ["skill-contract"],
          checkDefinitionDigests: { "skill-contract": digest },
          evaluation: {
            checkId: "skill-eval",
            suiteId: "teaching-contract",
            datasetVersion: "v1",
            definitionDigest: digest,
            metrics: { score: { direction: "higher" as const, maxRegression: 0 } },
          },
        },
      },
    };

    const first = await promoteFeedbackRequests(options, ["request-two"]);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.requestId, "request-two");
    assert.equal(rows.get("request-one")?.status, "pending");
    assert.equal(rows.get("request-two")?.status, "task_created");
    const repeated = await promoteFeedbackRequests(options, ["request-two"]);
    assert.deepEqual(repeated[0]?.taskIds, first[0]?.taskIds);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
