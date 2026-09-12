import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertTrustedPublicationResult, CheckRegistry } from "../src/checks.js";
import { ContainerSandboxExecutor } from "../src/container-sandbox.js";
import type {
  CandidateArtifact,
  CheckDefinition,
  EvolutionTask,
  SandboxCheckExecutor,
  SkillCandidate,
} from "../src/contracts.js";
import { reviewedCandidateDigest, sha256, stableJson } from "../src/integrity.js";
import { EvolutionWorkspace, WorkspaceSecurityError } from "../src/safe-workspace.js";
import { artifactSnapshotDigest, SkillVersionRegistry } from "../src/versions.js";
import {
  FakeSandboxExecutor,
  isolatedExecution,
  TEST_ISOLATION_POLICY,
} from "./fake-sandbox.js";
import { checkDefinitionDigest } from "../src/isolation.js";

const FIXED_EVAL_DEFINITION: CheckDefinition = {
  id: "fixed-eval",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

const REQUIRED_DEFINITION: CheckDefinition = {
  id: "required",
  cwd: { kind: "workspace" },
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

function artifact(path: string, content: string): CandidateArtifact {
  return { path, content, sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") };
}

function task(root: string, whitelist = ["skill.md"]): EvolutionTask {
  const baseArtifacts = [artifact("skill.md", "safe")];
  return {
    taskId: "security-task",
    trigger: "eval",
    failureEvidence: ["fixture"],
    skillId: "skill",
    baseSkillVersion: "1.0.0",
    baseRevision: 1,
    baseSnapshotDigest: artifactSnapshotDigest(baseArtifacts),
    whitelist,
    checkIds: ["required"],
    checkDefinitionDigests: {
      required: checkDefinitionDigest(REQUIRED_DEFINITION, TEST_ISOLATION_POLICY),
    },
    evaluation: {
      checkId: "fixed-eval",
      suiteId: "security-fixture",
      datasetVersion: "v1",
      definitionDigest: checkDefinitionDigest(FIXED_EVAL_DEFINITION, TEST_ISOLATION_POLICY),
      metrics: { score: { direction: "higher", maxRegression: 0 } },
    },
    maxSteps: 3,
    maxTimeMs: 1_000,
    maxTokens: 10_000,
    maxCostUsd: 1,
  };
}

test("workspace permits only regular whitelisted files and exact edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-secure-"));
  const workspace = await EvolutionWorkspace.create(
    task(root),
    [artifact("skill.md", "same same"), artifact("private.md", "not projected")],
    join(root, "work"),
  );
  assert.equal(await workspace.readFile("skill.md"), "same same");
  await assert.rejects(() => workspace.writeFile("other.md", "x"), WorkspaceSecurityError);
  await assert.rejects(() => workspace.readFile("../private.md"), WorkspaceSecurityError);
  await assert.rejects(() => workspace.editFile("skill.md", "same", "new"), /ambiguous/);
  await workspace.cleanup();
});

test("workspace projects only the task whitelist from a complete trusted snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-projection-"));
  const outside = join(root, "caller-selected-source");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "skill.md"), "untrusted caller content", "utf8");
  const workspace = await EvolutionWorkspace.create(
    task(root),
    [artifact("skill.md", "trusted registry content"), artifact("other.md", "kept outside Pi")],
    join(root, "work"),
  );

  assert.equal(await workspace.readFile("skill.md"), "trusted registry content");
  assert.equal(await readFile(join(workspace.root, "other.md"), "utf8").catch(() => undefined), undefined);
  assert.equal(await readFile(join(outside, "skill.md"), "utf8"), "untrusted caller content");
  await workspace.cleanup();
});

test("workspace recovery rejects entries outside the exact whitelist tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-reopen-tree-"));
  const evolutionTask = task(root);
  const artifacts = [artifact("skill.md", "safe")];
  const workspace = await EvolutionWorkspace.create(evolutionTask, artifacts, join(root, "work"));
  await writeFile(join(workspace.root, "unexpected.md"), "untrusted", "utf8");
  await assert.rejects(
    () => EvolutionWorkspace.reopen(evolutionTask, artifacts, join(root, "work")),
    /unexpected entry/,
  );
  await workspace.cleanup();
});

