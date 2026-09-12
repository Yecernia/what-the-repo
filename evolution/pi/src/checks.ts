import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type {
  CandidateArtifact,
  CheckDefinition,
  CheckResult,
  SandboxCheckExecutor,
  SandboxCheckExecution,
  SandboxFile,
} from "./contracts.js";
import { captureTrustedContainerSandboxExecutor } from "./container-sandbox.js";
import {
  checkDefinitionDigest,
  sandboxRequestDigest,
  TrustedIsolationPolicy,
} from "./isolation.js";
import { MAX_CHECK_RESULT_TEXT_BYTES } from "./limits.js";
import { portableRelativePath } from "./path-safety.js";

export class SandboxExecutionUncertainError extends Error {
  override readonly name = "SandboxExecutionUncertainError";
}

const MAX_CHECK_TIMEOUT_MS = 30 * 60_000;
const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;
const MAX_SANDBOX_WORKSPACE_BYTES = 5 * 1024 * 1024;
const MAX_SANDBOX_FILE_COUNT = 64;
const MAX_ARG_COUNT = 128;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_ENV_COUNT = 64;
const MAX_ENV_VALUE_BYTES = 8 * 1024;
const MAX_ENV_BYTES = 64 * 1024;
const MAX_EXECUTOR_GRACE_MS = 60_000;

interface CheckRegistryState {
  definitions: Map<string, CheckDefinition>;
  isolationPolicy: IsolationPolicySnapshot;
  isolationPolicyDigest: string;
  assertAttestation(
    attestation: CheckResult["isolation"],
    expected?: { requestDigest?: string; timeoutMs?: number },
  ): void;
  execute(
    request: Parameters<SandboxCheckExecutor["execute"]>[0],
    signal?: AbortSignal,
  ): Promise<SandboxCheckExecution>;
  startupGraceMs: number;
  abortGraceMs: number;
}

type IsolationPolicySnapshot = TrustedIsolationPolicy["policy"];

const REGISTRY_STATES = new WeakMap<CheckRegistry, CheckRegistryState>();

function registryState(registry: CheckRegistry): CheckRegistryState {
  const state = REGISTRY_STATES.get(registry);
  if (!state) throw new Error("publication requires the built-in trusted check registry");
  return state;
}

