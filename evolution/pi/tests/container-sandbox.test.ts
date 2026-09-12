import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainerSandboxExecutor,
  type ContainerSandboxExecutorOptions,
  type HostProcessRequest,
  type HostProcessResult,
  type HostProcessRunner,
} from "../src/container-sandbox.js";
import { CheckRegistry, SandboxExecutionUncertainError } from "../src/checks.js";
import type { SandboxCheckRequest } from "../src/contracts.js";
import { sha256 } from "../src/integrity.js";
import { TrustedIsolationPolicy } from "../src/isolation.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REFERENCE = `registry.example.invalid/what-the-repo/pi-checks@${IMAGE_DIGEST}`;
const DOCKER = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const DOCKER_CONFIG = await mkdtemp(join(tmpdir(), "what-the-repo-empty-docker-config-"));
const HOST_NODE = "C:\\trusted\\node.exe";

function runtimeProbe(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    uid: 65532,
    gid: 65532,
    noNewPrivileges: true,
    seccompMode: 2,
    effectiveCapabilities: "0000000000000000",
    boundingCapabilities: "0000000000000000",
    networkInterfaces: ["lo"],
    rootReadOnly: true,
    workspaceFilesystem: "tmpfs",
    workspaceBytes: 16 * 1024 * 1024,
    tempFilesystem: "tmpfs",
    tempBytes: 16 * 1024 * 1024,
    sharedMemoryFilesystem: "tmpfs",
    sharedMemoryBytes: 8 * 1024 * 1024,
    cgroupVersion: 2,
    memoryMaxBytes: 512 * 1024 * 1024,
    swapMaxBytes: 0,
    pidsMax: 128,
    cpuQuota: 100_000,
    cpuPeriod: 100_000,
    ...overrides,
  };
}

function successEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    exitCode: 0,
    timedOut: false,
    terminationReason: "exit",
    stdoutBase64: Buffer.from("ok", "utf8").toString("base64"),
    stderrBase64: "",
    runtimeProbe: runtimeProbe(),
    ...overrides,
  });
}

function daemonInspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    OSType: "linux",
    Architecture: "amd64",
    ServerVersion: "28.0.0",
    SecurityOptions: ["name=seccomp,profile=builtin"],
    MemoryLimit: true,
    SwapLimit: true,
    PidsLimit: true,
    CpuCfsQuota: true,
    ...overrides,
  });
}

function imageInspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Id: IMAGE_DIGEST,
    RepoDigests: [IMAGE_REFERENCE],
    Os: "linux",
    Architecture: "amd64",
    Config: { Volumes: null },
    ...overrides,
  });
}

class RecordingProcessRunner implements HostProcessRunner {
  readonly requests: HostProcessRequest[] = [];

  constructor(
    private readonly handler: (
      request: HostProcessRequest,
      signal?: AbortSignal,
    ) => HostProcessResult | Promise<HostProcessResult>,
  ) {}

  async run(request: HostProcessRequest, signal?: AbortSignal): Promise<HostProcessResult> {
    this.requests.push(structuredClone(request));
    return this.handler(request, signal);
  }
}

function processResult(stdout: string, exitCode = 0): HostProcessResult {
  return { exitCode, stdout, stderr: "", elapsedMs: 5 };
}

function checkRequest(overrides: Partial<SandboxCheckRequest> = {}): SandboxCheckRequest {
  const content = Buffer.from("safe\n", "utf8");
  return {
    definition: {
      id: "fixed-eval",
      cwd: { kind: "workspace" },
      argv: [HOST_NODE, "--test", "skill.test.mjs"],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      env: { FIXTURE: "safe" },
    },
    workspaceFiles: [{
      path: "skill.test.mjs",
      contentBase64: content.toString("base64"),
      sha256: sha256(content.toString("utf8")),
      bytes: content.length,
    }],
    scope: {
      allowedFiles: ["skill.test.mjs"],
      maxWorkspaceBytes: 1_024,
      maxFileCount: 1,
    },
    ...overrides,
  };
}

function executor(processRunner: HostProcessRunner): ContainerSandboxExecutor {
  return new ContainerSandboxExecutor({
    dockerExecutable: DOCKER,
    dockerConfigDirectory: DOCKER_CONFIG,
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    commands: [{ hostExecutable: HOST_NODE, containerExecutable: "/usr/local/bin/node" }],
    allowedEnvironmentKeys: ["FIXTURE"],
    processRunner,
  });
}