test("candidate paths reject Windows device names and alternate data streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-portable-path-"));
  await assert.rejects(
    () => EvolutionWorkspace.create(
      task(root, ["skill.md:secret"]),
      [artifact("skill.md", "safe")],
      join(root, "work"),
    ),
    /safe portable relative path/,
  );
  const reserved = task(root);
  reserved.taskId = "CON";
  await assert.rejects(
    () => EvolutionWorkspace.create(reserved, [artifact("skill.md", "safe")], join(root, "work")),
    /invalid task id/,
  );
});

test("workspace rejects tampered or incomplete registry artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-registry-integrity-"));
  const tampered = artifact("skill.md", "safe");
  tampered.sha256 = sha256("different");
  await assert.rejects(
    () => EvolutionWorkspace.create(task(root), [tampered], join(root, "work")),
    /integrity validation/,
  );
  await assert.rejects(
    () => EvolutionWorkspace.create(task(root), [artifact("other.md", "safe")], join(root, "work")),
    /whitelist is not present/,
  );
});

test("check registry rejects unknown IDs and records sandbox timeouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-check-secure-"));
  await writeFile(join(root, "skill.md"), "safe", "utf8");
  const executor = new FakeSandboxExecutor(() => isolatedExecution({
    exitCode: null,
    timedOut: true,
    elapsedMs: 20,
  }));
  const registry = new CheckRegistry(executor, { allowTestPolicy: true });
  registry.register({
    id: "slow",
    cwd: { kind: "fixed", path: root },
    argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    timeoutMs: 20,
    maxOutputBytes: 100,
  });
  await assert.rejects(
    () => registry.run("unknown", root, { allowedFiles: ["skill.md"], maxWorkspaceBytes: 100 }),
    /unknown check id/,
  );
  const result = await registry.run("slow", root, {
    allowedFiles: ["skill.md"],
    maxWorkspaceBytes: 100,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.passed, false);
  assert.equal(executor.requests.length, 1);
  assert.deepEqual(executor.requests[0].workspaceFiles.map((file) => file.path), ["skill.md"]);
});

test("host timeout aborts a sandbox executor that never settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-check-host-timeout-"));
  await writeFile(join(root, "skill.md"), "safe", "utf8");
  let aborted = false;
  const executor = new FakeSandboxExecutor((_request, signal) => new Promise((_resolve) => {
    signal?.addEventListener("abort", () => {
      aborted = true;
    }, { once: true });
  }));
  const registry = new CheckRegistry(executor, { allowTestPolicy: true });
  registry.register({
    id: "lost-sandbox",
    cwd: { kind: "workspace" },
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 20,
    maxOutputBytes: 100,
  });

  await assert.rejects(
    () => registry.run("lost-sandbox", root, {
      allowedFiles: ["skill.md"],
      maxWorkspaceBytes: 100,
    }),
    /did not settle safely/,
  );
  assert.equal(aborted, true);
});

test("check registry requires an absolute executable path", () => {
  const registry = new CheckRegistry(new FakeSandboxExecutor(), { allowTestPolicy: true });
  assert.throws(() => registry.register({
    id: "hijack",
    cwd: { kind: "workspace" },
    argv: ["node", "-e", "process.exit(0)"],
    timeoutMs: 100,
    maxOutputBytes: 100,
  }), /invalid check definition/);
});

