import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvolutionTask, OperationLedger } from "../src/contracts.js";
import type { FeedbackEvolutionRequest } from "../src/feedback-queue.js";
import { sha256, stableJson } from "../src/integrity.js";
import { PostgresEvolutionPersistence } from "../src/postgres-state.js";
import { EvolutionStateStore } from "../src/state-store.js";

function result<Row>(rows: Row[] = [], rowCount = rows.length) {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

class FakeEvolutionDatabase {
  readonly tasks = new Map<string, {
    task: EvolutionTask;
    ledger: OperationLedger;
  }>();
  readonly feedback = new Map<string, FeedbackEvolutionRequest>();

  async query<Row>(text: string, values: unknown[] = []): Promise<ReturnType<typeof result<Row>>> {
    const sql = text.replace(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO evolution_tasks")) {
      const taskId = String(values[0]);
      if (this.tasks.has(taskId)) return result<Row>([], 0);
      this.tasks.set(taskId, {
        task: JSON.parse(String(values[4])) as EvolutionTask,
        ledger: JSON.parse(String(values[5])) as OperationLedger,
      });
      return result<Row>([], 1);
    }
    if (sql === "SELECT 1 FROM evolution_tasks WHERE task_id = $1") {
      return result<Row>([], this.tasks.has(String(values[0])) ? 1 : 0);
    }
    if (sql.startsWith("SELECT task_id FROM evolution_tasks")) {
      const status = values[0];
      return result([...this.tasks.entries()]
        .filter(([, row]) => status === undefined || row.ledger.status === status)
        .map(([task_id]) => ({ task_id })) as Row[]);
    }
    if (sql === "SELECT task_payload FROM evolution_tasks WHERE task_id = $1") {
      const row = this.tasks.get(String(values[0]));
      return result(row ? [{ task_payload: structuredClone(row.task) } as Row] : []);
    }
    if (sql === "SELECT ledger_payload FROM evolution_tasks WHERE task_id = $1") {
      const row = this.tasks.get(String(values[0]));
      return result(row ? [{ ledger_payload: structuredClone(row.ledger) } as Row] : []);
    }
    if (sql.startsWith("UPDATE evolution_tasks SET status = $2")) {
      const row = this.tasks.get(String(values[0]));
      if (!row) return result<Row>([], 0);
      row.ledger = JSON.parse(String(values[2])) as OperationLedger;
      return result<Row>([], 1);
    }
    if (sql.startsWith("SELECT payload FROM evolution_feedback_requests")) {
      const ids = Array.isArray(values[0]) ? values[0].map(String) : [...this.feedback.keys()];
      const limit = Number(Array.isArray(values[0]) ? values[1] : values[0]);
      return result(ids.flatMap((id) => {
        const row = this.feedback.get(id);
        return row && (row.status === "pending" || Array.isArray(values[0]) && row.status === "task_created")
          ? [{ payload: structuredClone(row) } as Row]
          : [];
      }).slice(0, limit));
    }
    if (sql.startsWith("UPDATE evolution_feedback_requests")) {
      const request = JSON.parse(String(values[4])) as FeedbackEvolutionRequest;
      if (!this.feedback.has(request.request_id)) return result<Row>([], 0);
      this.feedback.set(request.request_id, request);
      return result<Row>([], 1);
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  }
}

function taskAndLedger(): { task: EvolutionTask; ledger: OperationLedger } {
  const task: EvolutionTask = {
    taskId: "task-postgres-authority",
    trigger: "human_feedback",
    failureEvidence: ["回答没有解释清楚"],
    skillId: "teaching",
    baseSkillVersion: "v1",
    baseRevision: 1,
    baseSnapshotDigest: "a".repeat(64),
    whitelist: ["SKILL.md"],
    checkIds: ["skill-contract"],
    checkDefinitionDigests: { "skill-contract": "b".repeat(64) },
    evaluation: {
      checkId: "skill-eval",
      suiteId: "teaching-eval",
      datasetVersion: "v1",
      definitionDigest: "c".repeat(64),
      metrics: { score: { direction: "higher", maxRegression: 0 } },
    },
    maxSteps: 10,
    maxTimeMs: 60_000,
    maxTokens: 10_000,
    maxCostUsd: 1,
    maxCandidateBytes: 64 * 1024,
  };
  const now = "2026-08-24T00:00:00.000Z";
  return {
    task,
    ledger: {
      taskId: task.taskId,
      taskDigest: sha256(stableJson(task)),
      status: "created",
      createdAt: now,
      updatedAt: now,
      steps: [],
      allowedTools: ["read_candidate", "write_candidate", "edit_candidate", "run_check", "submit_candidate"],
      operations: [],
      checkResults: [],
      sideEffects: [],
      compactionContext: "",
    },
  };
}

test("PostgreSQL journal is authoritative for evolution task and ledger state", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-evolution-postgres-"));
  try {
    const database = new FakeEvolutionDatabase();
    const persistence = PostgresEvolutionPersistence.fromClient(database as never);
    const store = new EvolutionStateStore(root, persistence);
    const { task, ledger } = taskAndLedger();
    await store.create(task, ledger);
    await writeFile(join(root, "tasks", task.taskId, "ledger.json"), "{}\n", "utf8");
    assert.equal((await store.loadLedger(task.taskId)).status, "created");
    ledger.steps.push("postgres_updated");
    await store.saveLedger(ledger);
    assert.deepEqual((await persistence.loadLedger(task.taskId))?.steps, ["postgres_updated"]);
    assert.deepEqual(await store.listTaskIds("created"), [task.taskId]);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL feedback request source persists promotion status", async () => {
  const database = new FakeEvolutionDatabase();
  const persistence = PostgresEvolutionPersistence.fromClient(database as never);
  const request: FeedbackEvolutionRequest = {
    request_id: "feedback-request-postgres",
    dedupe_key: "d".repeat(64),
    trigger: "human_feedback",
    skill_ids: ["teaching"],
    reasons: ["解释不清楚"],
    strengths: [],
    source_trace_ids: [],
    source_message_ids: [],
    sample_count: 1,
    status: "pending",
    task_ids: [],
    task_id: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
  database.feedback.set(request.request_id, request);
  assert.equal((await persistence.list([request.request_id], 20))[0]?.status, "pending");
  request.status = "task_created";
  request.task_ids = ["task-postgres-authority"];
  request.task_id = request.task_ids[0];
  await persistence.save(request);
  assert.equal(database.feedback.get(request.request_id)?.status, "task_created");
});
