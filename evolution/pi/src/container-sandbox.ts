import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  IsolationRuntimeProbe,
  IsolationPolicy,
  SandboxCheckExecution,
  SandboxCheckExecutor,
  SandboxCheckRequest,
} from "./contracts.js";
import { sha256, stableJson } from "./integrity.js";
import { isolationPolicyDigest, sandboxRequestDigest } from "./isolation.js";

const NAMED_IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/:@-]{0,510}@sha256:[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_CONTAINER_PATH = /^\/[A-Za-z0-9._/+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/;
const MAX_DOCKER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 6 * 1024 * 1024;

export interface HostProcessRequest {
  executable: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface HostProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export interface HostProcessRunner {
  run(request: HostProcessRequest, signal?: AbortSignal): Promise<HostProcessResult>;
}

export interface ContainerCommandMapping {
  hostExecutable: string;
  containerExecutable: string;
}

export interface ContainerWorkingDirectoryMapping {
  hostPath: string;
  containerPath: string;
}

export interface ContainerSandboxExecutorOptions {
  dockerExecutable: string;
  dockerConfigDirectory: string;
  imageReference: string;
  imageDigest: string;
  platform?: "linux/amd64" | "linux/arm64";
  runAsUser?: string;
  entrypoint?: string;
  policyId?: string;
  cpuCount?: number;
  memoryBytes?: number;
  pidsLimit?: number;
  workspaceBytes?: number;
  tempBytes?: number;
  sharedMemoryBytes?: number;
  startupGraceMs?: number;
  abortGraceMs?: number;
  commands: ContainerCommandMapping[];
  fixedWorkingDirectories?: ContainerWorkingDirectoryMapping[];
  allowedEnvironmentKeys?: string[];
  processRunner?: HostProcessRunner;
}

interface SandboxEnvelope {
  schemaVersion: 1;
  exitCode: number | null;
  timedOut: boolean;
  terminationReason: "exit" | "timeout" | "output_limit";
  stdoutBase64: string;
  stderrBase64: string;
  runtimeProbe: SandboxCheckExecution["isolation"]["runtimeProbe"];
}

interface DockerImageInspection {
  Id?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Volumes?: unknown } | null;
}

interface DockerDaemonInspection {
  OSType?: unknown;
  Architecture?: unknown;
  ServerVersion?: unknown;
  SecurityOptions?: unknown;
  MemoryLimit?: unknown;
  SwapLimit?: unknown;
  PidsLimit?: unknown;
  CpuCfsQuota?: unknown;
}

interface ParsedSandboxExecution {
  exitCode: number | null;
  timedOut: boolean;
  terminationReason: "exit" | "timeout" | "output_limit";
  stdout: string;
  stderr: string;
  runtimeProbe: IsolationRuntimeProbe;
}

interface TrustedContainerSandboxBinding {
  isolationPolicy: IsolationPolicy;
  startupGraceMs: number;
  abortGraceMs: number;
  execute(
    request: SandboxCheckRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCheckExecution>;
}

const TRUSTED_CONTAINER_SANDBOXES = new WeakMap<
  ContainerSandboxExecutor,
  TrustedContainerSandboxBinding
>();

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function boundedBytes(value: string, maximum: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} exceeded byte limit`);
}

export class NodeHostProcessRunner implements HostProcessRunner {
  async run(request: HostProcessRequest, signal?: AbortSignal): Promise<HostProcessResult> {
    if (signal?.aborted) throw abortError("host process was aborted before start");
    const started = Date.now();
    return new Promise<HostProcessResult>((resolve, reject) => {
      let settled = false;
      let failure: Error | undefined;
      let timer: NodeJS.Timeout | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(request.executable, request.args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: request.env ?? {},
      });

      const stop = (error: Error): void => {
        if (failure) return;
        failure = error;
        child.kill("SIGKILL");
      };
      const onAbort = (): void => stop(abortError("host process was aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => stop(new Error("host process timed out")), request.timeoutMs);

      const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
        if (failure) return;
        if (stream === "stdout") stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
          stop(new Error("host process output exceeded byte limit"));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
      child.once("error", (error) => {
        failure = error;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          elapsedMs: Date.now() - started,
        });
      });
      child.stdin.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
      });
      child.stdin.end(request.stdin ?? "");
    });
  }
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string") throw new Error(`sandbox returned invalid ${label}`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`sandbox returned invalid ${label}`);
  return decoded;
}

function parseEnvelope(value: string, maxOutputBytes: number): ParsedSandboxExecution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("sandbox returned an invalid result envelope");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sandbox returned an invalid result envelope");
  }
  const row = parsed as Partial<SandboxEnvelope>;
  if (row.schemaVersion !== 1 ||
    (row.exitCode !== null && !Number.isSafeInteger(row.exitCode)) ||
    typeof row.timedOut !== "boolean" ||
    (row.terminationReason !== "exit" && row.terminationReason !== "timeout" &&
      row.terminationReason !== "output_limit") ||
    (row.timedOut !== (row.terminationReason === "timeout")) ||
    (row.terminationReason !== "exit" && row.exitCode !== null) || !row.runtimeProbe) {
    throw new Error("sandbox returned an invalid result envelope");
  }
  const stdout = canonicalBase64(row.stdoutBase64, "stdout");
  const stderr = canonicalBase64(row.stderrBase64, "stderr");
  if (stdout.length + stderr.length > maxOutputBytes) {
    throw new Error("sandbox result exceeded the registered output budget");
  }
  return {
    exitCode: row.exitCode ?? null,
    timedOut: row.timedOut,
    terminationReason: row.terminationReason,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    runtimeProbe: row.runtimeProbe,
  };
}

export class ContainerSandboxExecutor implements SandboxCheckExecutor {
  readonly #isolationPolicy: IsolationPolicy;
  readonly #startupGraceMs: number;
  readonly #abortGraceMs: number;
  readonly #processRunner: HostProcessRunner;
  readonly #commandMap: Map<string, string>;
  readonly #cwdMap: Map<string, string>;
  readonly #dockerExecutable: string;
  readonly #dockerConfigDirectory: string;
  readonly #imageReference: string;
  readonly #entrypoint: string;
  readonly #hostEnvironment: Record<string, string>;
  readonly #allowedEnvironmentKeys: Set<string>;
  #dockerConfigIdentity = "";

  constructor(options: ContainerSandboxExecutorOptions) {
    const processRunner = options.processRunner;
    if (!isAbsolute(options.dockerExecutable) || options.dockerExecutable.includes("\0")) {
      throw new Error("Docker executable must be an absolute trusted path");
    }
    if (!isAbsolute(options.dockerConfigDirectory) || options.dockerConfigDirectory.includes("\0")) {
      throw new Error("Docker config directory must be an absolute isolated path");
    }
    const imageReferenceIsDigest = options.imageReference === options.imageDigest;
    const imageReferenceIsNamedDigest = NAMED_IMAGE_REFERENCE.test(options.imageReference) &&
      options.imageReference.endsWith(`@${options.imageDigest}`);
    if ((!imageReferenceIsDigest && !imageReferenceIsNamedDigest) ||
      !IMAGE_DIGEST.test(options.imageDigest)) {
      throw new Error("sandbox image must be pinned to the configured digest");
    }
    const platform = options.platform ?? "linux/amd64";
    const runAsUser = options.runAsUser ?? "65532:65532";
    const entrypoint = options.entrypoint ?? "/opt/what-the-repo/sandbox-entry.mjs";
    if (runAsUser !== "65532:65532" || !SAFE_CONTAINER_PATH.test(entrypoint)) {
      throw new Error("invalid sandbox container identity or entrypoint");
    }
    const cpuCount = options.cpuCount ?? 1;
    const memoryBytes = options.memoryBytes ?? 512 * 1024 * 1024;
    const pidsLimit = options.pidsLimit ?? 128;
    const workspaceBytes = options.workspaceBytes ?? 16 * 1024 * 1024;
    const tempBytes = options.tempBytes ?? 16 * 1024 * 1024;
    const sharedMemoryBytes = options.sharedMemoryBytes ?? 8 * 1024 * 1024;
    this.#startupGraceMs = options.startupGraceMs ?? 15_000;
    this.#abortGraceMs = options.abortGraceMs ?? 5_000;
    this.#commandMap = new Map();
    for (const mapping of options.commands ?? []) {
      if (!isAbsolute(mapping.hostExecutable) || !SAFE_CONTAINER_PATH.test(mapping.containerExecutable) ||
        this.#commandMap.has(mapping.hostExecutable)) {
        throw new Error("invalid or duplicate sandbox command mapping");
      }
      this.#commandMap.set(mapping.hostExecutable, mapping.containerExecutable);
    }
    if (this.#commandMap.size === 0) throw new Error("at least one sandbox command mapping is required");
    this.#cwdMap = new Map();
    for (const mapping of options.fixedWorkingDirectories ?? []) {
      if (!isAbsolute(mapping.hostPath) || !SAFE_CONTAINER_PATH.test(mapping.containerPath) ||
        this.#cwdMap.has(mapping.hostPath)) {
        throw new Error("invalid or duplicate sandbox working directory mapping");
      }
      this.#cwdMap.set(mapping.hostPath, mapping.containerPath);
    }
    this.#allowedEnvironmentKeys = new Set();
    for (const key of options.allowedEnvironmentKeys ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || this.#allowedEnvironmentKeys.has(key)) {
        throw new Error("invalid or duplicate sandbox environment key");
      }
      this.#allowedEnvironmentKeys.add(key);
    }
    const trustDomain = processRunner ? "test" : "production";
    const normalizedConfig = {
      protocolVersion: 1,
      trustDomain,
      dockerExecutable: options.dockerExecutable,
      dockerConfigDirectory: options.dockerConfigDirectory,
      imageReference: options.imageReference,
      imageDigest: options.imageDigest,
      platform,
      runAsUser,
      entrypoint,
      commands: [...this.#commandMap].sort(([left], [right]) => left.localeCompare(right)),
      fixedWorkingDirectories: [...this.#cwdMap].sort(([left], [right]) => left.localeCompare(right)),
      allowedEnvironmentKeys: [...this.#allowedEnvironmentKeys].sort(),
      resourceLimits: {
        cpuCount,
        memoryBytes,
        pidsLimit,
        workspaceBytes,
        tempBytes,
        sharedMemoryBytes,
      },
    };
    const executorConfigDigest = sha256(stableJson(normalizedConfig));
    this.#isolationPolicy = {
      schemaVersion: 1,
      policyId: options.policyId ?? "pi-check-container-v1",
      trustDomain,
      provider: "docker",
      runtime: "docker-cli-v1",
      executorConfigDigest,
      imageDigest: options.imageDigest,
      platform,
      runAsUser,
      network: "disabled",
      ipcNamespace: "private",
      cgroupNamespace: "private",
      hostFilesystem: "unavailable",
      rootFilesystem: "read-only",
      workspaceFilesystem: "tmpfs",
      capabilities: "dropped",
      noNewPrivileges: true,
      seccompProfile: "builtin",
      resourceLimits: {
        cpuCount,
        memoryBytes,
        pidsLimit,
        workspaceBytes,
        tempBytes,
        sharedMemoryBytes,
      },
    };
    this.#processRunner = processRunner ?? new NodeHostProcessRunner();
    this.#dockerExecutable = options.dockerExecutable;
    this.#dockerConfigDirectory = resolve(options.dockerConfigDirectory);
    this.#imageReference = options.imageReference;
    this.#entrypoint = entrypoint;
    this.#hostEnvironment = Object.fromEntries(
      ["SystemRoot", "WINDIR"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
    );
    this.#hostEnvironment.DOCKER_CONFIG = this.#dockerConfigDirectory;
    TRUSTED_CONTAINER_SANDBOXES.set(this, {
      isolationPolicy: structuredClone(this.#isolationPolicy),
      startupGraceMs: this.#startupGraceMs,
      abortGraceMs: this.#abortGraceMs,
      execute: (request, signal) => this.#executeTrusted(request, signal),
    });
  }

  get isolationPolicy(): IsolationPolicy {
    return structuredClone(this.#isolationPolicy);
  }

  get startupGraceMs(): number {
    return this.#startupGraceMs;
  }

  get abortGraceMs(): number {
    return this.#abortGraceMs;
  }

  async #inspectDockerConfig(): Promise<void> {
    const metadata = await lstat(this.#dockerConfigDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      resolve(await realpath(this.#dockerConfigDirectory)) !== this.#dockerConfigDirectory ||
      (await readdir(this.#dockerConfigDirectory)).length !== 0) {
      throw new Error("Docker config directory must be an empty non-linked directory");
    }
    this.#dockerConfigIdentity = `${metadata.dev}:${metadata.ino}:${metadata.mode}`;
  }

  async #assertDockerConfigUnchanged(): Promise<void> {
    const metadata = await lstat(this.#dockerConfigDirectory);
    const identity = `${metadata.dev}:${metadata.ino}:${metadata.mode}`;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      resolve(await realpath(this.#dockerConfigDirectory)) !== this.#dockerConfigDirectory ||
      identity !== this.#dockerConfigIdentity ||
      (await readdir(this.#dockerConfigDirectory)).length !== 0) {
      throw new Error("Docker config directory changed during sandbox execution");
    }
  }

  async #inspectRuntime(signal?: AbortSignal): Promise<void> {
    const result = await this.#processRunner.run({
      executable: this.#dockerExecutable,
      args: ["info", "--format", "{{json .}}"],
      env: this.#hostEnvironment,
      timeoutMs: this.#startupGraceMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    }, signal);
    if (result.exitCode !== 0) throw new Error("Docker sandbox runtime is unavailable");
    let inspection: DockerDaemonInspection;
    try {
      inspection = JSON.parse(result.stdout) as DockerDaemonInspection;
    } catch {
      throw new Error("Docker returned invalid runtime inspection data");
    }
    const expectedPlatform = this.#isolationPolicy.platform.split("/");
    const securityOptions = Array.isArray(inspection.SecurityOptions) ? inspection.SecurityOptions : [];
    const architectures = expectedPlatform[1] === "amd64" ? new Set(["amd64", "x86_64"]) :
      new Set(["arm64", "aarch64"]);
    if (inspection.OSType !== expectedPlatform[0] ||
      typeof inspection.Architecture !== "string" || !architectures.has(inspection.Architecture) ||
      typeof inspection.ServerVersion !== "string" || inspection.ServerVersion.length === 0 ||
      !securityOptions.some((value) => value === "name=seccomp,profile=builtin") ||
      inspection.MemoryLimit !== true || inspection.SwapLimit !== true ||
      inspection.PidsLimit !== true || inspection.CpuCfsQuota !== true) {
      throw new Error("Docker runtime cannot prove the required sandbox isolation features");
    }
  }

  async #inspectImage(signal?: AbortSignal): Promise<void> {
    const result = await this.#processRunner.run({
      executable: this.#dockerExecutable,
      args: ["image", "inspect", "--format", "{{json .}}", this.#imageReference],
      env: this.#hostEnvironment,
      timeoutMs: this.#startupGraceMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    }, signal);
    if (result.exitCode !== 0) throw new Error("pinned sandbox image is unavailable locally");
    let inspection: DockerImageInspection;
    try {
      inspection = JSON.parse(result.stdout) as DockerImageInspection;
    } catch {
      throw new Error("Docker returned invalid image inspection data");
    }
    const expectedPlatform = this.#isolationPolicy.platform.split("/");
    const repoDigests = Array.isArray(inspection.RepoDigests) ? inspection.RepoDigests : [];
    const pinnedImageMatches = this.#imageReference === this.#isolationPolicy.imageDigest
      ? inspection.Id === this.#isolationPolicy.imageDigest
      : repoDigests.includes(this.#imageReference);
    if (!pinnedImageMatches ||
      inspection.Os !== expectedPlatform[0] || inspection.Architecture !== expectedPlatform[1] ||
      (inspection.Config?.Volumes && Object.keys(inspection.Config.Volumes as object).length > 0)) {
      throw new Error("local sandbox image does not match the trusted pinned image policy");
    }
  }

  #translatedRequest(request: SandboxCheckRequest): Record<string, unknown> {
    const executable = this.#commandMap.get(request.definition.argv[0]);
    if (!executable) throw new Error("check executable is not mapped into the sandbox image");
    const cwd = request.definition.cwd.kind === "workspace"
      ? "/workspace"
      : this.#cwdMap.get(request.definition.cwd.path);
    if (!cwd) throw new Error("fixed check working directory is not mapped into the sandbox image");
    if (request.scope.maxWorkspaceBytes > this.#isolationPolicy.resourceLimits.workspaceBytes) {
      throw new Error("check workspace budget exceeds the sandbox tmpfs limit");
    }
    const env = request.definition.env ?? {};
    if (Object.keys(env).some((key) => !this.#allowedEnvironmentKeys.has(key))) {
      throw new Error("check environment is not allowed in the sandbox");
    }
    return {
      schemaVersion: 1,
      definition: {
        id: request.definition.id,
        argv: [executable, ...request.definition.argv.slice(1)],
        cwd,
        env,
        timeoutMs: request.definition.timeoutMs,
        maxOutputBytes: request.definition.maxOutputBytes,
      },
      workspaceFiles: request.workspaceFiles,
      scope: request.scope,
    };
  }

  #dockerArgs(sandboxId: string): string[] {
    const limits = this.#isolationPolicy.resourceLimits;
    const [uid, gid] = this.#isolationPolicy.runAsUser.split(":");
    const tmpfs = (path: string, bytes: number): string =>
      `${path}:rw,noexec,nosuid,nodev,size=${bytes},mode=0700,uid=${uid},gid=${gid}`;
    return [
      "run",
      "--interactive",
      "--rm",
      "--name", sandboxId,
      "--pull", "never",
      "--platform", this.#isolationPolicy.platform,
      "--network", "none",
      "--dns", "127.0.0.1",
      "--hostname", "what-the-repo-sandbox",
      "--ipc", "private",
      "--cgroupns", "private",
      "--read-only",
      "--tmpfs", tmpfs("/workspace", limits.workspaceBytes),
      "--tmpfs", tmpfs("/tmp", limits.tempBytes),
      "--shm-size", String(limits.sharedMemoryBytes),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges=true",
      "--pids-limit", String(limits.pidsLimit),
      "--memory", String(limits.memoryBytes),
      "--memory-swap", String(limits.memoryBytes),
      "--cpus", String(limits.cpuCount),
      "--ulimit", `nofile=256:256`,
      "--user", this.#isolationPolicy.runAsUser,
      "--workdir", "/workspace",
      "--log-driver", "none",
      "--entrypoint", "/usr/local/bin/node",
      this.#imageReference,
      this.#entrypoint,
    ];
  }

  async #requestContainerRemoval(sandboxId: string): Promise<void> {
    await this.#assertDockerConfigUnchanged();
    await this.#processRunner.run({
      executable: this.#dockerExecutable,
      args: ["rm", "--force", sandboxId],
      env: this.#hostEnvironment,
      timeoutMs: this.#abortGraceMs,
      maxOutputBytes: 64 * 1024,
    });
  }

  async #proveContainerRemoved(sandboxId: string): Promise<void> {
    await this.#requestContainerRemoval(sandboxId).catch(() => undefined);
    await this.#assertDockerConfigUnchanged();
    const result = await this.#processRunner.run({
      executable: this.#dockerExecutable,
      args: [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `name=^/${sandboxId}$`,
      ],
      env: this.#hostEnvironment,
      timeoutMs: this.#abortGraceMs,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0 || result.stdout.trim().length !== 0) {
      throw new Error(`sandbox container removal could not be proven: ${sandboxId}`);
    }
  }

  async execute(request: SandboxCheckRequest, signal?: AbortSignal): Promise<SandboxCheckExecution> {
    return this.#executeTrusted(request, signal);
  }

  async #executeTrusted(request: SandboxCheckRequest, signal?: AbortSignal): Promise<SandboxCheckExecution> {
    if (signal?.aborted) throw abortError("sandbox execution was aborted before start");
    await this.#inspectDockerConfig();
    await this.#inspectRuntime(signal);
    await this.#inspectImage(signal);
    const requestDigest = sandboxRequestDigest(request);
    const payload = stableJson(this.#translatedRequest(request));
    boundedBytes(payload, MAX_INPUT_BYTES, "sandbox request");
    const sandboxId = `what-the-repo-${randomUUID()}`;
    let immediateCleanup: Promise<void> | undefined;
    const onAbort = (): void => {
      immediateCleanup ??= this.#requestContainerRemoval(sandboxId).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let execution: SandboxCheckExecution | undefined;
    let executionFailed = false;
    let executionError: unknown;
    try {
      await this.#assertDockerConfigUnchanged();
      const result = await this.#processRunner.run({
        executable: this.#dockerExecutable,
        args: this.#dockerArgs(sandboxId),
        stdin: payload,
        env: this.#hostEnvironment,
        timeoutMs: request.definition.timeoutMs + this.#startupGraceMs,
        maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
      }, signal);
      if (signal?.aborted) throw abortError("sandbox execution was aborted");
      if (result.exitCode !== 0) throw new Error("sandbox container did not return a valid check result");
      const envelope = parseEnvelope(result.stdout, request.definition.maxOutputBytes);
      const { runtimeProbe, ...processResult } = envelope;
      execution = {
        ...processResult,
        elapsedMs: result.elapsedMs,
        isolation: {
          schemaVersion: 1,
          trustDomain: this.#isolationPolicy.trustDomain,
          provider: this.#isolationPolicy.provider,
          runtime: this.#isolationPolicy.runtime,
          sandboxId,
          policyDigest: isolationPolicyDigest(this.#isolationPolicy),
          executorConfigDigest: this.#isolationPolicy.executorConfigDigest,
          runtimeProbeDigest: sha256(stableJson(runtimeProbe)),
          requestDigest,
          imageDigest: this.#isolationPolicy.imageDigest,
          platform: this.#isolationPolicy.platform,
          runAsUser: this.#isolationPolicy.runAsUser,
          network: "disabled",
          ipcNamespace: "private",
          cgroupNamespace: "private",
          hostFilesystem: "unavailable",
          rootFilesystem: "read-only",
          workspaceFilesystem: "tmpfs",
          capabilities: "dropped",
          noNewPrivileges: true,
          seccompProfile: "builtin",
          resourceLimits: {
            ...this.#isolationPolicy.resourceLimits,
            timeoutMs: request.definition.timeoutMs,
          },
          runtimeProbe,
        },
      };
    } catch (error) {
      executionFailed = true;
      executionError = error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await immediateCleanup;
    }
    try {
      await this.#proveContainerRemoved(sandboxId);
    } catch (cleanupError) {
      if (executionFailed) {
        throw new AggregateError(
          [executionError, cleanupError],
          `sandbox execution failed and container removal could not be proven: ${sandboxId}`,
        );
      }
      throw cleanupError;
    }
    if (executionFailed) throw executionError;
    if (!execution) throw new Error("sandbox execution did not produce a result");
    return execution;
  }
}

export function captureTrustedContainerSandboxExecutor(
  executor: unknown,
): TrustedContainerSandboxBinding | undefined {
  if (!executor || typeof executor !== "object") return undefined;
  const binding = TRUSTED_CONTAINER_SANDBOXES.get(executor as ContainerSandboxExecutor);
  if (!binding) return undefined;
  return {
    isolationPolicy: structuredClone(binding.isolationPolicy),
    startupGraceMs: binding.startupGraceMs,
    abortGraceMs: binding.abortGraceMs,
    execute: binding.execute,
  };
}