test("check output budget applies across stdout and stderr bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-check-output-"));
  await writeFile(join(root, "skill.md"), "safe", "utf8");
  const registry = new CheckRegistry(new FakeSandboxExecutor(() => isolatedExecution({
    stdout: "\u754c\u{1F642}".repeat(100),
    stderr: "\u6D4B\u{1F6A6}".repeat(100),
  })), { allowTestPolicy: true });
  registry.register({
    id: "bounded-output",
    cwd: { kind: "fixed", path: root },
    argv: [process.execPath, "-e", "process.stdout.write('界'.repeat(100));process.stderr.write('界'.repeat(100))"],
    timeoutMs: 1_000,
    maxOutputBytes: 17,
  });
  const result = await registry.run("bounded-output", root, {
    allowedFiles: ["skill.md"],
    maxWorkspaceBytes: 100,
  });
  assert.ok(Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") <= 17);
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.stderr.includes("\uFFFD"), false);
});

test("check results persist bounded text while digesting the complete output", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-check-persistence-"));
  await writeFile(join(root, "skill.md"), "safe", "utf8");
  const completeOutput = "0123456789abcdef".repeat(2_048);
  const registry = new CheckRegistry(new FakeSandboxExecutor(() => isolatedExecution({
    stdout: completeOutput,
  })), { allowTestPolicy: true });
  registry.register({
    id: "large-output",
    cwd: { kind: "workspace" },
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 1_000,
    maxOutputBytes: 64 * 1024,
  });

  const first = await registry.run("large-output", root, {
    allowedFiles: ["skill.md"],
    maxWorkspaceBytes: 100,
  });
  const second = await registry.run("large-output", root, {
    allowedFiles: ["skill.md"],
    maxWorkspaceBytes: 100,
  });

  assert.equal(Buffer.byteLength(first.stdout, "utf8"), 16 * 1024);
  assert.equal(first.stderr, "");
  assert.equal(first.outputBytes, Buffer.byteLength(completeOutput, "utf8"));
  assert.equal(first.outputTruncated, true);
  assert.equal(first.outputDigest, sha256(`${completeOutput}\0`));
  assert.equal(second.outputDigest, first.outputDigest);
});

test("check registry fails closed when isolation cannot be attested", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-check-attestation-"));
  await writeFile(join(root, "skill.md"), "safe", "utf8");
  const providerMismatch = isolatedExecution();
  providerMismatch.isolation.provider = "unsafe-test-double";
  const registry = new CheckRegistry(
    new FakeSandboxExecutor(() => providerMismatch),
    { allowTestPolicy: true },
  );
  registry.register({
    id: "attested",
    cwd: { kind: "fixed", path: root },
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 1_000,
    maxOutputBytes: 100,
  });
  const unsafeExecutor = new FakeSandboxExecutor();
  Object.defineProperty(unsafeExecutor, "execute", {
    value: async () => ({
      ...isolatedExecution(),
      isolation: {
        ...isolatedExecution().isolation,
        hostFilesystem: "mounted",
      },
    }),
  });
  const unsafeRegistry = new CheckRegistry(unsafeExecutor, { allowTestPolicy: true });
  unsafeRegistry.register({
    id: "attested",
    cwd: { kind: "fixed", path: root },
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 1_000,
    maxOutputBytes: 100,
  });
  await assert.rejects(
    () => unsafeRegistry.run("attested", root, { allowedFiles: ["skill.md"], maxWorkspaceBytes: 100 }),
    /trusted isolation policy/,
  );
  await assert.rejects(
    () => registry.run("attested", root, { allowedFiles: ["skill.md"], maxWorkspaceBytes: 100 }),
    /trusted isolation policy/,
  );
});

test("test sandbox policies require an explicit test-only opt in", () => {
  assert.throws(
    () => new CheckRegistry(new FakeSandboxExecutor()),
    /invalid or untrusted sandbox isolation policy/,
  );
});

test("check registry requires an external sandbox executor", () => {
  assert.throws(
    () => new CheckRegistry(undefined as unknown as SandboxCheckExecutor),
    /external sandbox check executor is required/,
  );
});

