import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckRegistry } from "../src/checks.js";
import { FeedbackEvolutionWorker } from "../src/feedback-worker.js";
import { checkDefinitionDigest } from "../src/isolation.js";
import type { CheckDefinition, PiSessionFactory } from "../src/contracts.js";
import { PiEvolutionRunner } from "../src/runner.js";
import { EvolutionStateStore } from "../src/state-store.js";
import { SkillVersionRegistry } from "../src/versions.js";
import { sha256 } from "../src/integrity.js";
import {
  FakeSandboxExecutor,
  isolatedExecution,
  TEST_ISOLATION_POLICY,
} from "./fake-sandbox.js";

const CONTRACT: CheckDefinition = {
  id: "skill-contract",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
};

const EVAL: CheckDefinition = {
  id: "skill-eval",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
};

function sessionFactory(): PiSessionFactory {
  return async ({ tools, sessionId, persistEvent, systemPrompt }) => ({
    async prompt() {
      assert.match(sessionId, /^evolution-[a-f0-9]{32}$/);
      assert.match(systemPrompt, /name: skill-evolution/);
      persistEvent({ eventType: "session_start" });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      await byName.get("edit_candidate")?.execute({
        path: "SKILL.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      await byName.get("run_check")?.execute({ checkId: "skill-contract" });
      await byName.get("submit_candidate")?.execute({
        summary: "反馈要求把教学方法版本推进到 v2。",
        risks: ["隔离测试候选"],
        unresolvedIssues: [],
      });
      return {
        sessionId,
        events: [{ eventType: "agent_end" }],
        usage: { inputTokens: 10, outputTokens: 6, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
      };
    },
  });
}

test("isolated feedback worker runs queue-to-review-to-publish without touching production roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-worker-"));
  try {
    const queueRoot = join(root, "queue");
    const skillsRoot = join(root, "skills");
    const skillRoot = join(skillsRoot, "teaching");
    const stateRoot = join(root, "state");
    const versionsRoot = join(root, "versions");
    const workspaceRoot = join(root, "workspaces");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(queueRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: teaching\ndescription: 用于隔离测试。\n---\nversion: v1\n", "utf8");
    await writeFile(join(queueRoot, "request-1.json"), JSON.stringify({
      request_id: "request-1",
      dedupe_key: "b".repeat(64),
      trigger: "human_feedback",
      skill_ids: ["teaching"],
      reasons: ["回答没有解释清楚下一步"],
      strengths: [],
      source_trace_ids: ["trace-1"],
      source_message_ids: ["message-1"],
      sample_count: 2,
      status: "pending",
      task_ids: [],
      task_id: null,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    }), "utf8");

    const executor = new FakeSandboxExecutor((request) => {
      const skill = request.workspaceFiles.find((file) => file.path === "SKILL.md");
      const content = Buffer.from(skill?.contentBase64 ?? "", "base64").toString("utf8");
      const version = content.includes("version: v2") ? 2 : 1;
      return isolatedExecution({
        stdout: request.definition.id === "skill-eval"
          ? JSON.stringify({ metrics: { method_hygiene_score: version } })
          : "",
      });
    });
    const checks = new CheckRegistry(executor, { allowTestPolicy: true });
    checks.register(CONTRACT);
    checks.register(EVAL);
    const contractDigest = checkDefinitionDigest(CONTRACT, TEST_ISOLATION_POLICY);
    const evalDigest = checkDefinitionDigest(EVAL, TEST_ISOLATION_POLICY);
    const state = new EvolutionStateStore(stateRoot);
    const versions = new SkillVersionRegistry(versionsRoot);
    const runner = new PiEvolutionRunner({
      checks,
      sessionFactory: sessionFactory(),
      store: state,
      versions,
      workspaceRoot,
      forbiddenWorkspaceRoots: [queueRoot, skillsRoot],
    });
    const worker = new FeedbackEvolutionWorker({
      queueRoot,
      skillsRoot,
      state,
      versions,
      runner,
      policies: {
        teaching: {
          whitelist: ["SKILL.md"],
          checkIds: ["skill-contract"],
          checkDefinitionDigests: { "skill-contract": contractDigest },
          evaluation: {
            checkId: "skill-eval",
            suiteId: "teaching-method-hygiene",
            datasetVersion: "v1",
            definitionDigest: evalDigest,
            metrics: { method_hygiene_score: { direction: "higher", maxRegression: 0 } },
          },
        },
      },
    });

    const batch = await worker.runOnce();
    assert.equal(batch.promoted.length, 1);
    assert.equal(batch.candidates.length, 1);
    assert.deepEqual(batch.failedTaskIds, []);
    const candidate = batch.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.evaluation.passed, true);
    assert.equal(candidate.evaluation.metrics.method_hygiene_score.candidate, 2);
    assert.equal((await versions.current("teaching"))?.revision, 1);
    assert.equal((await state.loadLedger(candidate.taskId)).status, "awaiting_review");

    const request = JSON.parse(await readFile(join(queueRoot, "request-1.json"), "utf8")) as { status: string; task_ids: string[] };
    assert.equal(request.status, "task_created");
    assert.deepEqual(request.task_ids, [candidate.taskId]);

    const approved = await worker.review({
      taskId: candidate.taskId,
      reviewerId: "isolated-reviewer",
      decision: "approve",
    });
    assert.equal(approved.status, "approved");
    const current = await versions.current("teaching");
    assert.ok(current);
    assert.equal(current.revision, 2);
    assert.equal(current.currentVersion, candidate.candidateVersion);
    const currentBinding = await versions.exportCurrent("teaching");
    assert.match(currentBinding.artifacts[0]?.content ?? "", /version: v2/);
    assert.equal((await state.loadLedger(candidate.taskId)).status, "published");
    assert.deepEqual(await readdir(workspaceRoot), []);
    assert.notEqual(sha256(currentBinding.artifacts[0]?.content ?? ""), sha256("version: v1\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