test("container sandbox sends only an input envelope and enforces hardened Docker flags", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "rm" || request.args[0] === "ps") return processResult("");
    assert.equal(request.args[0], "run");
    return processResult(successEnvelope());
  });
  const sandbox = executor(runner);
  const result = await sandbox.execute(checkRequest());
  assert.equal(result.stdout, "ok");
  assert.equal(result.isolation.trustDomain, "test");
  assert.equal(sandbox.isolationPolicy.trustDomain, "test");
  assert.equal(result.isolation.imageDigest, IMAGE_DIGEST);
  assert.equal(runner.requests.every((request) => request.env?.DOCKER_CONFIG === DOCKER_CONFIG), true);

  const run = runner.requests.find((request) => request.args[0] === "run");
  assert.ok(run);
  const args = run?.args ?? [];
  for (const expected of [
    "--interactive", "--pull", "never", "--network", "none", "--ipc", "private", "--cgroupns", "private",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--pids-limit", "128", "--memory", "536870912", "--memory-swap", "536870912",
    "--cpus", "1", "--shm-size", "8388608", "--user", "65532:65532", "--log-driver", "none",
  ]) {
    assert.ok(args.includes(expected), `missing Docker argument ${expected}`);
  }
  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("-v"), false);
  assert.equal(args.includes("--env"), false);
  assert.equal(args.includes("-e"), false);
  assert.equal(args.includes("--privileged"), false);
  assert.equal(args.includes("--device"), false);
  assert.equal(args.includes("--pid"), false);
  assert.equal(args.includes("seccomp=unconfined"), false);
  assert.equal(args.at(-3), "/usr/local/bin/node");
  assert.equal(args.at(-2), IMAGE_REFERENCE);
  assert.equal(args.at(-1), "/opt/what-the-repo/sandbox-entry.mjs");

  const payload = JSON.parse(run?.stdin ?? "") as {
    definition: { argv: string[]; cwd: string; env: Record<string, string> };
    workspaceFiles: Array<{ path: string; contentBase64: string }>;
  };
  assert.deepEqual(payload.definition.argv, ["/usr/local/bin/node", "--test", "skill.test.mjs"]);
  assert.equal(payload.definition.cwd, "/workspace");
  assert.deepEqual(payload.definition.env, { FIXTURE: "safe" });
  assert.equal(payload.workspaceFiles[0]?.path, "skill.test.mjs");
  assert.equal(Buffer.from(payload.workspaceFiles[0]?.contentBase64 ?? "", "base64").toString("utf8"), "safe\n");
  assert.doesNotMatch(run?.stdin ?? "", /G:\\|C:\\trusted/);
  assert.deepEqual(
    runner.requests.slice(-2).map((request) => request.args[0]),
    ["rm", "ps"],
  );
});

test("container sandbox accepts an immutable local image ID", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") {
      return processResult(imageInspection({ Id: IMAGE_DIGEST, RepoDigests: [] }));
    }
    if (request.args[0] === "rm" || request.args[0] === "ps") return processResult("");
    return processResult(successEnvelope());
  });
  const sandbox = new ContainerSandboxExecutor({
    dockerExecutable: DOCKER,
    dockerConfigDirectory: DOCKER_CONFIG,
    imageReference: IMAGE_DIGEST,
    imageDigest: IMAGE_DIGEST,
    commands: [{ hostExecutable: HOST_NODE, containerExecutable: "/usr/local/bin/node" }],
    allowedEnvironmentKeys: ["FIXTURE"],
    processRunner: runner,
  });

  const result = await sandbox.execute(checkRequest());

  assert.equal(result.exitCode, 0);
  const run = runner.requests.find((request) => request.args[0] === "run");
  assert.ok(run?.args.includes(IMAGE_DIGEST));
});

test("container sandbox fails closed before run when Docker isolation features are unavailable", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection({ PidsLimit: false }));
    throw new Error("container run should not be reached");
  });
  await assert.rejects(
    () => executor(runner).execute(checkRequest()),
    /cannot prove the required sandbox isolation features/,
  );
  assert.deepEqual(runner.requests.map((request) => request.args[0]), ["info"]);
});

test("container sandbox fails closed when the local image digest or declared volumes differ", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") {
      return processResult(imageInspection({
        Id: `sha256:${"b".repeat(64)}`,
        RepoDigests: [],
        Config: { Volumes: { "/host-leak": {} } },
      }));
    }
    throw new Error("container run should not be reached");
  });
  await assert.rejects(
    () => executor(runner).execute(checkRequest()),
    /does not match the trusted pinned image policy/,
  );
  assert.deepEqual(runner.requests.map((request) => request.args[0]), ["info", "image"]);
});

