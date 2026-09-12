import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedFile, LspRunResult } from "./facts.js";
import { unavailableLspResult } from "./facts.js";
import {
  loadLspAttestationFromEnvironment,
  type VerifiedLspAttestation,
} from "./lsp-attestation.js";

const MAX_LSP_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_FACTS = 250_000;
const DEFAULT_LSP_TIMEOUT_MS = 120_000;

export interface LspRunner {
  analyze(input: {
    language: string;
    files: ParsedFile[];
    workspaceFiles?: ParsedFile[];
    sourceRoot: string;
    runtimeRoot: string;
    signal?: AbortSignal;
  }): Promise<LspRunResult>;
}

export class SandboxedLspRunner implements LspRunner {
  constructor(private readonly attestation: VerifiedLspAttestation) {}

  async analyze(input: {
    language: string;
    files: ParsedFile[];
    workspaceFiles?: ParsedFile[];
    sourceRoot: string;
    runtimeRoot: string;
    signal?: AbortSignal;
  }): Promise<LspRunResult> {
    const binding = this.attestation.languages.get(input.language);
    if (!binding) return unavailableLspResult(input.language, "lsp_language_not_attested");
    if (!input.files.length) return unavailableLspResult(input.language, "lsp_no_files");

    const sourceRoot = await realpath(input.sourceRoot);
    const runtimeRoot = resolve(input.runtimeRoot);
    await mkdir(runtimeRoot, { recursive: true });
    const realRuntimeRoot = await realpath(runtimeRoot);
    if (isInside(realRuntimeRoot, sourceRoot) || isInside(sourceRoot, realRuntimeRoot)) {
      return unavailableLspResult(input.language, "lsp_runtime_not_isolated");
    }

    const runRoot = join(realRuntimeRoot, `${input.language}-${randomUUID()}`);
    const mirrorRoot = join(runRoot, "source");
    const requestPath = join(runRoot, "request.json");
    const resultPath = join(runRoot, "result.json");
    await mkdir(mirrorRoot, { recursive: true });
    try {
      const workspaceFiles = input.workspaceFiles ?? input.files;
      const workspacePaths = new Set(workspaceFiles.map((file) => file.path));
      if (input.files.some((file) => !workspacePaths.has(file.path))) {
        return unavailableLspResult(input.language, "lsp_target_outside_workspace");
      }
      for (const file of workspaceFiles) {
        input.signal?.throwIfAborted();
        const source = await safeSourceFile(sourceRoot, file.path, file.bytes, file.digest);
        const destination = join(mirrorRoot, ...file.path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
      }

      const staged = await this.attestation.stageForExecution(
        input.language,
        join(runRoot, "executables"),
      );
      const workerEntry = fileURLToPath(new URL("./lsp-worker-entry.js", import.meta.url));
      const workerInfo = await lstat(workerEntry).catch(() => null);
      if (!workerInfo || !workerInfo.isFile() || workerInfo.isSymbolicLink()) {
        return unavailableLspResult(input.language, "lsp_worker_not_built");
      }
      await writeFile(requestPath, JSON.stringify({
        language: input.language,
        serverCommand: staged.serverCommand,
        sourceRoot: mirrorRoot,
        files: input.files.map((file) => file.path),
        workspaceFiles: workspaceFiles.map((file) => file.path),
        requestTimeoutMs: 20_000,
        maxSymbols: MAX_FACTS,
        maxRelations: MAX_FACTS,
      }), "utf8");

      const exitCode = await runSandboxedWorker({
        wrapperCommand: staged.wrapperCommand,
        workerEntry,
        requestPath,
        resultPath,
        cwd: runRoot,
        environment: safeLspEnvironment(runRoot),
        timeoutMs: DEFAULT_LSP_TIMEOUT_MS,
        signal: input.signal,
      });
      if (exitCode !== 0) {
        return unavailableLspResult(
          input.language,
          "lsp_worker_failed",
          `lsp_worker_exit_${exitCode}`,
        );
      }
      const info = await lstat(resultPath).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_LSP_RESULT_BYTES) {
        return unavailableLspResult(input.language, "lsp_result_invalid");
      }
      const parsed = parseLspRunResult(JSON.parse(await readFile(resultPath, "utf8")) as unknown);
      if (parsed.language !== input.language) return unavailableLspResult(input.language, "lsp_language_mismatch");
      if (parsed.symbols.length > MAX_FACTS || parsed.relations.length > MAX_FACTS) {
        return unavailableLspResult(input.language, "lsp_fact_limit_exceeded");
      }
      const reasons = [...parsed.reasonCodes];
      const versionMatches = parsed.serverVersion === binding.serverVersion;
      const capabilitiesMatch = binding.capabilities.every((capability) => parsed.capabilities.includes(capability));
      if (!versionMatches) reasons.push("lsp_server_version_mismatch");
      if (!capabilitiesMatch) reasons.push("lsp_truth_capability_mismatch");
      return {
        ...parsed,
        truthVerified: parsed.completed && versionMatches && capabilitiesMatch,
        reasonCodes: [...new Set(reasons)],
      };
    } catch (error) {
      if (input.signal?.aborted) return unavailableLspResult(input.language, "lsp_cancelled");
      return unavailableLspResult(
        input.language,
        "lsp_worker_error",
        error instanceof Error ? error.name : "UnknownError",
      );
    } finally {
      await removeRunRoot(runRoot, realRuntimeRoot);
    }
  }
}

