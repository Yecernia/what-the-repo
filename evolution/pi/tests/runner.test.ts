import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckRegistry } from "../src/checks.js";
import type {
  CheckDefinition,
  EvolutionTask,
  OperationLedger,
  PiSessionFactory,
  ReviewDecision,
  RestrictedToolName,
  SkillCandidate,
  SkillVersionBinding,
} from "../src/contracts.js";
import type { TrustedIsolationPolicy } from "../src/isolation.js";
import { reviewedCandidateDigest, sha256, stableJson } from "../src/integrity.js";
import { PiEvolutionRunner } from "../src/runner.js";
import { EvolutionWorkspace } from "../src/safe-workspace.js";
import { EvolutionStateStore } from "../src/state-store.js";
import {
  artifactSnapshotDigest,
  materializedCandidateArtifacts,
  SkillVersionRegistry,
} from "../src/versions.js";
import { PiBudgetExceededError, PiBudgetPreflightError } from "../src/pi-sdk.js";
import {
  FakeSandboxExecutor,
  isolatedExecution,
  TEST_ISOLATION_POLICY,
} from "./fake-sandbox.js";
import { checkDefinitionDigest } from "../src/isolation.js";
import { createReviewDecision } from "../src/review.js";

async function fixture(
  prefix: string,
  baseVersion = "1.0.0",
): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "skill.md"), "version: v1\n", "utf8");
  await new SkillVersionRegistry(join(root, "versions")).bootstrap(
    "teaching",
    baseVersion,
    "fixture-bootstrap",
    baseArtifacts(),
  );
  return { root, source };
}