test("container sandbox refuses Docker configuration that could load credentials or plugins", async () => {
  const dockerConfig = await mkdtemp(join(tmpdir(), "what-the-repo-nonempty-docker-config-"));
  await writeFile(join(dockerConfig, "config.json"), "{}\n", "utf8");
  const runner = new RecordingProcessRunner(() => {
    throw new Error("Docker must not start with an untrusted config directory");
  });
  const sandbox = new ContainerSandboxExecutor({
    dockerExecutable: DOCKER,
    dockerConfigDirectory: dockerConfig,
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    commands: [{ hostExecutable: HOST_NODE, containerExecutable: "/usr/local/bin/node" }],
    processRunner: runner,
  });
  await assert.rejects(
    () => sandbox.execute(checkRequest()),
    /must be an empty non-linked directory/,
  );
  assert.equal(runner.requests.length, 0);
});

test("container sandbox refuses unmapped commands and fixed working directories", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    throw new Error("container run should not be reached");
  });
  const unmappedCommand = checkRequest();
  unmappedCommand.definition.argv[0] = "C:\\untrusted\\python.exe";
  await assert.rejects(
    () => executor(runner).execute(unmappedCommand),
    /executable is not mapped/,
  );

  const unmappedCwd = checkRequest();
  unmappedCwd.definition.cwd = { kind: "fixed", path: "C:\\trusted\\fixtures" };
  await assert.rejects(
    () => executor(runner).execute(unmappedCwd),
    /working directory is not mapped/,
  );
});

test("container sandbox aborts and force-removes a possibly running container", async () => {
  let runStarted = false;
  let removalAttempts = 0;
  const runner = new RecordingProcessRunner((request, signal) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "rm") {
      removalAttempts += 1;
      return processResult("", removalAttempts === 1 ? 1 : 0);
    }
    if (request.args[0] === "ps") return processResult("");
    runStarted = true;
    return new Promise<HostProcessResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
        once: true,
      });
    });
  });
  const controller = new AbortController();
  const execution = executor(runner).execute(checkRequest(), controller.signal);
  while (!runStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(() => execution, /aborted/);
  assert.equal(removalAttempts, 2);
  const removals = runner.requests.filter((request) => request.args[0] === "rm");
  assert.equal(removals.every((request) => request.args[1] === "--force"), true);
  const proof = runner.requests.find((request) => request.args[0] === "ps");
  assert.deepEqual(proof?.args.slice(0, 4), ["ps", "--all", "--quiet", "--filter"]);
  assert.match(proof?.args[4] ?? "", /^name=\^\/what-the-repo-[a-f0-9-]+\$$/);
});

test("container cleanup uncertainty propagates through the check registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-container-uncertain-"));
  await writeFile(join(root, "skill.test.mjs"), "export {};\n", "utf8");
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "run") throw new Error("Docker run state was lost");
    if (request.args[0] === "rm") return processResult("container is still stopping", 1);
    if (request.args[0] === "ps") return processResult("what-the-repo-still-running");
    throw new Error(`unexpected Docker command: ${request.args[0]}`);
  });
  const registry = new CheckRegistry(executor(runner), { allowTestPolicy: true });
  registry.register(checkRequest().definition);

  await assert.rejects(
    () => registry.run("fixed-eval", root, {
      allowedFiles: ["skill.test.mjs"],
      maxWorkspaceBytes: 1_024,
    }),
    (error: unknown) => error instanceof SandboxExecutionUncertainError &&
      /did not settle safely/.test(error.message),
  );
  assert.deepEqual(
    runner.requests.slice(-2).map((request) => request.args[0]),
    ["rm", "ps"],
  );
});

test("container sandbox rejects malformed or oversized result envelopes", async () => {
  const outputs = [
    JSON.stringify({ schemaVersion: 1, exitCode: 0, timedOut: false, terminationReason: "exit", stdoutBase64: "!", stderrBase64: "" }),
    successEnvelope({ stdoutBase64: Buffer.alloc(2_000).toString("base64") }),
  ];
  for (const output of outputs) {
    const runner = new RecordingProcessRunner((request) => {
      if (request.args[0] === "info") return processResult(daemonInspection());
      if (request.args[0] === "image") return processResult(imageInspection());
      if (request.args[0] === "rm") return processResult("");
      if (request.args[0] === "ps") return processResult("");
      return processResult(output);
    });
    await assert.rejects(
      () => executor(runner).execute(checkRequest()),
      /invalid result envelope|invalid stdout|exceeded the registered output budget/,
    );
  }
});