test("a forged container sandbox prototype cannot register a production policy", () => {
  const forged = Object.create(ContainerSandboxExecutor.prototype) as SandboxCheckExecutor;
  Object.defineProperties(forged, {
    isolationPolicy: {
      value: { ...TEST_ISOLATION_POLICY, trustDomain: "production" },
    },
    startupGraceMs: { value: 0 },
    abortGraceMs: { value: 50 },
    execute: { value: async () => isolatedExecution() },
  });

  assert.throws(
    () => new CheckRegistry(forged),
    /production checks require the built-in container sandbox executor/,
  );
});

test("publication evidence cannot be replayed across candidate snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-attestation-replay-"));
  await writeFile(join(root, "skill.md"), "candidate one", "utf8");
  const registry = new CheckRegistry(new FakeSandboxExecutor(), { allowTestPolicy: true });
  registry.register(REQUIRED_DEFINITION);
  const scope = { allowedFiles: ["skill.md"], maxWorkspaceBytes: 1_024 };
  const result = await registry.run("required", root, scope);
  Object.defineProperties(registry, {
    assertTrustedIsolation: { value: () => undefined },
    assertTrustedResultForArtifacts: { value: () => undefined },
  });

  assert.throws(
    () => assertTrustedPublicationResult(
      registry,
      result,
      [artifact("skill.md", "candidate two")],
      scope,
    ),
    /trusted isolation policy/,
  );
});

test("a forged check registry prototype cannot authorize publication", () => {
  const forged = Object.create(CheckRegistry.prototype) as CheckRegistry;
  assert.throws(
    () => assertTrustedPublicationResult(
      forged,
      {
        checkId: "required",
        definitionDigest: checkDefinitionDigest(REQUIRED_DEFINITION, TEST_ISOLATION_POLICY),
        isolation: isolatedExecution().isolation,
      },
      [artifact("skill.md", "safe")],
      { allowedFiles: ["skill.md"], maxWorkspaceBytes: 1_024 },
    ),
    /publication requires the built-in trusted check registry/,
  );
});

test("version registry refuses a skill directory symlink", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-version-link-"));
  const versions = join(root, "versions");
  const outside = join(root, "outside");
  await mkdir(versions, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(versions, "skill"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows symlink creation is not enabled for this account");
      return;
    }
    throw error;
  }
  const { SkillVersionRegistry } = await import("../src/versions.js");
  await assert.rejects(
    () => new SkillVersionRegistry(versions).bootstrap(
      "skill",
      "1.0.0",
      "fixture-bootstrap",
      [artifact("skill.md", "base")],
    ),
    /escapes registry root/,
  );
  assert.equal(await readFile(join(outside, "skill.md"), "utf8").catch(() => undefined), undefined);
});

test("version registry current refuses a skill directory link to the registry parent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-version-read-link-"));
  const versions = join(root, "versions");
  await mkdir(versions, { recursive: true });
  await writeFile(join(root, "current.json"), `${JSON.stringify({
    skillId: "skill",
    currentVersion: "1.0.0",
    history: [{
      version: "1.0.0",
      taskId: "outside-task",
      action: "publish",
      at: new Date().toISOString(),
    }],
  }, null, 2)}\n`, "utf8");
  try {
    await symlink(root, join(versions, "skill"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("directory link creation is not enabled for this account");
      return;
    }
    throw error;
  }

  const { SkillVersionRegistry } = await import("../src/versions.js");
  await assert.rejects(
    () => new SkillVersionRegistry(versions).current("skill"),
    /escapes registry root|redirected through a link/,
  );
});

test("version registry reports a missing manifest as corruption after bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-version-manifest-"));
  const versions = join(root, "versions");
  const registry = new SkillVersionRegistry(versions);
  await registry.bootstrap(
    "skill",
    "1.0.0",
    "manifest-bootstrap",
    [artifact("skill.md", "safe")],
  );
  await unlink(join(versions, "skill", "current.json"));

  await assert.rejects(() => registry.current("skill"), /ENOENT/);
  await assert.rejects(() => registry.exportCurrent("skill"), /ENOENT/);
});