export async function createLspRunner(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LspRunner | null> {
  const attestation = await loadLspAttestationFromEnvironment(environment);
  return attestation ? new SandboxedLspRunner(attestation) : null;
}

export function safeLspEnvironment(runtimeRoot: string): NodeJS.ProcessEnv {
  const keep = new Set(["systemroot", "windir", "comspec"]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (keep.has(key.toLowerCase()) && value) environment[key] = value;
  }
  const temp = join(runtimeRoot, "tmp");
  const home = join(runtimeRoot, "home");
  environment.TEMP = temp;
  environment.TMP = temp;
  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = "";
  environment.GOPROXY = "off";
  environment.GONOSUMDB = "*";
  environment.CARGO_NET_OFFLINE = "true";
  environment.npm_config_ignore_scripts = "true";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  environment.MAVEN_OPTS = "-o";
  environment.GRADLE_OPTS = "-Dorg.gradle.offline=true";
  environment.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
  environment.DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1";
  environment.NUGET_XMLDOC_MODE = "skip";
  return environment;
}

async function runSandboxedWorker(input: {
  wrapperCommand: string[];
  workerEntry: string;
  requestPath: string;
  resultPath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<number> {
  if (!input.wrapperCommand.length || !isAbsolute(input.wrapperCommand[0] as string)) {
    throw new Error("invalid sandbox wrapper command");
  }
  await Promise.all([mkdir(input.environment.TEMP as string, { recursive: true }), mkdir(input.environment.HOME as string, { recursive: true })]);
  const child = spawn(input.wrapperCommand[0] as string, [
    ...input.wrapperCommand.slice(1),
    "--",
    process.execPath,
    input.workerEntry,
    input.requestPath,
    input.resultPath,
  ], {
    cwd: input.cwd,
    env: input.environment,
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill();
      finish(() => rejectPromise(new Error("LSP worker cancelled")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => rejectPromise(new Error("LSP worker timed out")));
    }, input.timeoutMs);
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("exit", (code) => finish(() => resolvePromise(code ?? 1)));
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function safeSourceFile(root: string, path: string, expectedBytes: number, expectedDigest: string): Promise<string> {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe LSP source path");
  }
  const candidate = await realpath(resolve(root, ...normalized.split("/")));
  if (!isInside(candidate, root)) throw new Error("LSP source path escaped the snapshot");
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes) throw new Error("LSP source file changed");
  const raw = await readFile(candidate);
  if (createHash("sha256").update(raw).digest("hex") !== expectedDigest) throw new Error("LSP source digest changed");
  return candidate;
}

function parseLspRunResult(value: unknown): LspRunResult {
  if (!isRecord(value)) throw new Error("invalid LSP result");
  const symbols = Array.isArray(value.symbols) ? value.symbols : [];
  const relations = Array.isArray(value.relations) ? value.relations : [];
  return {
    language: requiredText(value.language),
    completed: value.completed === true,
    truthVerified: false,
    serverName: optionalText(value.serverName),
    serverVersion: optionalText(value.serverVersion),
    capabilities: textArray(value.capabilities),
    reasonCodes: textArray(value.reasonCodes),
    symbols: symbols.map((item) => {
      if (!isRecord(item)) throw new Error("invalid LSP symbol");
      const kind = requiredText(item.kind);
      if (!["class", "interface", "struct", "enum", "function", "method", "constructor", "variable"].includes(kind)) throw new Error("invalid LSP symbol kind");
      return {
        path: requiredText(item.path),
        name: requiredText(item.name),
        qualifiedName: requiredText(item.qualifiedName),
        kind: kind as LspRunResult["symbols"][number]["kind"],
        startLine: positiveInteger(item.startLine),
        endLine: positiveInteger(item.endLine),
        startColumn: nonNegativeInteger(item.startColumn),
        endColumn: nonNegativeInteger(item.endColumn),
      };
    }),
    relations: relations.map((item) => {
      if (!isRecord(item)) throw new Error("invalid LSP relation");
      const kind = requiredText(item.kind);
      if (!["calls", "inherits", "implements"].includes(kind)) throw new Error("invalid LSP relation kind");
      return {
        kind: kind as LspRunResult["relations"][number]["kind"],
        sourcePath: requiredText(item.sourcePath),
        sourceName: requiredText(item.sourceName),
        sourceLine: positiveInteger(item.sourceLine),
        sourceColumn: nonNegativeInteger(item.sourceColumn),
        targetPath: requiredText(item.targetPath),
        targetName: requiredText(item.targetName),
        targetLine: positiveInteger(item.targetLine),
        targetColumn: nonNegativeInteger(item.targetColumn),
      };
    }),
  };
}

async function removeRunRoot(runRoot: string, runtimeRoot: string): Promise<void> {
  if (!isInside(runRoot, runtimeRoot) || runRoot === runtimeRoot) return;
  await rm(runRoot, { recursive: true, force: true });
}

function isInside(candidate: string, parent: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error("invalid LSP text field");
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 200) : null;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid LSP text array");
  return value.map(requiredText);
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("invalid positive integer");
  return number;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error("invalid non-negative integer");
  return number;
}