test("container sandbox refuses environment keys that were not explicitly approved", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    throw new Error("container run should not be reached");
  });
  const request = checkRequest();
  request.definition.env = { OPENAI_API_KEY: "must-not-enter-sandbox" };
  await assert.rejects(
    () => executor(runner).execute(request),
    /environment is not allowed/,
  );
});

test("container runtime probes must match the configured isolation limits", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "rm" || request.args[0] === "ps") return processResult("");
    return processResult(successEnvelope({ runtimeProbe: runtimeProbe({ networkInterfaces: ["eth0", "lo"] }) }));
  });
  const sandbox = executor(runner);
  const execution = await sandbox.execute(checkRequest());
  assert.throws(
    () => new TrustedIsolationPolicy(sandbox.isolationPolicy, { allowTestPolicy: true })
      .assertAttestation(execution.isolation),
    /trusted isolation policy/,
  );
});

test("container sandbox reads an injected process runner only once", () => {
  let reads = 0;
  const injected: HostProcessRunner = {
    async run() {
      throw new Error("an injected runner must not inherit production trust");
    },
  };
  const options: ContainerSandboxExecutorOptions = {
    dockerExecutable: DOCKER,
    dockerConfigDirectory: DOCKER_CONFIG,
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    commands: [{ hostExecutable: HOST_NODE, containerExecutable: "/usr/local/bin/node" }],
  };
  Object.defineProperty(options, "processRunner", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? undefined : injected;
    },
  });

  const sandbox = new ContainerSandboxExecutor(options);
  assert.equal(reads, 1);
  assert.equal(sandbox.isolationPolicy.trustDomain, "production");
  assert.notEqual(
    (sandbox as unknown as { processRunner: HostProcessRunner }).processRunner,
    injected,
  );
});

test("container sandbox ignores a runtime process runner shadow property", async () => {
  const trustedRunner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "rm" || request.args[0] === "ps") return processResult("");
    return processResult(successEnvelope());
  });
  const sandbox = executor(trustedRunner);
  const shadowRunner = new RecordingProcessRunner(() => {
    throw new Error("shadow process runner must not execute");
  });
  Object.defineProperty(sandbox, "processRunner", {
    configurable: true,
    value: shadowRunner,
  });

  const execution = await sandbox.execute(checkRequest());
  assert.equal(execution.exitCode, 0);
  assert.equal(trustedRunner.requests.length, 5);
  assert.equal(shadowRunner.requests.length, 0);
});

test("check registry captures the authenticated container execution closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-container-captured-execute-"));
  await writeFile(join(root, "skill.test.mjs"), "export {};\n", "utf8");
  const trustedRunner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") return processResult(daemonInspection());
    if (request.args[0] === "image") return processResult(imageInspection());
    if (request.args[0] === "rm" || request.args[0] === "ps") return processResult("");
    return processResult(successEnvelope());
  });
  const sandbox = executor(trustedRunner);
  const registry = new CheckRegistry(sandbox, { allowTestPolicy: true });
  registry.register(checkRequest().definition);
  Object.defineProperty(sandbox, "execute", {
    configurable: true,
    value: async () => {
      throw new Error("shadow execute must not run");
    },
  });

  const result = await registry.run("fixed-eval", root, {
    allowedFiles: ["skill.test.mjs"],
    maxWorkspaceBytes: 1_024,
  });
  assert.equal(result.passed, true);
  assert.equal(trustedRunner.requests.length, 5);
});

test("container sandbox refuses root user or group identities", () => {
  for (const runAsUser of ["0:0", "65532:0", "0:65532"]) {
    assert.throws(
      () => new ContainerSandboxExecutor({
        dockerExecutable: DOCKER,
        dockerConfigDirectory: DOCKER_CONFIG,
        imageReference: IMAGE_REFERENCE,
        imageDigest: IMAGE_DIGEST,
        runAsUser,
        commands: [{ hostExecutable: HOST_NODE, containerExecutable: "/usr/local/bin/node" }],
        processRunner: new RecordingProcessRunner(() => processResult("")),
      }),
      /invalid sandbox container identity/,
    );
  }
});

test("container sandbox requires Docker to attest the builtin seccomp profile", async () => {
  const runner = new RecordingProcessRunner((request) => {
    if (request.args[0] === "info") {
      return processResult(daemonInspection({ SecurityOptions: ["name=seccomp"] }));
    }
    throw new Error("image inspection and container run must not be reached");
  });
  await assert.rejects(
    () => executor(runner).execute(checkRequest()),
    /cannot prove the required sandbox isolation features/,
  );
});