function portableAbsolute(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function validEnvironment(env: Record<string, string> | undefined): boolean {
  if (!env) return true;
  const entries = Object.entries(env);
  return entries.length <= MAX_ENV_COUNT && entries.every(
    ([key, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) &&
      typeof value === "string" &&
      !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= MAX_ENV_VALUE_BYTES,
  ) && entries.reduce(
    (total, [key, value]) => total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
    0,
  ) <= MAX_ENV_BYTES;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function normalizedScope(
  scope: { allowedFiles: string[]; maxWorkspaceBytes: number },
): { allowedFiles: string[]; maxWorkspaceBytes: number } {
  if (!scope || !Array.isArray(scope.allowedFiles) ||
    scope.allowedFiles.length < 1 || scope.allowedFiles.length > MAX_SANDBOX_FILE_COUNT ||
    !positiveInteger(scope.maxWorkspaceBytes, MAX_SANDBOX_WORKSPACE_BYTES)) {
    throw new Error("invalid sandbox check scope");
  }
  const allowedFiles = scope.allowedFiles.map((path) => {
    if (typeof path !== "string") throw new Error("invalid sandbox check scope");
    return portableRelativePath(path);
  });
  if (new Set(allowedFiles).size !== allowedFiles.length) {
    throw new Error("invalid sandbox check scope");
  }
  return { allowedFiles, maxWorkspaceBytes: scope.maxWorkspaceBytes };
}

function validateExecution(value: unknown): SandboxCheckExecution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sandbox execution returned an invalid result");
  }
  const execution = value as Record<string, unknown>;
  if (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) {
    throw new Error("sandbox execution returned an invalid exit code");
  }
  if (typeof execution.timedOut !== "boolean" ||
    (execution.terminationReason !== "exit" && execution.terminationReason !== "timeout" &&
      execution.terminationReason !== "output_limit") ||
    typeof execution.stdout !== "string" || typeof execution.stderr !== "string" ||
    typeof execution.elapsedMs !== "number" || !Number.isFinite(execution.elapsedMs) || execution.elapsedMs < 0) {
    throw new Error("sandbox execution returned invalid process fields");
  }
  const isolation = execution.isolation;
  if (isolation === null || typeof isolation !== "object" || Array.isArray(isolation)) {
    throw new Error("sandbox execution did not attest required isolation");
  }
  return value as SandboxCheckExecution;
}

async function workspaceFiles(root: string, allowedFiles: string[], maxWorkspaceBytes: number): Promise<SandboxFile[]> {
  const resolvedRoot = await realpath(resolve(root));
  const files: SandboxFile[] = [];
  let totalBytes = 0;
  for (const raw of allowedFiles) {
    const portable = portableRelativePath(raw);
    const path = resolve(resolvedRoot, portable);
    const rel = relative(resolvedRoot, path);
    if (rel.startsWith("..") || portableAbsolute(rel)) throw new Error("workspace path escapes the sandbox upload root");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("sandbox input is not a regular file");
    const actual = await realpath(path);
    const actualRel = relative(resolvedRoot, actual);
    if (actualRel.startsWith("..") || portableAbsolute(actualRel)) throw new Error("sandbox input link escapes workspace");
    const parent = await realpath(dirname(path));
    const parentRel = relative(resolvedRoot, parent);
    if (parentRel.startsWith("..") || portableAbsolute(parentRel)) throw new Error("sandbox input parent escapes workspace");
    const content = await readFile(actual);
    totalBytes += content.length;
    if (totalBytes > maxWorkspaceBytes) throw new Error("sandbox upload exceeds workspace byte budget");
    files.push({
      path: portable,
      contentBase64: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function boundedOutput(stdout: string, stderr: string, maxBytes: number): { stdout: string; stderr: string } {
  const truncate = (value: string, budget: number): { value: string; bytes: number } => {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.length <= budget) return { value, bytes: encoded.length };
    let end = budget;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
    const prefix = encoded.subarray(0, end).toString("utf8");
    return { value: prefix, bytes: end };
  };
  const boundedStdout = truncate(stdout, maxBytes);
  const boundedStderr = truncate(stderr, Math.max(0, maxBytes - boundedStdout.bytes));
  return { stdout: boundedStdout.value, stderr: boundedStderr.value };
}

export class CheckRegistry {
  constructor(
    executor: SandboxCheckExecutor,
    options: { allowTestPolicy?: boolean } = {},
  ) {
    if (new.target !== CheckRegistry) {
      throw new Error("check registry cannot be subclassed");
    }
    if (!executor || (typeof executor !== "object" && typeof executor !== "function")) {
      throw new Error("an external sandbox check executor is required");
    }
    const trustedContainer = captureTrustedContainerSandboxExecutor(executor);
    const isolationPolicy = trustedContainer?.isolationPolicy ?? executor.isolationPolicy;
    const startupGraceMs = trustedContainer?.startupGraceMs ?? executor.startupGraceMs;
    const abortGraceMs = trustedContainer?.abortGraceMs ?? executor.abortGraceMs;
    const executeMethod = trustedContainer?.execute ?? executor.execute;
    if (typeof executeMethod !== "function") {
      throw new Error("an external sandbox check executor is required");
    }
    if ((!positiveInteger(startupGraceMs, MAX_EXECUTOR_GRACE_MS) && startupGraceMs !== 0) ||
      !positiveInteger(abortGraceMs, MAX_EXECUTOR_GRACE_MS)) {
      throw new Error("invalid sandbox executor grace period");
    }
    if (isolationPolicy?.trustDomain === "production" && !trustedContainer) {
      throw new Error("production checks require the built-in container sandbox executor");
    }
    const trustedPolicy = new TrustedIsolationPolicy(isolationPolicy, options);
    const assertAttestationMethod = trustedPolicy.assertAttestation;
    const execute = trustedContainer
      ? trustedContainer.execute
      : (request: Parameters<SandboxCheckExecutor["execute"]>[0], signal?: AbortSignal) =>
        Reflect.apply(executeMethod, executor, [request, signal]);
    REGISTRY_STATES.set(this, {
      definitions: new Map(),
      isolationPolicy: structuredClone(trustedPolicy.policy),
      isolationPolicyDigest: trustedPolicy.digest,
      assertAttestation: (attestation, expected = {}) =>
        Reflect.apply(assertAttestationMethod, trustedPolicy, [attestation, expected]),
      execute,
      startupGraceMs,
      abortGraceMs,
    });
  }

  get isolationPolicy(): TrustedIsolationPolicy {
    const state = registryState(this);
    return new TrustedIsolationPolicy(state.isolationPolicy, {
      allowTestPolicy: state.isolationPolicy.trustDomain === "test",
    });
  }

  register(definition: CheckDefinition): void {
    const state = registryState(this);
    const argvValid = Array.isArray(definition?.argv) &&
      definition.argv.length >= 1 && definition.argv.length <= MAX_ARG_COUNT &&
      definition.argv.every((part) =>
        typeof part === "string" && !part.includes("\0") && Buffer.byteLength(part, "utf8") <= MAX_ARG_BYTES) &&
      definition.argv.reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0) <= MAX_ARGV_BYTES;
    const cwd = definition?.cwd;
    const cwdValid = cwd?.kind === "workspace" ||
      (cwd?.kind === "fixed" && typeof cwd.path === "string" && cwd.path.length <= 1_024 &&
        !cwd.path.includes("\0") && portableAbsolute(cwd.path));
    if (
      typeof definition?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(definition.id) ||
      !argvValid ||
      !portableAbsolute(definition.argv[0]) ||
      !cwdValid ||
      !validEnvironment(definition.env) ||
      !positiveInteger(definition.timeoutMs, MAX_CHECK_TIMEOUT_MS) ||
      !positiveInteger(definition.maxOutputBytes, MAX_CHECK_OUTPUT_BYTES)
    ) {
      throw new Error("invalid check definition");
    }
    if (state.definitions.has(definition.id)) {
      throw new Error(`duplicate check id: ${definition.id}`);
    }
    state.definitions.set(definition.id, structuredClone(definition));
  }

  has(id: string): boolean {
    return registryState(this).definitions.has(id);
  }

  definitionDigest(id: string): string {
    return definitionDigest(registryState(this), id);
  }

  assertTrustedIsolation(
    result: Pick<CheckResult, "checkId" | "definitionDigest" | "isolation">,
    expected: { requestDigest?: string; timeoutMs?: number } = {},
  ): void {
    assertTrustedIsolation(registryState(this), result, expected);
  }

  assertTrustedResultForArtifacts(
    result: Pick<CheckResult, "checkId" | "definitionDigest" | "isolation">,
    artifacts: CandidateArtifact[],
    scope: { allowedFiles: string[]; maxWorkspaceBytes: number },
  ): void {
    assertTrustedResultForArtifacts(registryState(this), result, artifacts, scope);
  }

  async run(
    id: string,
    workspaceRoot: string,
    scope: { allowedFiles: string[]; maxWorkspaceBytes: number },
  ): Promise<CheckResult> {
    const state = registryState(this);
    const definition = state.definitions.get(id);
    if (!definition) throw new Error(`unknown check id: ${id}`);
    const registeredDefinitionDigest = definitionDigest(state, id);
    const normalized = normalizedScope(scope);
    const request = {
      definition: structuredClone(definition),
      workspaceFiles: await workspaceFiles(workspaceRoot, normalized.allowedFiles, normalized.maxWorkspaceBytes),
      scope: {
        allowedFiles: [...normalized.allowedFiles],
        maxWorkspaceBytes: normalized.maxWorkspaceBytes,
        maxFileCount: normalized.allowedFiles.length,
      },
    };
    const requestDigest = sandboxRequestDigest(request);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let execution: SandboxCheckExecution;
    try {
      const executionPromise = state.execute(request, controller.signal);
      const outcome = await Promise.race([
        executionPromise.then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolveTimeout) => {
          timer = setTimeout(
            () => resolveTimeout({ kind: "timeout" }),
            definition.timeoutMs + (3 * state.startupGraceMs),
          );
        }),
      ]);
      if (outcome.kind === "timeout") {
        controller.abort();
        await Promise.race([
          executionPromise.then(() => undefined, () => undefined),
          new Promise<void>((resolveAbort) => setTimeout(resolveAbort, state.abortGraceMs)),
        ]);
        throw new Error(`sandbox check executor exceeded timeout: ${id}`);
      }
      if (outcome.kind === "error") throw outcome.error;
      execution = outcome.value;
    } catch (error) {
      throw new SandboxExecutionUncertainError(
        `sandbox check execution did not settle safely: ${id}`,
        { cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    execution = validateExecution(execution);
    state.assertAttestation(execution.isolation, {
      requestDigest,
      timeoutMs: definition.timeoutMs,
    });
    const full = boundedOutput(execution.stdout, execution.stderr, definition.maxOutputBytes);
    const outputBytes = Buffer.byteLength(full.stdout, "utf8") + Buffer.byteLength(full.stderr, "utf8");
    const persisted = boundedOutput(full.stdout, full.stderr, MAX_CHECK_RESULT_TEXT_BYTES);
    const persistedBytes = Buffer.byteLength(persisted.stdout, "utf8") +
      Buffer.byteLength(persisted.stderr, "utf8");
    return {
      checkId: id,
      definitionDigest: registeredDefinitionDigest,
      passed: execution.terminationReason === "exit" && !execution.timedOut && execution.exitCode === 0,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      stdout: persisted.stdout,
      stderr: persisted.stderr,
      outputDigest: createHash("sha256").update(full.stdout).update("\0").update(full.stderr).digest("hex"),
      outputBytes,
      outputTruncated: persistedBytes < outputBytes,
      elapsedMs: Math.max(0, execution.elapsedMs),
      isolation: structuredClone(execution.isolation),
    };
  }
}

function definitionDigest(state: CheckRegistryState, id: string): string {
  const definition = state.definitions.get(id);
  if (!definition) throw new Error(`unknown check id: ${id}`);
  return checkDefinitionDigest(definition, state.isolationPolicy);
}

function assertTrustedIsolation(
  state: CheckRegistryState,
  result: Pick<CheckResult, "checkId" | "definitionDigest" | "isolation">,
  expected: { requestDigest?: string; timeoutMs?: number } = {},
): void {
  if (definitionDigest(state, result.checkId) !== result.definitionDigest) {
    throw new Error(`check definition changed after execution: ${result.checkId}`);
  }
  state.assertAttestation(result.isolation, expected);
}

function assertTrustedResultForArtifacts(
  state: CheckRegistryState,
  result: Pick<CheckResult, "checkId" | "definitionDigest" | "isolation">,
  artifacts: CandidateArtifact[],
  scope: { allowedFiles: string[]; maxWorkspaceBytes: number },
): void {
  const definition = state.definitions.get(result.checkId);
  if (!definition) throw new Error(`unknown check id: ${result.checkId}`);
  const normalized = normalizedScope(scope);
  const artifactMap = new Map<string, CandidateArtifact>();
  for (const artifact of artifacts) {
    const path = portableRelativePath(artifact.path);
    if (artifactMap.has(path) || artifact.bytes !== Buffer.byteLength(artifact.content, "utf8") ||
      artifact.sha256 !== createHash("sha256").update(artifact.content).digest("hex")) {
      throw new Error("candidate artifacts cannot reconstruct a trusted check request");
    }
    artifactMap.set(path, artifact);
  }
  let totalBytes = 0;
  const files = normalized.allowedFiles.map((path) => {
    const artifact = artifactMap.get(path);
    if (!artifact) throw new Error(`candidate is missing check input: ${path}`);
    totalBytes += artifact.bytes;
    if (totalBytes > normalized.maxWorkspaceBytes) {
      throw new Error("candidate check inputs exceed the registered workspace budget");
    }
    return {
      path,
      contentBase64: Buffer.from(artifact.content, "utf8").toString("base64"),
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const requestDigest = sandboxRequestDigest({
    definition: structuredClone(definition),
    workspaceFiles: files,
    scope: {
      allowedFiles: [...normalized.allowedFiles],
      maxWorkspaceBytes: normalized.maxWorkspaceBytes,
      maxFileCount: normalized.allowedFiles.length,
    },
  });
  assertTrustedIsolation(state, result, {
    requestDigest,
    timeoutMs: definition.timeoutMs,
  });
}

export function assertTrustedPublicationResult(
  registry: CheckRegistry,
  result: Pick<CheckResult, "checkId" | "definitionDigest" | "isolation">,
  artifacts: CandidateArtifact[],
  scope: { allowedFiles: string[]; maxWorkspaceBytes: number },
): void {
  assertTrustedResultForArtifacts(registryState(registry), result, artifacts, scope);
}