function baseArtifacts() {
  const content = "version: v1\n";
  return [{ path: "skill.md", content, sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") }];
}

const BASE_SNAPSHOT_DIGEST = artifactSnapshotDigest(baseArtifacts());

const FIXED_EVAL_DEFINITION: CheckDefinition = {
  id: "fixed-eval",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

const FIXED_EVAL_DIGEST = checkDefinitionDigest(FIXED_EVAL_DEFINITION, TEST_ISOLATION_POLICY);

const PASS_DEFINITION: CheckDefinition = {
  id: "pass",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

const PASS_DIGEST = checkDefinitionDigest(PASS_DEFINITION, TEST_ISOLATION_POLICY);

function task(
  root: string,
  _source: string,
  taskId: string,
  baseSkillVersion = "1.0.0",
  baseRevision = 1,
  baseSnapshotDigest = BASE_SNAPSHOT_DIGEST,
): EvolutionTask {
  return {
    taskId,
    trigger: "eval",
    failureEvidence: ["The fixed eval expects the version marker to advance."],
    skillId: "teaching",
    baseSkillVersion,
    baseRevision,
    baseSnapshotDigest,
    whitelist: ["skill.md"],
    checkIds: ["pass"],
    checkDefinitionDigests: { pass: PASS_DIGEST },
    evaluation: {
      checkId: "fixed-eval",
      suiteId: "skill-version-fixture",
      datasetVersion: "v1",
      definitionDigest: FIXED_EVAL_DIGEST,
      metrics: { score: { direction: "higher", maxRegression: 0 } },
    },
    maxSteps: 4,
    maxTimeMs: 2_000,
    maxTokens: 10_000,
    maxCostUsd: 1,
  };
}

function editingSession(expected: string, replacement: string): PiSessionFactory {
  return async ({ tools, agentDir, sessionDir, sessionId, systemPrompt, persistEvent }) => ({
    async prompt() {
      assert.match(agentDir, /[\\/]pi[\\/]agent$/);
      assert.match(sessionDir, /[\\/]pi[\\/]sessions$/);
      assert.match(sessionId, /^evolution-[a-f0-9]{32}$/);
      assert.match(systemPrompt, /There is no Bash, network/);
      assert.match(systemPrompt, /name: skill-evolution/);
      assert.match(systemPrompt, /only check IDs you may pass to run_check are: pass/);
      persistEvent({ eventType: "session_start" });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      await byName.get("edit_candidate")?.execute({ path: "skill.md", expected, replacement });
      await byName.get("run_check")?.execute({ checkId: "pass" });
      await byName.get("submit_candidate")?.execute({
        summary: `Replace ${expected.trim()} with ${replacement.trim()}`,
        risks: ["fixed fixture only"],
        unresolvedIssues: [],
      });
      return {
        sessionId,
        events: [{ eventType: "agent_end" }],
        usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 2, cacheWriteTokens: 0, costUsd: 0.001 },
      };
    },
  });
}

function report(sessionId: string, eventType: string) {
  return {
    sessionId,
    events: [{ eventType }],
    usage: { inputTokens: 7, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 },
  };
}

async function editForRecovery(tools: Parameters<PiSessionFactory>[0]["tools"]): Promise<void> {
  await tools.find((tool) => tool.name === "edit_candidate")?.execute({
    path: "skill.md",
    expected: "version: v1",
    replacement: "version: v2",
  });
}

function runner(root: string, checks: CheckRegistry, sessionFactory?: PiSessionFactory): PiEvolutionRunner {
  return runnerWithVersions(
    root,
    checks,
    new SkillVersionRegistry(join(root, "versions")),
    sessionFactory,
  );
}

function runnerWithVersions(
  root: string,
  checks: CheckRegistry,
  versions: SkillVersionRegistry,
  sessionFactory?: PiSessionFactory,
): PiEvolutionRunner {
  return new PiEvolutionRunner({
    checks,
    sessionFactory,
    store: new EvolutionStateStore(join(root, "state")),
    versions,
    workspaceRoot: join(root, "work"),
  });
}

class CommitThenThrowRegistry extends SkillVersionRegistry {
  failPublish = false;
  failRollback = false;

  override async publish(
    candidate: SkillCandidate,
    ledger: OperationLedger,
    decision: ReviewDecision,
    evolutionTask: EvolutionTask,
    checkRegistry: CheckRegistry,
  ): Promise<SkillVersionBinding> {
    const binding = await super.publish(candidate, ledger, decision, evolutionTask, checkRegistry);
    if (this.failPublish) throw new Error("publication response was lost after registry commit");
    return binding;
  }

  override async rollback(
    skillId: string,
    taskId: string,
    expectedCurrentVersion: string,
    expectedCurrentRevision: number,
    expectedCurrentSnapshotDigest: string,
    targetVersion: string,
  ): Promise<SkillVersionBinding> {
    const binding = await super.rollback(
      skillId,
      taskId,
      expectedCurrentVersion,
      expectedCurrentRevision,
      expectedCurrentSnapshotDigest,
      targetVersion,
    );
    if (this.failRollback) throw new Error("rollback response was lost after registry commit");
    return binding;
  }
}

function checks(candidateScore?: number): CheckRegistry {
  const executor = new FakeSandboxExecutor((request) => {
    const skill = request.workspaceFiles.find((file) => file.path === "skill.md");
    const content = skill ? Buffer.from(skill.contentBase64, "base64").toString("utf8") : "";
    const version = Number.parseInt(content.match(/version: v(\d+)/)?.[1] ?? "1", 10);
    const score = version === 1 ? 1 : (candidateScore ?? version);
    return isolatedExecution({
      stdout: request.definition.id === "fixed-eval"
        ? JSON.stringify({ metrics: { score } })
        : "",
      elapsedMs: request.definition.id === "fixed-eval" ? 2 : 1,
    });
  });
  const registry = new CheckRegistry(executor, { allowTestPolicy: true });
  registry.register(PASS_DEFINITION);
  registry.register(FIXED_EVAL_DEFINITION);
  return registry;
}

function review(
  taskId: string,
  ledger: OperationLedger,
  candidate: SkillCandidate,
  decision: ReviewDecision["decision"],
  reason?: string,
): ReviewDecision {
  return {
    taskId,
    reviewerId: "test-human-reviewer",
    decision,
    candidateDigest: ledger.candidateDigest ?? "",
    taskDigest: ledger.taskDigest,
    baseRevision: candidate.baseRevision,
    baseSnapshotDigest: candidate.baseSnapshotDigest,
    claimedAt: new Date().toISOString(),
    ...(reason === undefined ? {} : { reason }),
  };
}

test("runner creates a real candidate, gates it, and requires explicit publication", async () => {
  const { root, source } = await fixture("what-the-repo-pi-run-");
  const registry = checks();
  const evolution = runner(root, registry, editingSession("version: v1", "version: v2"));

  const { candidate, ledger } = await evolution.run(task(root, source, "task-1"));
  assert.equal(ledger.status, "awaiting_review");
  assert.equal(candidate.status, "candidate");
  assert.deepEqual(candidate.changedFiles, ["skill.md"]);
  assert.match(candidate.diff, /-version: v1/);
  assert.match(candidate.diff, /\+version: v2/);
  assert.equal(candidate.checks.length, 1);
  assert.equal(candidate.checks[0].passed, true);
  assert.equal(candidate.evaluation.passed, true);
  assert.equal(candidate.evaluation.metrics.score.baseline, 1);
  assert.equal(candidate.evaluation.metrics.score.candidate, 2);
  assert.equal(candidate.evaluation.baselineVersion, "1.0.0");
  assert.equal(candidate.evaluation.definitionDigest, FIXED_EVAL_DIGEST);
  assert.notEqual(candidate.evaluation.baselineOutputDigest, candidate.evaluation.outputDigest);
  assert.equal(ledger.piReport?.usage.cachedTokens, 2);
  assert.match(
    await readFile(join(root, "state", "tasks", "task-1", "pi", "events.jsonl"), "utf8"),
    /session_start/,
  );

  await assert.rejects(
    () => new SkillVersionRegistry(join(root, "unreviewed-versions")).publish(
      candidate,
      ledger,
      undefined as never,
      task(root, source, "task-1"),
      registry,
    ),
    /explicit review decision|review decision/,
  );

  const approval = review("task-1", ledger, candidate, "approve");
  await assert.rejects(
    () => new SkillVersionRegistry(join(root, "versions")).publish(
      candidate,
      ledger,
      approval,
      task(root, source, "task-1"),
      { assertTrustedIsolation() {} } as never,
    ),
    /built-in trusted check registry/,
  );
  const approved = await evolution.approve("task-1", approval);
  assert.equal(approved.status, "approved");
  const current = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(current?.currentVersion, candidate.candidateVersion);

  await assert.rejects(() => evolution.approve("task-1", approval), /not awaiting review/);
  const unchanged = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(unchanged?.history.length, 2);
});

test("runner gives a bounded continuation when Pi only inspects the candidate", async () => {
  const { root, source } = await fixture("what-the-repo-pi-continuation-");
  let prompts = 0;
  const inspectThenEdit: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt(input) {
      prompts += 1;
      if (prompts === 1) {
        assert.match(input, /Inspect the candidate/);
        await tools.find((tool) => tool.name === "read_candidate")?.execute({ path: "skill.md" });
      } else {
        assert.match(input, /previous turn only inspected/);
        await editForRecovery(tools);
        await tools.find((tool) => tool.name === "run_check")?.execute({ checkId: "pass" });
        await tools.find((tool) => tool.name === "submit_candidate")?.execute({
          summary: "The bounded continuation completed the reviewed edit.",
          risks: ["continuation fixture only"],
          unresolvedIssues: [],
        });
      }
      return report(sessionId, prompts === 1 ? "inspection_only" : "candidate_submitted");
    },
  });
  const evolution = runner(root, checks(), inspectThenEdit);
  const run = await evolution.run(task(root, source, "task-continuation"));
  assert.equal(prompts, 2);
  assert.equal(run.candidate.status, "candidate");
  assert.equal(run.ledger.status, "awaiting_review");
});

test("runner consumes an untouched task prepared by the feedback queue", async () => {
  const { root, source } = await fixture("what-the-repo-pi-prepared-feedback-");
  const preparedTask = task(root, source, "prepared-feedback-task");
  preparedTask.trigger = "human_feedback";
  const now = new Date().toISOString();
  const preparedLedger: OperationLedger = {
    taskId: preparedTask.taskId,
    taskDigest: sha256(stableJson(preparedTask)),
    status: "created",
    createdAt: now,
    updatedAt: now,
    steps: ["created_from_human_feedback"],
    allowedTools: ["read_candidate", "write_candidate", "edit_candidate", "run_check", "submit_candidate"],
    operations: [],
    checkResults: [],
    sideEffects: [],
    compactionContext: "",
  };
  await new EvolutionStateStore(join(root, "state")).create(preparedTask, preparedLedger);
  const evolution = runner(
    root,
    checks(),
    editingSession("version: v1", "version: v2"),
  );
  const result = await evolution.run(preparedTask);
  assert.equal(result.ledger.status, "awaiting_review");
  assert.equal(result.ledger.steps.includes("created_from_human_feedback"), true);
  assert.equal(result.candidate.status, "candidate");
  const decision = await createReviewDecision({
    state: evolution.stateStore,
    taskId: preparedTask.taskId,
    reviewerId: "reviewer",
    decision: "approve",
  });
  await evolution.approve(preparedTask.taskId, decision);
  assert.equal(
    (await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.currentVersion,
    result.candidate.candidateVersion,
  );
});

test("publication rejects a gate definition changed after runner restart", async () => {
  const { root, source } = await fixture("what-the-repo-pi-gate-drift-");
  const original = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const run = await original.run(task(root, source, "task-gate-drift"));
  const changedPass: CheckDefinition = {
    ...PASS_DEFINITION,
    timeoutMs: PASS_DEFINITION.timeoutMs + 1,
  };
  const restartedChecks = new CheckRegistry(new FakeSandboxExecutor((request) =>
    isolatedExecution({
      stdout: request.definition.id === "fixed-eval"
        ? JSON.stringify({ metrics: { score: 2 } })
        : "",
    })), { allowTestPolicy: true });
  restartedChecks.register(changedPass);
  restartedChecks.register(FIXED_EVAL_DEFINITION);
  const restarted = runner(root, restartedChecks);

  await assert.rejects(
    () => restarted.approve(
      run.candidate.taskId,
      review(run.candidate.taskId, run.ledger, run.candidate, "approve"),
    ),
    /required check definition changed after review: pass/,
  );
  assert.equal(
    (await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision,
    1,
  );
});

test("repeated large check output cannot exceed the operation ledger budget", async () => {
  const { root, source } = await fixture("what-the-repo-pi-ledger-budget-");
  const largeOutput = "x".repeat(16 * 1024);
  const registry = new CheckRegistry(new FakeSandboxExecutor((request) => isolatedExecution({
    stdout: request.definition.id === "fixed-eval"
      ? JSON.stringify({ metrics: { score: 1 } })
      : largeOutput,
  })), { allowTestPolicy: true });
  registry.register({ ...PASS_DEFINITION, maxOutputBytes: 64 * 1024 });
  registry.register(FIXED_EVAL_DEFINITION);
  const budgetTask = task(root, source, "task-ledger-budget");
  budgetTask.checkDefinitionDigests.pass = registry.definitionDigest("pass");
  budgetTask.maxSteps = 50;
  budgetTask.maxTimeMs = 10_000;
  const sessionFactory: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt() {
      const runCheck = tools.find((tool) => tool.name === "run_check");
      assert.ok(runCheck);
      for (let index = 0; index < 40; index += 1) {
        await runCheck.execute({ checkId: "pass" });
      }
      throw new Error("ledger budget should stop repeated checks");
    },
  });
  const evolution = runner(root, registry, sessionFactory);

  await assert.rejects(
    () => evolution.run(budgetTask),
    /persisted check results exceed the operation ledger budget/,
  );
  const ledger = await new EvolutionStateStore(join(root, "state")).loadLedger(
    budgetTask.taskId,
  );
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(
    ledger.operations.some((operation) =>
      operation.kind === "check" && operation.status === "failed" &&
      operation.error?.message === "persisted check results exceed the operation ledger budget"),
    true,
  );
  assert.ok(ledger.checkResults.length < 40);
  assert.ok(ledger.checkResults.reduce(
    (bytes, result) => bytes + Buffer.byteLength(result.stdout, "utf8") +
      Buffer.byteLength(result.stderr, "utf8"),
    0,
  ) <= 512 * 1024);
});

test("publication rejects candidate or task state changed after review", async () => {
  const candidateFixture = await fixture("what-the-repo-pi-tamper-candidate-");
  const candidateRunner = runner(
    candidateFixture.root,
    checks(),
    editingSession("version: v1", "version: v2"),
  );
  const candidateRun = await candidateRunner.run(
    task(candidateFixture.root, candidateFixture.source, "task-tampered-candidate"),
  );
  const candidatePath = join(candidateFixture.root, "state", "tasks", "task-tampered-candidate", "candidate.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as { checks: unknown[] };
  candidate.checks = [];
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => candidateRunner.approve(
      "task-tampered-candidate",
      review("task-tampered-candidate", candidateRun.ledger, candidateRun.candidate, "approve"),
    ),
    /candidate digest does not match/,
  );
  assert.equal(
    (await new SkillVersionRegistry(join(candidateFixture.root, "versions")).current("teaching"))?.revision,
    1,
  );

  const taskFixture = await fixture("what-the-repo-pi-tamper-task-");
  const taskRunner = runner(taskFixture.root, checks(), editingSession("version: v1", "version: v2"));
  const taskRun = await taskRunner.run(
    task(taskFixture.root, taskFixture.source, "task-tampered-task"),
  );
  const taskPath = join(taskFixture.root, "state", "tasks", "task-tampered-task", "task.json");
  const storedTask = JSON.parse(await readFile(taskPath, "utf8")) as EvolutionTask;
  storedTask.failureEvidence = ["A valid but unreviewed replacement for the original evidence."];
  await writeFile(taskPath, `${JSON.stringify(storedTask, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => taskRunner.approve(
      "task-tampered-task",
      review("task-tampered-task", taskRun.ledger, taskRun.candidate, "approve"),
    ),
    /task digest does not match/,
  );
  assert.equal(
    (await new SkillVersionRegistry(join(taskFixture.root, "versions")).current("teaching"))?.revision,
    1,
  );
});

test("publication rejects a tampered fixed evaluation output digest", async () => {
  const { root, source } = await fixture("what-the-repo-pi-tamper-eval-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const run = await evolution.run(task(root, source, "task-tampered-eval"));
  const taskRoot = join(root, "state", "tasks", "task-tampered-eval");
  const candidatePath = join(taskRoot, "candidate.json");
  const ledgerPath = join(taskRoot, "ledger.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as typeof run.candidate;
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as OperationLedger;
  candidate.evaluation.baselineOutputDigest = sha256("forged-baseline-output");
  ledger.evaluation = structuredClone(candidate.evaluation);
  ledger.candidateDigest = reviewedCandidateDigest(candidate);
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => evolution.approve(
      "task-tampered-eval",
      review("task-tampered-eval", ledger, candidate, "approve"),
    ),
    /fixed evaluation does not satisfy|evaluation results differ/,
  );
  assert.equal((await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision, 1);
});

test("publication revalidates persisted sandbox probes after review", async () => {
  const { root, source } = await fixture("what-the-repo-pi-tamper-isolation-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const run = await evolution.run(task(root, source, "task-tampered-isolation"));
  const candidatePath = join(root, "state", "tasks", run.candidate.taskId, "candidate.json");
  const stored = JSON.parse(await readFile(candidatePath, "utf8")) as SkillCandidate;
  stored.checks[0].isolation.runtimeProbe.networkInterfaces = ["eth0"] as never;
  await writeFile(candidatePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => evolution.approve(
      run.candidate.taskId,
      review(run.candidate.taskId, run.ledger, run.candidate, "approve"),
    ),
    /runtime probe network isolation|trusted isolation policy/,
  );
  assert.equal((await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision, 1);
});

test("a stale candidate cannot overwrite a newer publication", async () => {
  const { root, source } = await fixture("what-the-repo-pi-stale-candidate-");
  const registry = checks();
  const firstRunner = runner(root, registry, editingSession("version: v1", "version: v2"));
  const staleRunner = runner(root, registry, editingSession("version: v1", "version: v3"));
  const first = await firstRunner.run(task(root, source, "task-current-candidate"));
  const stale = await staleRunner.run(task(root, source, "task-stale-candidate"));

  await firstRunner.approve(
    "task-current-candidate",
    review("task-current-candidate", first.ledger, first.candidate, "approve"),
  );
  await assert.rejects(
    () => staleRunner.approve(
      "task-stale-candidate",
      review("task-stale-candidate", stale.ledger, stale.candidate, "approve"),
    ),
    /base revision is no longer current/,
  );
  const current = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(current?.currentVersion, first.candidate.candidateVersion);
  const staleLedger = await new EvolutionStateStore(join(root, "state")).loadLedger("task-stale-candidate");
  assert.equal(staleLedger.status, "failed");
  assert.equal(staleLedger.steps.includes("stale_candidate_rejected"), true);
});

test("a candidate from revision one stays stale after an ABA rollback to the same version", async () => {
  const { root, source } = await fixture("what-the-repo-pi-aba-");
  const registry = checks();
  const currentRunner = runner(root, registry, editingSession("version: v1", "version: v2"));
  const staleRunner = runner(root, registry, editingSession("version: v1", "version: v3"));
  const current = await currentRunner.run(task(root, source, "task-aba-current"));
  const stale = await staleRunner.run(task(root, source, "task-aba-stale"));

  await currentRunner.approve(
    "task-aba-current",
    review("task-aba-current", current.ledger, current.candidate, "approve"),
  );
  await currentRunner.rollback("task-aba-current", "1.0.0");

  const rolledBack = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(rolledBack?.currentVersion, "1.0.0");
  assert.equal(rolledBack?.revision, 3);
  await assert.rejects(
    () => staleRunner.approve(
      "task-aba-stale",
      review("task-aba-stale", stale.ledger, stale.candidate, "approve"),
    ),
    /base revision is no longer current/,
  );
});

test("runner rejects an incorrect registry revision or snapshot digest before creating state", async () => {
  const { root, source } = await fixture("what-the-repo-pi-binding-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  await assert.rejects(
    () => evolution.run(task(root, source, "task-wrong-revision", "1.0.0", 2)),
    /base binding is no longer current/,
  );
  await assert.rejects(
    () => evolution.run(task(
      root,
      source,
      "task-wrong-snapshot",
      "1.0.0",
      1,
      sha256("forged-snapshot"),
    )),
    /base binding is no longer current/,
  );
  const store = new EvolutionStateStore(join(root, "state"));
  await assert.rejects(() => store.loadTask("task-wrong-revision"), /ENOENT/);
  await assert.rejects(() => store.loadTask("task-wrong-snapshot"), /ENOENT/);
});

test("a one-file whitelist publishes over a complete multi-file Skill snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-multifile-"));
  const registry = new SkillVersionRegistry(join(root, "versions"));
  const completeBase = [
    ...baseArtifacts(),
    { path: "policy.md", content: "keep: true\n", sha256: sha256("keep: true\n"), bytes: 11 },
  ];
  const binding = await registry.bootstrap("teaching", "1.0.0", "multifile-bootstrap", completeBase);
  const evolution = runnerWithVersions(
    root,
    checks(),
    registry,
    editingSession("version: v1", "version: v2"),
  );
  const run = await evolution.run(task(
    root,
    "",
    "task-multifile",
    binding.version,
    binding.revision,
    binding.snapshotDigest,
  ));
  assert.equal(run.candidate.baseArtifacts.length, 2);
  assert.deepEqual(run.candidate.changedFiles, ["skill.md"]);
  await evolution.approve(
    "task-multifile",
    review("task-multifile", run.ledger, run.candidate, "approve"),
  );
  const published = await registry.exportCurrent("teaching");
  assert.equal(published.artifacts.find((item) => item.path === "policy.md")?.content, "keep: true\n");
  assert.equal(published.artifacts.find((item) => item.path === "skill.md")?.content, "version: v2\n");
});

test("rejection leaves the published version unchanged", async () => {
  const { root, source } = await fixture("what-the-repo-pi-reject-");
  const registry = checks();
  const evolution = runner(root, registry, editingSession("version: v1", "version: v2"));
  const publishRun = await evolution.run(task(root, source, "task-publish"));
  const published = await evolution.approve(
    "task-publish",
    review("task-publish", publishRun.ledger, publishRun.candidate, "approve"),
  );

  const currentBinding = await new SkillVersionRegistry(join(root, "versions")).exportCurrent("teaching");
  const rejectRunner = runner(root, registry, editingSession("version: v2", "version: v3"));
  const rejectRun = await rejectRunner.run(task(
    root,
    source,
    "task-reject",
    currentBinding.version,
    currentBinding.revision,
    currentBinding.snapshotDigest,
  ));
  const rejected = await rejectRunner.reject(
    "task-reject",
    review(
      "task-reject",
      rejectRun.ledger,
      rejectRun.candidate,
      "reject",
      "manual review found no benefit",
    ),
  );
  assert.equal(rejected.status, "rejected");
  const current = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(current?.currentVersion, published.candidateVersion);
});

test("approve and reject compete for one durable review decision", async () => {
  const { root, source } = await fixture("what-the-repo-pi-review-race-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const raceRun = await evolution.run(task(root, source, "task-review-race"));

  const results = await Promise.allSettled([
    evolution.approve(
      "task-review-race",
      review("task-review-race", raceRun.ledger, raceRun.candidate, "approve"),
    ),
    evolution.reject(
      "task-review-race",
      review("task-review-race", raceRun.ledger, raceRun.candidate, "reject", "concurrent rejection"),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const store = new EvolutionStateStore(join(root, "state"));
  const decision = await store.loadReviewDecision("task-review-race");
  const ledger = await store.loadLedger("task-review-race");
  const candidate = await store.loadCandidate("task-review-race");
  assert.ok(decision);
  if (decision?.decision === "approve") {
    assert.equal(ledger.status, "published");
    assert.equal(candidate.status, "approved");
  } else {
    assert.equal(decision?.decision, "reject");
    assert.equal(ledger.status, "rejected");
    assert.equal(candidate.status, "rejected");
  }
});

test("fixed evaluation regression blocks candidate creation and publication", async () => {
  const { root, source } = await fixture("what-the-repo-pi-eval-regression-");
  const evolution = runner(root, checks(0.75), editingSession("version: v1", "version: v2"));
  await assert.rejects(
    () => evolution.run(task(root, source, "task-eval-regression")),
    /fixed evaluation failed/,
  );
  const store = new EvolutionStateStore(join(root, "state"));
  const ledger = await store.loadLedger("task-eval-regression");
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.evaluation?.passed, false);
  await assert.rejects(() => store.loadCandidate("task-eval-regression"), /ENOENT/);
  assert.equal((await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision, 1);
});

test("published versions can roll back through the registry", async () => {
  const { root, source } = await fixture("what-the-repo-pi-rollback-");
  const registry = checks();
  const firstRunner = runner(root, registry, editingSession("version: v1", "version: v2"));
  const first = await firstRunner.run(task(root, source, "task-first"));
  await firstRunner.approve(
    "task-first",
    review("task-first", first.ledger, first.candidate, "approve"),
  );

  const firstBinding = await new SkillVersionRegistry(join(root, "versions")).exportCurrent("teaching");
  const secondRunner = runner(root, registry, editingSession("version: v2", "version: v3"));
  const second = await secondRunner.run(task(
    root,
    source,
    "task-second",
    firstBinding.version,
    firstBinding.revision,
    firstBinding.snapshotDigest,
  ));
  await secondRunner.approve(
    "task-second",
    review("task-second", second.ledger, second.candidate, "approve"),
  );
  await assert.rejects(
    () => secondRunner.rollback("task-second", second.candidate.candidateVersion),
    /does not match the reviewed candidate/,
  );
  const rolledBack = await secondRunner.rollback("task-second", first.candidate.candidateVersion);

  assert.equal(rolledBack.status, "rolled_back");
  const current = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(current?.currentVersion, first.candidate.candidateVersion);

  await assert.rejects(
    () => firstRunner.rollback("task-first", "1.0.0"),
    /published revision changed|no longer the latest publication/,
  );
  const afterStaleRollback = await new SkillVersionRegistry(join(root, "versions")).current("teaching");
  assert.equal(afterStaleRollback?.currentVersion, first.candidate.candidateVersion);
});

test("a publish committed before transport failure leaves a recoverable candidate", async () => {
  const { root, source } = await fixture("what-the-repo-pi-publish-uncertain-");
  const versions = new CommitThenThrowRegistry(join(root, "versions"));
  versions.failPublish = true;
  const evolution = runnerWithVersions(
    root,
    checks(),
    versions,
    editingSession("version: v1", "version: v2"),
  );
  const run = await evolution.run(task(root, source, "task-publish-uncertain"));

  await assert.rejects(
    () => evolution.approve(
      "task-publish-uncertain",
      review("task-publish-uncertain", run.ledger, run.candidate, "approve"),
    ),
    /response was lost/,
  );
  const store = new EvolutionStateStore(join(root, "state"));
  const ledger = await store.loadLedger("task-publish-uncertain");
  const bundle = await store.loadRecoveryBundle("task-publish-uncertain");
  const current = await versions.current("teaching");
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(ledger.operations.at(-1)?.status, "uncertain");
  assert.equal(ledger.steps.includes("recovery_bundle_saved"), true);
  assert.deepEqual(bundle.changedFiles, ["skill.md"]);
  assert.equal(bundle.artifacts[0]?.content, "version: v2\n");
  assert.equal(current?.currentVersion, run.candidate.candidateVersion);

  const recovered = await evolution.recover("task-publish-uncertain");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.equal(recovered.steps.includes("registry_publish_committed"), true);
  assert.match(recovered.error?.message ?? "", /publish was committed/);
  assert.equal((await versions.current("teaching"))?.revision, 2);
});

test("a rollback committed before transport failure leaves a recoverable candidate", async () => {
  const { root, source } = await fixture("what-the-repo-pi-rollback-uncertain-");
  const versions = new CommitThenThrowRegistry(join(root, "versions"));
  const evolution = runnerWithVersions(
    root,
    checks(),
    versions,
    editingSession("version: v1", "version: v2"),
  );
  const run = await evolution.run(task(root, source, "task-rollback-uncertain"));
  await evolution.approve(
    "task-rollback-uncertain",
    review("task-rollback-uncertain", run.ledger, run.candidate, "approve"),
  );
  versions.failRollback = true;

  await assert.rejects(
    () => evolution.rollback("task-rollback-uncertain", "1.0.0"),
    /response was lost/,
  );
  const store = new EvolutionStateStore(join(root, "state"));
  const ledger = await store.loadLedger("task-rollback-uncertain");
  const bundle = await store.loadRecoveryBundle("task-rollback-uncertain");
  const current = await versions.current("teaching");
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(ledger.operations.at(-1)?.status, "uncertain");
  assert.equal(ledger.steps.includes("recovery_bundle_saved"), true);
  assert.deepEqual(bundle.changedFiles, ["skill.md"]);
  assert.equal(current?.currentVersion, "1.0.0");
  assert.equal(current?.revision, 3);

  const recovered = await evolution.recover("task-rollback-uncertain");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.equal(recovered.steps.includes("registry_rollback_committed"), true);
  assert.match(recovered.error?.message ?? "", /rollback was committed/);
  assert.equal((await versions.current("teaching"))?.revision, 3);
});

test("timeout aborts Pi and leaves manual recovery instead of replaying writes", async () => {
  const { root, source } = await fixture("what-the-repo-pi-timeout-");
  let aborted = false;
  const hanging: PiSessionFactory = async ({ tools }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: interrupted",
      });
      return new Promise(() => {});
    },
    async abort() {
      aborted = true;
    },
  });
  const evolution = runner(root, checks(), hanging);
  const timed = task(root, source, "task-timeout");
  timed.maxTimeMs = 25;
  await assert.rejects(() => evolution.run(timed), /timed out/);
  assert.equal(aborted, true);
  const ledger = await new EvolutionStateStore(join(root, "state")).loadLedger("task-timeout");
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(ledger.operations.some((operation) => operation.status === "uncertain"), true);
  assert.equal(ledger.steps.includes("recovery_bundle_saved"), true);
  const store = new EvolutionStateStore(join(root, "state"));
  const bundle = await store.loadRecoveryBundle("task-timeout");
  assert.deepEqual(bundle.artifacts.map((artifact) => artifact.path), ["skill.md"]);
  assert.equal(bundle.artifacts[0]?.content, "version: interrupted\n");
  assert.match(bundle.diff, /version: interrupted/);
  assert.equal(ledger.recoveryBundleDigest, sha256(stableJson(bundle)));
  assert.equal(JSON.stringify(bundle).includes(root), false);
  assert.equal(await stat(join(root, "work", "task-timeout")).then(() => true, () => false), false);
});

test("runner rejects a final Pi report that exceeds the task budget", async () => {
  const { root, source } = await fixture("what-the-repo-pi-final-budget-");
  let aborted = false;
  const overBudget: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      return {
        sessionId,
        events: [],
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          cachedTokens: 100,
          cacheWriteTokens: 100,
          costUsd: 0.5,
        },
      };
    },
    async abort() {
      aborted = true;
    },
  });
  const evolution = runner(root, checks(), overBudget);
  const bounded = task(root, source, "task-final-budget");
  bounded.maxTokens = 10;

  await assert.rejects(() => evolution.run(bounded), /token budget exceeded/);
  const ledger = await new EvolutionStateStore(join(root, "state")).loadLedger("task-final-budget");
  assert.equal(ledger.piReport?.usage.inputTokens, 100);
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(ledger.steps.includes("recovery_bundle_saved"), true);
  assert.equal(aborted, true);
});

test("runner persists a preflight budget report and rejects an invalid Session report", async () => {
  const preflightFixture = await fixture("what-the-repo-pi-preflight-report-");
  let preflightReport: ReturnType<typeof report> | undefined;
  const preflightSession: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      preflightReport = report(sessionId, "budget_preflight");
      throw new PiBudgetPreflightError("preflight stopped the request", preflightReport);
    },
  });
  await assert.rejects(
    () => runner(preflightFixture.root, checks(), preflightSession).run(
      task(preflightFixture.root, preflightFixture.source, "task-preflight-report"),
    ),
    /preflight stopped/,
  );
  const preflightLedger = await new EvolutionStateStore(join(preflightFixture.root, "state"))
    .loadLedger("task-preflight-report");
  assert.deepEqual(preflightLedger.piReport, preflightReport);

  const invalidFixture = await fixture("what-the-repo-pi-invalid-report-");
  const invalidSession: PiSessionFactory = async ({ tools }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      return undefined as never;
    },
  });
  await assert.rejects(
    () => runner(invalidFixture.root, checks(), invalidSession).run(
      task(invalidFixture.root, invalidFixture.source, "task-invalid-report"),
    ),
    /invalid Pi session report/,
  );
  const invalidLedger = await new EvolutionStateStore(join(invalidFixture.root, "state"))
    .loadLedger("task-invalid-report");
  assert.equal(invalidLedger.status, "needs_manual_recovery");
  assert.equal(invalidLedger.steps.includes("recovery_bundle_saved"), true);
});

test("runner rejects mismatched Session IDs in normal and budget reports", async () => {
  const cases = [
    {
      name: "normal",
      factory: async ({ tools }: Parameters<PiSessionFactory>[0]) => ({
        async prompt() {
          await editForRecovery(tools);
          return report("wrong-session", "agent_end");
        },
      }),
    },
    {
      name: "preflight",
      factory: async ({ tools }: Parameters<PiSessionFactory>[0]) => ({
        async prompt() {
          await editForRecovery(tools);
          throw new PiBudgetPreflightError("preflight stopped", report("wrong-session", "budget_preflight"));
        },
      }),
    },
    {
      name: "exceeded",
      factory: async ({ tools }: Parameters<PiSessionFactory>[0]) => ({
        async prompt() {
          await editForRecovery(tools);
          throw new PiBudgetExceededError("budget exceeded", report("wrong-session", "budget_exceeded"));
        },
      }),
    },
  ] satisfies Array<{ name: string; factory: PiSessionFactory }>;

  for (const item of cases) {
    const current = await fixture(`what-the-repo-pi-session-id-${item.name}-`);
    const taskId = `task-session-id-${item.name}`;
    await assert.rejects(
      () => runner(current.root, checks(), item.factory).run(task(current.root, current.source, taskId)),
      /session ID does not match/,
    );
    const ledger = await new EvolutionStateStore(join(current.root, "state")).loadLedger(taskId);
    assert.equal(ledger.piReport, undefined);
    assert.equal(ledger.status, "needs_manual_recovery");
  }
});

test("large recovery artifacts remain complete while errors stay bounded and redacted", async () => {
  const { root, source } = await fixture("what-the-repo-pi-large-recovery-");
  const largeContent = `version: v2\n${"x".repeat(600 * 1024)}`;
  const secret = "sk-abcdefghijklmnop";
  const hostPath = "C:\\Users\\operator\\private\\credentials.txt";
  const failure = `${hostPath} Bearer abcdefghijklmnopqrstuvwxyz ${secret} ${"z".repeat(2 * 1024 * 1024)}`;
  const broken: PiSessionFactory = async ({ tools }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "write_candidate")?.execute({
        path: "skill.md",
        content: largeContent,
      });
      throw new Error(failure);
    },
  });
  const recoveryTask = task(root, source, "task-large-recovery");
  recoveryTask.maxCandidateBytes = 1024 * 1024;
  await assert.rejects(() => runner(root, checks(), broken).run(recoveryTask), /credentials|redacted-path/);

  const store = new EvolutionStateStore(join(root, "state"));
  const bundle = await store.loadRecoveryBundle("task-large-recovery");
  assert.equal(bundle.artifacts.length, 0);
  assert.equal(bundle.references.length, 1);
  assert.equal(await store.loadRecoveryObject("task-large-recovery", bundle.references[0]), largeContent);
  assert.equal(bundle.error.truncated, true);
  assert.equal(bundle.diffTruncated, true);
  assert.match(bundle.diffDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(bundle.diffDigest, sha256(bundle.diff));
  const recoveryPath = join(root, "state", "tasks", "task-large-recovery", "recovery.json");
  const recoveryText = await readFile(recoveryPath, "utf8");
  assert.ok((await stat(recoveryPath)).size < 700 * 1024);
  assert.equal(recoveryText.includes(hostPath), false);
  assert.equal(recoveryText.includes(secret), false);
  assert.equal(recoveryText.includes(root), false);
});

test("sandbox transport loss leaves the task in manual recovery", async () => {
  const { root, source } = await fixture("what-the-repo-pi-sandbox-loss-");
  const registry = new CheckRegistry(new FakeSandboxExecutor(async () => {
    throw new Error("sandbox transport disconnected");
  }), { allowTestPolicy: true });
  for (const id of ["pass", "fixed-eval"]) {
    registry.register({
      id,
      cwd: { kind: "workspace" },
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    });
  }
  const evolution = runner(root, registry, editingSession("version: v1", "version: v2"));

  await assert.rejects(
    () => evolution.run(task(root, source, "task-sandbox-loss")),
    /did not settle safely/,
  );
  const ledger = await new EvolutionStateStore(join(root, "state")).loadLedger("task-sandbox-loss");
  assert.equal(ledger.status, "needs_manual_recovery");
  assert.equal(
    ledger.operations.some((operation) => operation.kind === "check" && operation.status === "uncertain"),
    true,
  );
});

test("sandbox transport loss during fixed evaluation also requires manual recovery", async () => {
  const { root, source } = await fixture("what-the-repo-pi-eval-sandbox-loss-");
  const registry = new CheckRegistry(new FakeSandboxExecutor((request) => {
    if (request.definition.id === "fixed-eval") {
      throw new Error("fixed evaluation sandbox disconnected");
    }
    return isolatedExecution();
  }), { allowTestPolicy: true });
  for (const id of ["pass", "fixed-eval"]) {
    registry.register({
      id,
      cwd: { kind: "workspace" },
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    });
  }
  const evolution = runner(root, registry, editingSession("version: v1", "version: v2"));

  await assert.rejects(
    () => evolution.run(task(root, source, "task-eval-sandbox-loss")),
    /did not settle safely/,
  );
  const ledger = await new EvolutionStateStore(join(root, "state")).loadLedger("task-eval-sandbox-loss");
  const evaluation = ledger.operations.find((operation) =>
    operation.kind === "check" && operation.inputDigest !== undefined && operation.status === "uncertain");
  assert.ok(evaluation);
  assert.equal(ledger.status, "needs_manual_recovery");
});

test("recovery marks an interrupted side effect for manual audit", async () => {
  const { root, source } = await fixture("what-the-repo-pi-recover-");
  const store = new EvolutionStateStore(join(root, "state"));
  const interruptedTask = task(root, source, "task-recover");
  const createdAt = new Date().toISOString();
  await store.create(interruptedTask, {
    taskId: interruptedTask.taskId,
    taskDigest: "fixture-task-digest",
    status: "agent_running",
    createdAt,
    updatedAt: createdAt,
    steps: ["agent_running"],
    allowedTools: ["edit_candidate" as RestrictedToolName],
    operations: [{
      operationId: "operation-1",
      kind: "edit",
      status: "started",
      replay: "manual",
      inputDigest: "abc",
      startedAt: createdAt,
    }],
    checkResults: [],
    sideEffects: ["edit:skill.md"],
    compactionContext: "{}",
  });
  const recovered = await runner(root, checks()).recover("task-recover");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.equal(recovered.operations[0].status, "uncertain");
});

test("recovery quarantines a real residual workspace edit before candidate persistence", async () => {
  const { root, source } = await fixture("what-the-repo-pi-residual-workspace-");
  const store = new EvolutionStateStore(join(root, "state"));
  const interruptedTask = task(root, source, "task-residual-workspace");
  const createdAt = new Date().toISOString();
  await store.create(interruptedTask, {
    taskId: interruptedTask.taskId,
    taskDigest: sha256(stableJson(interruptedTask)),
    status: "agent_running",
    createdAt,
    updatedAt: createdAt,
    steps: ["workspace_prepared", "agent_running"],
    allowedTools: ["edit_candidate"],
    operations: [{
      operationId: "interrupted-edit",
      kind: "edit",
      status: "started",
      replay: "manual",
      inputDigest: sha256("skill.md"),
      startedAt: createdAt,
    }],
    checkResults: [],
    sideEffects: ["edit:skill.md"],
    compactionContext: "{}",
  });
  const binding = await new SkillVersionRegistry(join(root, "versions")).exportCurrent("teaching");
  const workspace = await EvolutionWorkspace.create(
    interruptedTask,
    binding.artifacts,
    join(root, "work"),
  );
  await workspace.editFile("skill.md", "version: v1", "version: hard-crash-edit");

  const recovered = await runner(root, checks()).recover(interruptedTask.taskId);
  const bundle = await store.loadRecoveryBundle(interruptedTask.taskId);
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.equal(recovered.steps.includes("recovery_bundle_saved"), true);
  assert.deepEqual(bundle.changedFiles, ["skill.md"]);
  assert.equal(bundle.artifacts[0]?.content, "version: hard-crash-edit\n");
  assert.match(bundle.diff, /hard-crash-edit/);
  assert.equal(
    await stat(join(root, "work", interruptedTask.taskId)).then(() => true, () => false),
    false,
  );
});

test("runner rejects oversized candidate explanations and Session trace floods", async () => {
  const explanationFixture = await fixture("what-the-repo-pi-explanation-budget-");
  const oversizedSubmission: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      await tools.find((tool) => tool.name === "submit_candidate")?.execute({
        summary: "s".repeat(16 * 1024 + 1),
        risks: [],
        unresolvedIssues: [],
      });
      return {
        sessionId,
        events: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
      };
    },
  });
  await assert.rejects(
    () => runner(explanationFixture.root, checks(), oversizedSubmission).run(
      task(explanationFixture.root, explanationFixture.source, "task-explanation-budget"),
    ),
    /summary exceeds its byte budget/,
  );

  const traceFixture = await fixture("what-the-repo-pi-trace-budget-");
  const traceFlood: PiSessionFactory = async ({ tools, sessionId }) => ({
    async prompt() {
      await tools.find((tool) => tool.name === "edit_candidate")?.execute({
        path: "skill.md",
        expected: "version: v1",
        replacement: "version: v2",
      });
      return {
        sessionId,
        events: Array.from({ length: 2_049 }, () => ({ eventType: "runtime_event" })),
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
      };
    },
  });
  await assert.rejects(
    () => runner(traceFixture.root, checks(), traceFlood).run(
      task(traceFixture.root, traceFixture.source, "task-trace-budget"),
    ),
    /event count budget exceeded/,
  );
});

test("recovery does not replay a durable review decision whose transition was interrupted", async () => {
  const { root, source } = await fixture("what-the-repo-pi-review-recover-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const { candidate, ledger } = await evolution.run(task(root, source, "task-review-recover"));
  const store = new EvolutionStateStore(join(root, "state"));
  await store.claimReviewDecision({
    taskId: "task-review-recover",
    reviewerId: "test-human-reviewer",
    decision: "approve",
    candidateDigest: ledger.candidateDigest ?? "",
    taskDigest: ledger.taskDigest,
    baseRevision: candidate.baseRevision,
    baseSnapshotDigest: candidate.baseSnapshotDigest,
    claimedAt: new Date().toISOString(),
  });

  const recovered = await evolution.recover("task-review-recover");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.match(recovered.error?.message ?? "", /durable review decision/);
  assert.equal((await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision, 1);
});

test("recovery settles an interrupted publish operation before inspecting its durable review", async () => {
  const { root, source } = await fixture("what-the-repo-pi-publish-recover-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const { candidate, ledger } = await evolution.run(task(root, source, "task-publish-recover"));
  const store = new EvolutionStateStore(join(root, "state"));
  await store.claimReviewDecision(review("task-publish-recover", ledger, candidate, "approve"));
  ledger.operations.push({
    operationId: "publish-operation-crash",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256("publish-input-digest"),
    startedAt: new Date().toISOString(),
  });
  await store.saveLedger(ledger);

  const recovered = await evolution.recover("task-publish-recover");
  const publish = recovered.operations.find((operation) => operation.operationId === "publish-operation-crash");
  assert.equal(publish?.status, "uncertain");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.match(recovered.error?.message ?? "", /publish was not committed/);
  assert.equal(recovered.steps.includes("registry_publish_not_committed"), true);
  assert.doesNotMatch(recovered.error?.message ?? "", /durable review decision/);
});

test("recovery quarantines an orphaned published version left before the manifest switch", async () => {
  const { root, source } = await fixture("what-the-repo-pi-publish-orphan-");
  const versions = new SkillVersionRegistry(join(root, "versions"));
  const checkRegistry = checks();
  const evolution = runnerWithVersions(
    root,
    checkRegistry,
    versions,
    editingSession("version: v1", "version: v2"),
  );
  const { candidate, ledger } = await evolution.run(task(root, source, "task-publish-orphan"));
  const store = new EvolutionStateStore(join(root, "state"));
  const decision = review("task-publish-orphan", ledger, candidate, "approve");
  await store.claimReviewDecision(decision);
  const manifestPath = join(root, "versions", "teaching", "current.json");
  const baseManifest = await readFile(manifestPath, "utf8");
  await versions.publish(
    candidate,
    ledger,
    decision,
    task(root, source, "task-publish-orphan"),
    checkRegistry,
  );
  await writeFile(manifestPath, baseManifest, "utf8");
  const lockPath = join(root, "versions", ".teaching.registry.lock");
  await writeFile(lockPath, `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  })}\n`, "utf8");
  ledger.operations.push({
    operationId: "publish-orphan-crash",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256(candidate.diffDigest),
    startedAt: new Date().toISOString(),
  });
  await store.saveLedger(ledger);

  const recovered = await evolution.recover(candidate.taskId);
  const quarantine = join(root, "versions", "teaching", ".recovery-quarantine");
  assert.equal(recovered.steps.includes("registry_publish_not_committed"), true);
  assert.equal(
    await stat(join(root, "versions", "teaching", candidate.candidateVersion)).then(() => true, () => false),
    false,
  );
  assert.equal((await readdir(quarantine)).length, 1);
  assert.equal(await stat(lockPath).then(() => true, () => false), false);
  assert.equal((await versions.current("teaching"))?.revision, 1);
});

test("registry recovery refuses a live lock and preserves contradictory state for audit", async () => {
  const live = await fixture("what-the-repo-pi-live-registry-lock-");
  const liveEvolution = runner(live.root, checks(), editingSession("version: v1", "version: v2"));
  const liveRun = await liveEvolution.run(task(live.root, live.source, "task-live-registry-lock"));
  const liveStore = new EvolutionStateStore(join(live.root, "state"));
  liveRun.ledger.operations.push({
    operationId: "publish-live-lock",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256(liveRun.candidate.diffDigest),
    startedAt: new Date().toISOString(),
  });
  await liveStore.saveLedger(liveRun.ledger);
  const liveLock = join(live.root, "versions", ".teaching.registry.lock");
  await writeFile(liveLock, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");

  const liveRecovered = await liveEvolution.recover(liveRun.candidate.taskId);
  assert.equal(liveRecovered.steps.includes("registry_recovery_failed"), true);
  assert.match(liveRecovered.error?.message ?? "", /still active/);
  assert.equal((await stat(liveLock)).isFile(), true);

  const conflict = await fixture("what-the-repo-pi-conflicting-registry-");
  const conflictEvolution = runner(
    conflict.root,
    checks(),
    editingSession("version: v1", "version: v2"),
  );
  const conflictRun = await conflictEvolution.run(
    task(conflict.root, conflict.source, "task-conflicting-registry"),
  );
  const conflictStore = new EvolutionStateStore(join(conflict.root, "state"));
  conflictRun.ledger.operations.push({
    operationId: "publish-conflicting-manifest",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256(conflictRun.candidate.diffDigest),
    startedAt: new Date().toISOString(),
  });
  await conflictStore.saveLedger(conflictRun.ledger);
  const conflictManifestPath = join(conflict.root, "versions", "teaching", "current.json");
  const conflictManifest = JSON.parse(await readFile(conflictManifestPath, "utf8")) as {
    currentVersion: string;
    revision: number;
    currentSnapshotDigest: string;
    history: Array<Record<string, unknown>>;
  };
  conflictManifest.currentVersion = "unexpected-version";
  conflictManifest.revision = 2;
  conflictManifest.history.push({
    revision: 2,
    version: "unexpected-version",
    snapshotDigest: conflictManifest.currentSnapshotDigest,
    taskId: "another-task",
    action: "rollback",
    at: new Date().toISOString(),
  });
  await writeFile(conflictManifestPath, `${JSON.stringify(conflictManifest, null, 2)}\n`, "utf8");
  const conflictLock = join(conflict.root, "versions", ".teaching.registry.lock");
  await writeFile(conflictLock, `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  })}\n`, "utf8");

  const conflictRecovered = await conflictEvolution.recover(conflictRun.candidate.taskId);
  assert.equal(conflictRecovered.steps.includes("registry_recovery_failed"), true);
  assert.match(conflictRecovered.error?.message ?? "", /neither side/);
  assert.equal(await stat(conflictLock).then(() => true, () => false), false);
  assert.equal(
    (await readdir(join(conflict.root, "versions"))).some((entry) => entry.endsWith(".stale-lock")),
    true,
  );

  await writeFile(conflictManifestPath, await readFile(
    join(conflict.root, "versions", "teaching", "current.json"),
    "utf8",
  ), "utf8");
  conflictManifest.currentVersion = "1.0.0";
  conflictManifest.revision = 1;
  conflictManifest.history = conflictManifest.history.slice(0, 1);
  await writeFile(conflictManifestPath, `${JSON.stringify(conflictManifest, null, 2)}\n`, "utf8");
  const retried = await conflictEvolution.recover(conflictRun.candidate.taskId);
  assert.equal(retried.steps.includes("registry_publish_not_committed"), true);
});

test("registry recovery leaves unrelated candidate staging entries in place", async () => {
  const { root, source } = await fixture("what-the-repo-pi-staging-owner-");
  const versions = new SkillVersionRegistry(join(root, "versions"));
  const evolution = runnerWithVersions(
    root,
    checks(),
    versions,
    editingSession("version: v1", "version: v2"),
  );
  const run = await evolution.run(task(root, source, "task-staging-owner"));
  const store = new EvolutionStateStore(join(root, "state"));
  const skillRoot = join(root, "versions", "teaching");
  const unrelated = join(skillRoot, ".candidate.11111111-1111-4111-8111-111111111111.staging");
  const unrelatedCandidate: SkillCandidate = {
    ...run.candidate,
    taskId: "different-task",
    candidateId: "different-task-candidate",
    status: "approved",
  };
  const unrelatedReview: ReviewDecision = {
    taskId: unrelatedCandidate.taskId,
    reviewerId: "test-human-reviewer",
    decision: "approve",
    candidateDigest: reviewedCandidateDigest(unrelatedCandidate),
    taskDigest: sha256("different-task"),
    baseRevision: unrelatedCandidate.baseRevision,
    baseSnapshotDigest: unrelatedCandidate.baseSnapshotDigest,
    claimedAt: new Date().toISOString(),
  };
  await mkdir(unrelated);
  await writeFile(
    join(unrelated, "candidate.json"),
    `${JSON.stringify(unrelatedCandidate, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(unrelated, "review.json"),
    `${JSON.stringify(unrelatedReview, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(unrelated, "skill.md"), "version: v2\n", "utf8");
  run.ledger.operations.push({
    operationId: "publish-unrelated-staging",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256(run.candidate.diffDigest),
    startedAt: new Date().toISOString(),
  });
  await store.saveLedger(run.ledger);

  const recovered = await evolution.recover(run.candidate.taskId);
  assert.equal(recovered.steps.includes("registry_publish_not_committed"), true);
  assert.equal((await stat(unrelated)).isDirectory(), true);
});

test("registry recovery leaves same-task staging with a different complete snapshot in place", async () => {
  const { root, source } = await fixture("what-the-repo-pi-staging-snapshot-");
  const versions = new SkillVersionRegistry(join(root, "versions"));
  const evolution = runnerWithVersions(
    root,
    checks(),
    versions,
    editingSession("version: v1", "version: v2"),
  );
  const run = await evolution.run(task(root, source, "task-staging-snapshot"));
  const store = new EvolutionStateStore(join(root, "state"));
  const skillRoot = join(root, "versions", "teaching");
  const staging = join(skillRoot, ".candidate.22222222-2222-4222-8222-222222222222.staging");
  const differentContent = "version: v3\n";
  const differentCandidate: SkillCandidate = {
    ...run.candidate,
    artifacts: [{
      path: "skill.md",
      content: differentContent,
      sha256: sha256(differentContent),
      bytes: Buffer.byteLength(differentContent, "utf8"),
    }],
    status: "approved",
  };
  const differentReview: ReviewDecision = {
    taskId: differentCandidate.taskId,
    reviewerId: "test-human-reviewer",
    decision: "approve",
    candidateDigest: reviewedCandidateDigest(differentCandidate),
    taskDigest: run.ledger.taskDigest,
    baseRevision: differentCandidate.baseRevision,
    baseSnapshotDigest: differentCandidate.baseSnapshotDigest,
    claimedAt: new Date().toISOString(),
  };
  await mkdir(staging);
  await writeFile(
    join(staging, "candidate.json"),
    `${JSON.stringify(differentCandidate, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(staging, "review.json"),
    `${JSON.stringify(differentReview, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(staging, "skill.md"), differentContent, "utf8");
  run.ledger.operations.push({
    operationId: "publish-different-snapshot-staging",
    kind: "publish",
    status: "started",
    replay: "never",
    inputDigest: sha256(run.candidate.diffDigest),
    startedAt: new Date().toISOString(),
  });
  await store.saveLedger(run.ledger);

  const expectedSnapshot = artifactSnapshotDigest(
    materializedCandidateArtifacts(run.candidate),
  );
  const stagedSnapshot = artifactSnapshotDigest(
    materializedCandidateArtifacts(differentCandidate),
  );
  assert.notEqual(stagedSnapshot, expectedSnapshot);
  const recovered = await evolution.recover(run.candidate.taskId);
  assert.equal(recovered.steps.includes("registry_publish_not_committed"), true);
  assert.equal((await stat(staging)).isDirectory(), true);
});

test("candidate versions stay unique across repeated equivalent diffs after rollback", async () => {
  const { root, source } = await fixture("what-the-repo-pi-version-identity-");
  const versions = new SkillVersionRegistry(join(root, "versions"));
  const firstTaskId = "task-collision-33284";
  const secondTaskId = "task-collision-42994";
  assert.equal(sha256(firstTaskId).slice(0, 8), sha256(secondTaskId).slice(0, 8));
  const firstRunner = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const first = await firstRunner.run(task(root, source, firstTaskId));
  await firstRunner.approve(
    first.candidate.taskId,
    review(first.candidate.taskId, first.ledger, first.candidate, "approve"),
  );
  await firstRunner.rollback(first.candidate.taskId, "1.0.0");

  const afterRollback = await versions.current("teaching");
  const historical = afterRollback?.history.find(
    (entry) => entry.version === first.candidate.candidateVersion,
  );
  assert.ok(historical);
  await assert.rejects(
    () => versions.recoverInterrupted("teaching", {
      taskId: secondTaskId,
      action: "publish",
      before: {
        version: "1.0.0",
        revision: 3,
        snapshotDigest: BASE_SNAPSHOT_DIGEST,
      },
      after: {
        version: first.candidate.candidateVersion,
        revision: 4,
        snapshotDigest: historical.snapshotDigest,
      },
    }),
    /already belongs to registry history/,
  );
  assert.equal(
    (await stat(join(root, "versions", "teaching", first.candidate.candidateVersion))).isDirectory(),
    true,
  );

  const secondRunner = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const second = await secondRunner.run(task(
    root,
    source,
    secondTaskId,
    "1.0.0",
    3,
    BASE_SNAPSHOT_DIGEST,
  ));
  assert.notEqual(first.candidate.candidateVersion, second.candidate.candidateVersion);
  const approvedSecond = await secondRunner.approve(
    second.candidate.taskId,
    review(second.candidate.taskId, second.ledger, second.candidate, "approve"),
  );
  const secondSnapshotDigest = artifactSnapshotDigest(
    materializedCandidateArtifacts(approvedSecond),
  );
  const recovered = await versions.recoverInterrupted("teaching", {
    taskId: secondTaskId,
    action: "publish",
    before: {
      version: "1.0.0",
      revision: 3,
      snapshotDigest: BASE_SNAPSHOT_DIGEST,
    },
    after: {
      version: approvedSecond.candidateVersion,
      revision: 4,
      snapshotDigest: secondSnapshotDigest,
    },
  });
  assert.equal(recovered.outcome, "committed");
  assert.equal((await versions.current("teaching"))?.currentVersion, approvedSecond.candidateVersion);
  assert.equal(
    (await stat(join(root, "versions", "teaching", first.candidate.candidateVersion))).isDirectory(),
    true,
  );
  assert.equal(
    (await stat(join(root, "versions", "teaching", approvedSecond.candidateVersion))).isDirectory(),
    true,
  );
});

test("candidate version identity stays bounded across long-base consecutive publications", async () => {
  const longBase = `v${"x".repeat(150)}`;
  const { root, source } = await fixture("what-the-repo-pi-version-bounded-", longBase);
  const firstRunner = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const first = await firstRunner.run(task(
    root,
    source,
    "task-bounded-first",
    longBase,
    1,
    BASE_SNAPSHOT_DIGEST,
  ));
  await firstRunner.approve(
    first.candidate.taskId,
    review(first.candidate.taskId, first.ledger, first.candidate, "approve"),
  );
  assert.match(first.candidate.candidateVersion, /^candidate\.r2\.[a-f0-9]{12}$/);
  assert.equal(first.candidate.candidateVersion.includes(longBase), false);
  const firstBinding = await new SkillVersionRegistry(join(root, "versions")).current(
    "teaching",
  );
  assert.ok(firstBinding);

  const secondRunner = runner(root, checks(), editingSession("version: v2", "version: v3"));
  const second = await secondRunner.run(task(
    root,
    source,
    "task-bounded-second",
    firstBinding.currentVersion,
    firstBinding.revision,
    firstBinding.currentSnapshotDigest,
  ));
  await secondRunner.approve(
    second.candidate.taskId,
    review(second.candidate.taskId, second.ledger, second.candidate, "approve"),
  );
  assert.match(second.candidate.candidateVersion, /^candidate\.r3\.[a-f0-9]{12}$/);
  assert.ok(second.candidate.candidateVersion.length < first.candidate.baseVersion.length);
});

test("runner workspace roots are trusted configuration and task JSON cannot override them", async () => {
  const { root, source } = await fixture("what-the-repo-pi-trusted-workspace-");
  const store = new EvolutionStateStore(join(root, "state"));
  const versions = new SkillVersionRegistry(join(root, "versions"));
  assert.throws(
    () => new PiEvolutionRunner({ checks: checks(), store, versions, workspaceRoot: store.root }),
    /overlaps protected product storage/,
  );
  assert.throws(
    () => new PiEvolutionRunner({
      checks: checks(),
      store,
      versions,
      workspaceRoot: join(root, "protected", "work"),
      forbiddenWorkspaceRoots: [join(root, "protected")],
    }),
    /overlaps protected product storage/,
  );

  const injected = {
    ...task(root, source, "task-injected-workspace"),
    workspaceRoot: join(root, "host-selected"),
  } as EvolutionTask;
  const createdAt = new Date().toISOString();
  await assert.rejects(
    () => new EvolutionStateStore(join(root, "injected-state")).create(injected, {
      taskId: injected.taskId,
      taskDigest: sha256(stableJson(injected)),
      status: "created",
      createdAt,
      updatedAt: createdAt,
      steps: [],
      allowedTools: [],
      operations: [],
      checkResults: [],
      sideEffects: [],
      compactionContext: "{}",
    }),
    /unexpected field workspaceRoot/,
  );
  assert.equal(await stat(join(root, "host-selected")).then(() => true, () => false), false);
});

test("runner rejects a workspace root redirected into protected storage", async (context) => {
  const { root } = await fixture("what-the-repo-pi-workspace-alias-");
  const store = new EvolutionStateStore(join(root, "state"));
  const versions = new SkillVersionRegistry(join(root, "versions"));
  const alias = join(root, "workspace-alias");
  try {
    await symlink(store.root, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("directory link creation is not enabled for this account");
      return;
    }
    throw error;
  }
  const evolution = new PiEvolutionRunner({ checks: checks(), store, versions, workspaceRoot: alias });
  await assert.rejects(
    () => evolution.run(task(root, "", "task-workspace-alias")),
    /redirected through a link|overlaps protected product storage/,
  );
  assert.equal(await stat(join(store.root, "task-workspace-alias")).then(() => true, () => false), false);
  await unlink(alias).catch(() => undefined);
});

test("a stale review lock is retained and moves the task to manual recovery", async () => {
  const { root, source } = await fixture("what-the-repo-pi-stale-review-lock-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const { candidate, ledger } = await evolution.run(task(root, source, "task-stale-review-lock"));
  const taskRoot = join(root, "state", "tasks", "task-stale-review-lock");
  const lockPath = join(taskRoot, ".review.lock");
  await writeFile(lockPath, "interrupted review\n", "utf8");
  const staleAt = new Date(Date.now() - 31 * 60_000);
  await utimes(lockPath, staleAt, staleAt);

  await assert.rejects(
    () => evolution.approve(
      "task-stale-review-lock",
      review("task-stale-review-lock", ledger, candidate, "approve"),
    ),
    /stale review lock requires manual recovery/,
  );
  const store = new EvolutionStateStore(join(root, "state"));
  const recovered = await store.loadLedger("task-stale-review-lock");
  assert.equal(recovered.status, "needs_manual_recovery");
  assert.equal(recovered.steps.includes("stale_review_lock_audit_required"), true);
  assert.equal((await stat(lockPath)).isFile(), true);
  assert.equal(await store.loadReviewDecision("task-stale-review-lock"), undefined);
  assert.equal((await new SkillVersionRegistry(join(root, "versions")).current("teaching"))?.revision, 1);
});

test("persisted state rejects malformed JSON and invalid runtime schemas", async () => {
  const { root, source } = await fixture("what-the-repo-pi-invalid-state-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  await evolution.run(task(root, source, "task-invalid-state"));
  const ledgerPath = join(root, "state", "tasks", "task-invalid-state", "ledger.json");
  await writeFile(ledgerPath, "{not-json", "utf8");
  await assert.rejects(
    () => new EvolutionStateStore(join(root, "state")).loadLedger("task-invalid-state"),
    /invalid persisted JSON/,
  );

  const traceFixture = await fixture("what-the-repo-pi-invalid-trace-");
  const traceRunner = runner(
    traceFixture.root,
    checks(),
    editingSession("version: v1", "version: v2"),
  );
  await traceRunner.run(task(traceFixture.root, traceFixture.source, "task-invalid-trace"));
  const traceLedgerPath = join(
    traceFixture.root,
    "state",
    "tasks",
    "task-invalid-trace",
    "ledger.json",
  );
  const traceLedger = JSON.parse(await readFile(traceLedgerPath, "utf8")) as {
    piReport: { events: unknown[] };
  };
  traceLedger.piReport.events = [{ eventType: "tool_end", isError: "false", elapsedMs: -1 }];
  await writeFile(traceLedgerPath, `${JSON.stringify(traceLedger, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => new EvolutionStateStore(join(traceFixture.root, "state")).loadLedger("task-invalid-trace"),
    /isError|non-negative/,
  );

  const identityFixture = await fixture("what-the-repo-pi-state-identity-");
  const identityRunner = runner(
    identityFixture.root,
    checks(),
    editingSession("version: v1", "version: v2"),
  );
  await identityRunner.run(task(identityFixture.root, identityFixture.source, "task-state-identity"));
  const identityLedgerPath = join(
    identityFixture.root,
    "state",
    "tasks",
    "task-state-identity",
    "ledger.json",
  );
  const identityLedger = JSON.parse(await readFile(identityLedgerPath, "utf8")) as Record<string, unknown>;
  identityLedger.taskId = "another-valid-task";
  await writeFile(identityLedgerPath, `${JSON.stringify(identityLedger, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => new EvolutionStateStore(join(identityFixture.root, "state")).loadLedger("task-state-identity"),
    /task ID does not match its task directory/,
  );

  const longTask = task(root, source, `t${"a".repeat(127)}`);
  const createdAt = new Date().toISOString();
  const secondStore = new EvolutionStateStore(join(root, "long-state"));
  await secondStore.create(longTask, {
    taskId: longTask.taskId,
    taskDigest: "digest",
    status: "created",
    createdAt,
    updatedAt: createdAt,
    steps: [],
    allowedTools: [],
    operations: [],
    checkResults: [],
    sideEffects: [],
    compactionContext: "{}",
  });
  assert.match((await secondStore.preparePiSession(longTask.taskId)).sessionId, /^evolution-[a-f0-9]{32}$/);
});

test("persisted state rejects unknown fields and oversized JSON before parsing", async () => {
  const { root, source } = await fixture("what-the-repo-pi-bounded-state-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  await evolution.run(task(root, source, "task-bounded-state"));
  const ledgerPath = join(root, "state", "tasks", "task-bounded-state", "ledger.json");
  const persisted = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
  persisted.unreviewed = { hidden: true };
  await writeFile(ledgerPath, `${JSON.stringify(persisted)}\n`, "utf8");
  await assert.rejects(
    () => new EvolutionStateStore(join(root, "state")).loadLedger("task-bounded-state"),
    /unexpected field unreviewed/,
  );

  await writeFile(ledgerPath, `{"padding":"${"x".repeat(8 * 1024 * 1024)}"}`, "utf8");
  await assert.rejects(
    () => new EvolutionStateStore(join(root, "state")).loadLedger("task-bounded-state"),
    /exceeds its byte budget/,
  );
});

test("published version JSON is validated before it can drive rollback or selection", async () => {
  const { root, source } = await fixture("what-the-repo-pi-version-schema-");
  const evolution = runner(root, checks(), editingSession("version: v1", "version: v2"));
  const run = await evolution.run(task(root, source, "task-version-schema"));
  await evolution.approve(
    "task-version-schema",
    review("task-version-schema", run.ledger, run.candidate, "approve"),
  );
  const registryRoot = join(root, "versions");
  const registry = new SkillVersionRegistry(registryRoot);
  const versionRoot = join(registryRoot, "teaching", run.candidate.candidateVersion);
  const candidatePath = join(versionRoot, "candidate.json");
  const reviewPath = join(versionRoot, "review.json");
  const manifestPath = join(registryRoot, "teaching", "current.json");
  const candidateText = await readFile(candidatePath, "utf8");
  const reviewText = await readFile(reviewPath, "utf8");
  const manifestText = await readFile(manifestPath, "utf8");
  const current = await registry.current("teaching");
  assert.ok(current);

  const storedCandidate = JSON.parse(candidateText) as Record<string, unknown>;
  storedCandidate.artifacts = "not-an-array";
  await writeFile(candidatePath, `${JSON.stringify(storedCandidate, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => registry.rollback(
      "teaching",
      "task-version-schema",
      run.candidate.candidateVersion,
      current?.revision ?? 0,
      current?.currentSnapshotDigest ?? "",
      run.candidate.candidateVersion,
    ),
    /candidate.artifacts/,
  );
  await writeFile(candidatePath, candidateText, "utf8");

  const storedReview = JSON.parse(reviewText) as Record<string, unknown>;
  storedReview.reviewerId = false;
  await writeFile(reviewPath, `${JSON.stringify(storedReview, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => registry.rollback(
      "teaching",
      "task-version-schema",
      run.candidate.candidateVersion,
      current?.revision ?? 0,
      current?.currentSnapshotDigest ?? "",
      run.candidate.candidateVersion,
    ),
    /decision.reviewerId/,
  );
  await writeFile(reviewPath, reviewText, "utf8");

  const manifest = JSON.parse(manifestText) as { history: Array<Record<string, unknown>> };
  manifest.history[0].action = "execute";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(() => registry.current("teaching"), /history\[0\]\.action/);
});
