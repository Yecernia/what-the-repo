import { spawn, execFile, type ChildProcess } from "node:child_process";
import { lstat, readFile, realpath, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { lspConfiguration, lspInitializationOptions, lspSafeCommand, lspSettings, unsafeLspWorkspaceConfiguration } from './lsp-policy.js';
import { setTimeout as delay } from "node:timers/promises";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  CancellationTokenSource,
  ResponseError,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import {
  type FactSymbolKind,
  type LspRelationFact,
  type LspRunResult,
  type LspSymbolFact,
  unavailableLspResult,
  lspServerVersion,
} from "./facts.js";
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export interface WorkerRequest {
  language: string;
  serverCommand: string[];
  sourceRoot: string;
  projectRoot?: string;
  files: string[];
  workspaceFiles: string[];
  requestTimeoutMs: number;
  maxSymbols: number;
  maxRelations: number;
  totalBudgetMs?: number;
  concurrency?: number;
}
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32")
    await new Promise<void>((done) =>
      execFile(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        (error) => {
          if (error) child.kill("SIGKILL");
          done();
        },
      ),
    );
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await waitForExit(child, 2000).catch(() => undefined);
}
export class LspSession {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private unsupported = new Set<string>();
  private bytes = 0;
  serverInfo: Record<string, unknown> = {};
  capabilities: Record<string, unknown> = {};
  requests = 0;
  failures: Record<string, number> = {};
  workspaceDiagnostics: NonNullable<LspRunResult["workspaceDiagnostics"]> = [];
  shutdownFailure: string | null = null;
  private closing = false;
  private workspaceStatus: { quiescent: boolean; health: string; message?: string } | null = null;
  private readonly statusListeners = new Set<() => void>();
  constructor(
    private readonly command: string[],
    private readonly root: string,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
    private readonly language = 'unknown',
  ) {}
  async start(): Promise<void> {
    if (!this.command.length || !isAbsolute(this.command[0]!))
      throw new Error("lsp_executable_not_absolute");
    const stat = await lstat(this.command[0]!);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("unsafe_lsp_executable");
    const child = spawn(this.command[0]!, this.command.slice(1), {
      cwd: this.root,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.process = child;
    // Bound aggregate transport allocation as well as the outer worker RSS/time budget.
    const bounded = new Transform({
      transform: (chunk, _encoding, callback) => {
        this.bytes += chunk.length;
        if (this.bytes > 64 * 1024 * 1024) {
          callback(new Error("lsp_transport_budget"));
          void terminateProcessTree(child);
        } else callback(null, chunk);
      },
    });
    bounded.on("error", () => this.connection?.dispose());
    child.stdout!.pipe(bounded);
    const connection = createMessageConnection(
      new StreamMessageReader(bounded),
      new StreamMessageWriter(child.stdin!),
    );
    this.connection = connection;
    child.once("error", () => connection.dispose());
    child.once("exit", () => connection.dispose());
    connection.onNotification((method, params) => {
      if (this.language === 'java' && method === 'language/status' && isRecord(params) &&
          ['Starting', 'Started', 'ServiceReady', 'Error'].includes(String(params.type))) {
        this.workspaceStatus = { quiescent: params.type === 'ServiceReady',
          health: params.type === 'Error' ? 'error' : 'ok',
          ...(typeof params.message === 'string' ? { message: params.message.slice(0, 2000) } : {}) };
        for (const listener of this.statusListeners) listener();
      }
      if (method === 'experimental/serverStatus' && isRecord(params) && typeof params.quiescent === 'boolean') {
        this.workspaceStatus = { quiescent: params.quiescent, health: String(params.health),
          ...(typeof params.message === 'string' ? { message: params.message.slice(0, 2000) } : {}) };
        for (const listener of this.statusListeners) listener();
      }
      if (
        (method === "window/logMessage" || method === "window/showMessage") &&
        isRecord(params) &&
        (params.type === 1 || params.type === 2) &&
        typeof params.message === "string" &&
        this.workspaceDiagnostics.length < 100
      ) {
        // Several real servers finish background diagnostics while shutting
        // down. Preserve cleanup failure separately from completed queries.
        if (this.closing) {
          if (params.type === 1) this.shutdownFailure ??= 'lsp_shutdown_reported_error';
          return;
        }
        this.workspaceDiagnostics.push({
          severity: params.type === 1 ? "error" : "warning",
          message: params.message.slice(0, 2000),
        });
      }
    });
    connection.onRequest((method, params) => {
      if (
        method === "workspace/configuration" &&
        isRecord(params) &&
        Array.isArray(params.items)
      )
        return params.items.map((item: unknown) => lspConfiguration(this.language, isRecord(item) ? item.section : undefined));
      if (method === "workspace/workspaceFolders")
        return [{ uri: pathToFileURL(this.root).href, name: "source" }];
      if (method === "window/workDoneProgress/create") return null;
      throw new ResponseError(-32601, "Client capability not supported");
    });
    connection.listen();
    const initialized = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [
        { uri: pathToFileURL(this.root).href, name: "source" },
      ],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        ...(this.language === 'rust' ? { experimental: { serverStatusNotification: true } } : {}),
        window: { workDoneProgress: true },
        workspace: { configuration: true },
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
            dynamicRegistration: false,
          },
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: false },
        },
      },
      initializationOptions: lspInitializationOptions(this.language),
    });
    if (isRecord(initialized)) {
      if (isRecord(initialized.serverInfo))
        this.serverInfo = initialized.serverInfo;
      if (isRecord(initialized.capabilities))
        this.capabilities = initialized.capabilities;
    }
    if (
      this.capabilities.positionEncoding &&
      this.capabilities.positionEncoding !== "utf-16"
    )
      throw new Error("lsp_position_encoding_unsupported");
    this.notify("initialized", {});
    // JDT LS already consumed these settings in initialize; a duplicate change
    // can start another project refresh while initial import is still running.
    if (this.language !== 'java')
      this.notify('workspace/didChangeConfiguration', { settings: lspSettings(this.language) });
  }
  async waitForWorkspace(): Promise<boolean> {
    if (this.language !== 'rust' && this.language !== 'java') return false;
    this.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); this.statusListeners.delete(changed);
        this.signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const changed = () => {
        if (this.workspaceStatus?.quiescent) finish();
      };
      const abort = () => finish(new Error('lsp_workspace_cancelled'));
      const timer = setTimeout(() => finish(new Error('lsp_workspace_readiness_timeout')), this.timeoutMs);
      this.statusListeners.add(changed);
      this.signal?.addEventListener('abort', abort, { once: true });
      changed();
      if (this.signal?.aborted) abort();
    });
    if (this.workspaceStatus && this.workspaceStatus.health !== 'ok') {
      this.workspaceDiagnostics.push({ severity: this.workspaceStatus.health === 'error' ? 'error' : 'warning',
        message: this.workspaceStatus.message ?? 'Language server workspace is incomplete' });
    }
    return true;
  }
  supports(capability: string): boolean {
    return !!this.capabilities[capability];
  }
  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.closing = true;
    try {
      if (!this.signal?.aborted && child.exitCode === null) {
        await this.request("shutdown", null, 1000);
        this.notify("exit", null);
        await waitForExit(child, 1000);
      }
    } catch (error) {
      this.shutdownFailure =
        error instanceof Error ? error.message : "lsp_shutdown_error";
    } finally {
      await terminateProcessTree(child);
      this.connection?.dispose();
      this.connection = null;
      this.process = null;
    }
  }
  openDocument(path: string, language: string, content: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(path).href,
        languageId: language,
        version: 1,
        text: content,
      },
    });
  }
  notify(method: string, params: unknown): void {
    if (!this.connection) return;
    // The string-method overload treats null as a positional [null] argument.
    // LSP shutdown/exit have no parameters.
    void (params === null
      ? this.connection.sendNotification(method)
      : this.connection.sendNotification(method, params)).catch(() => undefined);
  }
  async request(
    method: string,
    params: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    this.signal?.throwIfAborted();
    if (!this.connection) throw new Error("lsp_not_running");
    this.requests++;
    const token = new CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        params === null
          ? this.connection.sendRequest(method, token.token)
          : this.connection.sendRequest(method, params, token.token),
        new Promise<never>((_, reject) => {
          abort = () => {
            token.cancel();
            reject(new Error("lsp_cancelled"));
          };
          this.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => {
            token.cancel();
            reject(new Error("lsp_request_timeout"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      const code =
        error instanceof ResponseError
          ? "server_" + error.code
          : error instanceof Error
            ? error.message
            : "server_error";
      if (method !== "shutdown")
        this.failures[code] = (this.failures[code] ?? 0) + 1;
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      token.dispose();
    }
  }
  async optionalRequest(
    method: string,
    params: unknown,
  ): Promise<unknown | null> {
    if (this.unsupported.has(method)) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.request(method, params);
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (error instanceof ResponseError && error.code === -32601)
          this.unsupported.add(method);
        // A bounded retry for protocol-declared transient invalidation, not a
        // fixed startup sleep or a claim that workspace loading has finished.
        if (
          attempt === 0 &&
          error instanceof ResponseError &&
          [-32801, -32802].includes(error.code)
        ) {
          await delay(100, undefined, { signal: this.signal });
          continue;
        }
        return undefined;
      }
    }
    return undefined;
  }
}
export async function analyzeLspRequest(
  request: WorkerRequest,
  signal?: AbortSignal,
  checkpoint?: (result: LspRunResult) => Promise<void>,
): Promise<LspRunResult> {
  validateWorkerRequest(request);
  const unsafeConfiguration = unsafeLspWorkspaceConfiguration(request.language, request.workspaceFiles);
  if (unsafeConfiguration) return unavailableLspResult(request.language, unsafeConfiguration);
  const sourceRoot = await realpath(request.sourceRoot),
    allowedPaths = new Set(request.workspaceFiles);
  const deadline = AbortSignal.timeout(request.totalBudgetMs ?? 100000),
    combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const projectRoot = resolve(sourceRoot, request.projectRoot ?? ".");
  if (!isInside(projectRoot, sourceRoot)) throw new Error("lsp_project_escape");
  const session = new LspSession(
    lspSafeCommand(request.language, request.serverCommand),
    projectRoot,
    request.requestTimeoutMs,
    combined,
    request.language,
  );
  const result: LspRunResult = {
    ...unavailableLspResult(request.language),
    reasonCodes: ["workspace_readiness_not_observable"],
    coverage: {
      filesRequested: request.files.length,
      filesCompleted: [],
      targetsRequested: 0,
      targetsCompleted: 0,
      requests: 0,
      failures: {},
      targets: [],
    },
  };
  let exceeded = false;
  try {
    await session.start();
    if (await session.waitForWorkspace()) result.reasonCodes = [];
    result.serverName = optionalText(session.serverInfo.name);
    result.serverVersion = lspServerVersion(session.serverInfo.version);
    for (const [capability, label] of [
      ["documentSymbolProvider", "document_symbols"],
      ["callHierarchyProvider", "call_hierarchy"],
      ["typeHierarchyProvider", "type_hierarchy"],
    ])
      if (session.supports(capability!)) result.capabilities.push(label!);
    if (!session.supports("documentSymbolProvider")) {
      result.reasonCodes.push("document_symbols_unsupported");
      return result;
    }
    if (!session.supports("callHierarchyProvider"))
      result.reasonCodes.push("call_hierarchy_unsupported");
    if (!session.supports("typeHierarchyProvider"))
      result.reasonCodes.push("type_hierarchy_unsupported");
    const jobs = [...request.files].sort();
    let cursor = 0;
    const work = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= jobs.length || exceeded) return;
        combined.throwIfAborted();
        const relativePath = jobs[index]!;
        const path = await safeSourcePath(sourceRoot, relativePath),
          info = await lstat(path);
        if (!info.isFile() || info.size > MAX_SOURCE_FILE_BYTES)
          throw new Error("unsafe_lsp_file");
        session.openDocument(
          path,
          request.language,
          (await readFile(path)).toString("utf8"),
        );
        const response = await session.optionalRequest(
          "textDocument/documentSymbol",
          { textDocument: { uri: pathToFileURL(path).href } },
        );
        if (response !== null && !Array.isArray(response)) continue;
        const raw = await flattenSymbols(
          response ?? [],
          relativePath,
          sourceRoot,
          allowedPaths,
          [],
        );
        const room = request.maxSymbols - result.symbols.length;
        result.symbols.push(...raw.slice(0, room).map((r) => r.symbol));
        if (raw.length > room) {
          exceeded = true;
          result.reasonCodes.push("lsp_symbol_limit");
          return;
        }
        result.coverage!.filesCompleted.push(relativePath);
        const targetStates = new Map<
          LspSymbolFact,
          NonNullable<NonNullable<LspRunResult["coverage"]>["targets"]>[number]
        >();
        for (const { symbol } of raw) {
          const calls =
            ["function", "method", "constructor", "accessor"].includes(
              symbol.kind,
            ) && session.supports("callHierarchyProvider");
          const types =
            ["class", "interface", "struct"].includes(symbol.kind) &&
            session.supports("typeHierarchyProvider");
          if (!calls && !types) continue;
          const selection = symbol.selection ?? symbol;
          const target = {
            path: symbol.path,
            line: selection.startLine,
            column: selection.startColumn,
            kind: calls
              ? ("call_hierarchy" as const)
              : ("type_hierarchy" as const),
            status: "pending" as const,
          };
          targetStates.set(symbol, target);
          result.coverage!.targets!.push(target);
          result.coverage!.targetsRequested++;
        }
        // Save declarations before slower hierarchy requests can exhaust the budget.
        result.coverage!.requests = session.requests;
        result.coverage!.failures = { ...session.failures };
        await checkpoint?.(result);
        for (const { symbol } of raw) {
          const callable = [
              "function",
              "method",
              "constructor",
              "accessor",
            ].includes(symbol.kind),
            type = ["class", "interface", "struct"].includes(symbol.kind);
          const calls = callable && session.supports("callHierarchyProvider"),
            types = type && session.supports("typeHierarchyProvider");
          if (!calls && !types) continue;
          const state = targetStates.get(symbol)!;
          const selection = symbol.selection ?? symbol,
            document = {
              textDocument: {
                uri: pathToFileURL(resolve(sourceRoot, symbol.path)).href,
              },
              position: {
                line: selection.startLine - 1,
                character: selection.startColumn,
              },
            };
          const prepared = await session.optionalRequest(
            calls
              ? "textDocument/prepareCallHierarchy"
              : "textDocument/prepareTypeHierarchy",
            document,
          );
          if (prepared !== null && !Array.isArray(prepared)) {
            state.status = "failed";
            continue;
          }
          let completed = true;
          for (const item of prepared ?? []) {
            // Opaque data is passed through intact for every prepared item.
            const outgoing = await session.optionalRequest(
              calls
                ? "callHierarchy/outgoingCalls"
                : "typeHierarchy/supertypes",
              { item },
            );
            if (outgoing !== null && !Array.isArray(outgoing)) {
              completed = false;
              continue;
            }
            const rows = calls
              ? await callRelations(
                  sourceRoot,
                  symbol,
                  outgoing ?? [],
                  allowedPaths,
                )
              : await typeRelations(
                  sourceRoot,
                  symbol,
                  outgoing ?? [],
                  allowedPaths,
                );
            const remaining = request.maxRelations - result.relations.length;
            result.relations.push(...rows.slice(0, remaining));
            if (rows.length > remaining) {
              exceeded = true;
              result.reasonCodes.push("lsp_relation_limit");
              return;
            }
          }
          state.status = completed ? "completed" : "failed";
          if (completed) result.coverage!.targetsCompleted++;
        }
        result.coverage!.requests = session.requests;
        result.coverage!.failures = { ...session.failures };
        await checkpoint?.(result);
      }
    };
    const settled = await Promise.allSettled(
      Array.from(
        { length: Math.min(4, Math.max(1, request.concurrency ?? 2)) },
        work,
      ),
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    result.completed =
      !exceeded &&
      result.coverage!.filesCompleted.length === request.files.length &&
      result.coverage!.targetsCompleted === result.coverage!.targetsRequested &&
      !session.workspaceDiagnostics.some((d) => d.severity === "error");
  } catch (error) {
    if (signal?.aborted) throw error;
    result.reasonCodes.push(
      deadline.aborted
        ? "lsp_total_budget"
        : error instanceof Error
          ? error.message
          : "lsp_server_error",
    );
  } finally {
    await session.close();
    result.coverage!.requests = session.requests;
    result.coverage!.failures = { ...session.failures };
    result.workspaceDiagnostics = session.workspaceDiagnostics;
    if (session.workspaceDiagnostics.some((d) => d.severity === "error")) {
      result.completed = false;
      result.reasonCodes.push("lsp_workspace_error");
    }
    if (session.shutdownFailure) result.reasonCodes.push("lsp_shutdown_failed");
  }
  result.symbols = dedupeSymbols(result.symbols).sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn,
  );
  result.relations = dedupeRelations(result.relations).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  result.coverage!.filesCompleted.sort();
  return result;
}

export async function runLspWorkerCli(
  argv = process.argv.slice(2),
): Promise<number> {
  if (argv.length !== 2) return 2;
  const requestPath = resolve(argv[0] as string);
  const resultPath = resolve(argv[1] as string);
  let language = "unknown";
  let result: LspRunResult;
  try {
    const request = parseWorkerRequest(
      JSON.parse(await readFile(requestPath, "utf8")) as unknown,
    );
    language = request.language;
    const requestRoot = await realpath(dirname(requestPath));
    const sourceRoot = await realpath(request.sourceRoot);
    if (!isInside(sourceRoot, requestRoot))
      throw new Error("LSP source mirror escaped the run root");
    let pending = Promise.resolve();
    result = await analyzeLspRequest(request, undefined, (partial) => {
      const body = JSON.stringify(partial);
      pending = pending.then(async () => {
        await writeFile(resultPath + ".tmp", body, "utf8");
        await rename(resultPath + ".tmp", resultPath);
      });
      return pending;
    });
  } catch (error) {
    result = unavailableLspResult(
      language,
      "lsp_worker_exception",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  await writeFile(resultPath, JSON.stringify(result), "utf8");
  return 0;
}

async function flattenSymbols(
  rawSymbols: unknown[],
  relativePath: string,
  sourceRoot: string,
  allowedPaths: Set<string>,
  parentNames: string[],
): Promise<Array<{ symbol: LspSymbolFact; raw: Record<string, unknown> }>> {
  const result: Array<{ symbol: LspSymbolFact; raw: Record<string, unknown> }> =
    [];
  for (const value of rawSymbols) {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      !value.name.trim()
    )
      continue;
    let rawRange = value.range;
    if (isRecord(value.location)) {
      if (typeof value.location.uri !== "string") continue;
      if (
        (await workspaceUriRelative(
          sourceRoot,
          value.location.uri,
          allowedPaths,
        )) !== relativePath
      )
        continue;
      rawRange = value.location.range ?? rawRange;
    }
    const range = parseRange(rawRange);
    const kind = nodeKind(value.kind);
    if (!range || !kind) {
      if (Array.isArray(value.children))
        result.push(
          ...(await flattenSymbols(
            value.children,
            relativePath,
            sourceRoot,
            allowedPaths,
            [...parentNames, value.name],
          )),
        );
      continue;
    }
    const symbol: LspSymbolFact = {
      path: relativePath,
      selection: parseRange(value.selectionRange) ?? range,
      hierarchy: isRecord(value.location) ? "flat" : "lexical",
      name: value.name,
      qualifiedName: [...parentNames, value.name].join("."),
      kind,
      startLine: range.startLine,
      endLine: range.endLine,
      startColumn: range.startColumn,
      endColumn: range.endColumn,
    };
    result.push({ symbol, raw: value });
    if (Array.isArray(value.children)) {
      result.push(
        ...(await flattenSymbols(
          value.children,
          relativePath,
          sourceRoot,
          allowedPaths,
          [...parentNames, value.name],
        )),
      );
    }
  }
  return result;
}

async function callRelations(
  sourceRoot: string,
  source: LspSymbolFact,
  outgoing: unknown[],
  allowedPaths: Set<string>,
): Promise<LspRelationFact[]> {
  const result: LspRelationFact[] = [];
  for (const value of outgoing) {
    if (!isRecord(value) || !isRecord(value.to)) continue;
    const target = await hierarchyTarget(sourceRoot, value.to, allowedPaths);
    if (!target) continue;
    for (const raw of Array.isArray(value.fromRanges) ? value.fromRanges : []) {
      const range = parseRange(raw);
      if (!range) continue;
      result.push({
        kind: "calls",
        sourcePath: source.path,
        sourceName: source.qualifiedName,
        sourceSelection: source.selection ?? source,
        sourceLine: range.startLine,
        sourceColumn: range.startColumn,
        range,
        targetPath: target.path,
        targetName: target.name,
        targetLine: target.line,
        targetColumn: target.column,
      });
    }
  }
  return result;
}

async function typeRelations(
  sourceRoot: string,
  source: LspSymbolFact,
  supertypes: unknown[],
  allowedPaths: Set<string>,
): Promise<LspRelationFact[]> {
  const result: LspRelationFact[] = [];
  for (const value of supertypes) {
    if (!isRecord(value)) continue;
    const target = await hierarchyTarget(sourceRoot, value, allowedPaths);
    if (!target) continue;
    result.push({
      kind: "supertype",
      sourceSelection: source.selection ?? source,
      sourcePath: source.path,
      sourceName: source.qualifiedName,
      sourceLine: source.startLine,
      sourceColumn: source.startColumn,
      targetPath: target.path,
      targetName: target.name,
      targetLine: target.line,
      targetColumn: target.column,
    });
  }
  return result;
}

async function hierarchyTarget(
  sourceRoot: string,
  value: Record<string, unknown>,
  allowedPaths: Set<string>,
): Promise<{
  path: string;
  name: string;
  line: number;
  column: number;
} | null> {
  if (typeof value.name !== "string" || typeof value.uri !== "string")
    return null;
  const range = parseRange(value.selectionRange ?? value.range);
  if (!range) return null;
  const path = await workspaceUriRelative(sourceRoot, value.uri, allowedPaths);
  return path
    ? {
        path,
        name: value.name,
        line: range.startLine,
        column: range.startColumn,
      }
    : null;
}

function parseRange(value: unknown): {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
} | null {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end))
    return null;
  const startLine = Number(value.start.line) + 1;
  const endLine = Number(value.end.line) + 1;
  const startColumn = Number(value.start.character);
  const endColumn = Number(value.end.character);
  if (![startLine, endLine, startColumn, endColumn].every(Number.isInteger))
    return null;
  if (
    Math.min(startLine, endLine) < 1 ||
    Math.min(startColumn, endColumn) < 0 ||
    endLine < startLine ||
    (endLine === startLine && endColumn < startColumn)
  )
    return null;
  return { startLine, endLine, startColumn, endColumn };
}

function nodeKind(value: unknown): FactSymbolKind | null {
  const kind = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(kind)) return null;
  return (
    new Map<number, FactSymbolKind>([
      [5, "class"],
      [6, "method"],
      [9, "constructor"],
      [10, "enum"],
      [11, "interface"],
      [12, "function"],
      [13, "variable"],
      [23, "struct"],
    ]).get(kind) ?? null
  );
}

async function safeSourcePath(
  root: string,
  relativePath: string,
): Promise<string> {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("unsafe LSP mirror path");
  }
  const candidate = await realpath(resolve(root, ...normalized.split("/")));
  if (!isInside(candidate, root))
    throw new Error("LSP mirror path escaped the source root");
  return candidate;
}

async function workspaceUriRelative(
  sourceRoot: string,
  uri: string,
  allowedPaths: Set<string>,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "file:" ||
    (url.hostname && url.hostname !== "localhost")
  )
    return null;
  try {
    const candidate = await realpath(fileURLToPath(url));
    if (!isInside(candidate, sourceRoot)) return null;
    const relativePath = relative(sourceRoot, candidate).split(sep).join("/");
    return allowedPaths.has(relativePath) ? relativePath : null;
  } catch {
    return null;
  }
}

function parseWorkerRequest(value: unknown): WorkerRequest {
  if (!isRecord(value)) throw new Error("LSP worker request must be an object");
  const request: WorkerRequest = {
    language: String(value.language ?? ""),
    projectRoot:
      typeof value.projectRoot === "string" ? value.projectRoot : undefined,
    serverCommand: Array.isArray(value.serverCommand)
      ? value.serverCommand.map(String)
      : [],
    sourceRoot: String(value.sourceRoot ?? ""),
    files: Array.isArray(value.files) ? value.files.map(String) : [],
    workspaceFiles: Array.isArray(value.workspaceFiles)
      ? value.workspaceFiles.map(String)
      : [],
    requestTimeoutMs: Number(value.requestTimeoutMs),
    maxSymbols: Number(value.maxSymbols),
    maxRelations: Number(value.maxRelations),
    totalBudgetMs:
      typeof value.totalBudgetMs === "number" ? value.totalBudgetMs : undefined,
    concurrency:
      typeof value.concurrency === "number" ? value.concurrency : undefined,
  };
  validateWorkerRequest(request);
  return request;
}

function validateWorkerRequest(request: WorkerRequest): void {
  if (
    request.totalBudgetMs !== undefined &&
    (!Number.isFinite(request.totalBudgetMs) ||
      request.totalBudgetMs < 1 ||
      request.totalBudgetMs > 110000)
  )
    throw new Error("invalid LSP total budget");
  if (!request.language || request.language.length > 100)
    throw new Error("invalid LSP language");
  if (!request.serverCommand.length || request.serverCommand.length > 20)
    throw new Error("invalid LSP server command");
  if (!isAbsolute(request.sourceRoot))
    throw new Error("LSP source root must be absolute");
  if (!request.files.length || request.files.length > 30_000)
    throw new Error("invalid LSP file list");
  if (!request.workspaceFiles.length || request.workspaceFiles.length > 30_000)
    throw new Error("invalid LSP workspace file list");
  const workspace = new Set(request.workspaceFiles);
  if (
    workspace.size !== request.workspaceFiles.length ||
    request.files.some((path) => !workspace.has(path))
  ) {
    throw new Error("LSP targets must be inside the workspace file list");
  }
  if (
    !Number.isFinite(request.requestTimeoutMs) ||
    request.requestTimeoutMs <= 0 ||
    request.requestTimeoutMs > 120_000
  )
    throw new Error("invalid LSP timeout");
  if (!Number.isInteger(request.maxSymbols) || request.maxSymbols <= 0)
    throw new Error("invalid LSP symbol limit");
  if (!Number.isInteger(request.maxRelations) || request.maxRelations <= 0)
    throw new Error("invalid LSP relation limit");
}

function dedupeSymbols(symbols: LspSymbolFact[]): LspSymbolFact[] {
  const rows = new Map<string, LspSymbolFact>();
  for (const symbol of symbols) {
    const key = [
      symbol.path,
      symbol.qualifiedName,
      symbol.startLine,
      symbol.startColumn,
    ].join("|");
    if (!rows.has(key)) rows.set(key, symbol);
  }
  return [...rows.values()];
}

function dedupeRelations(relations: LspRelationFact[]): LspRelationFact[] {
  const rows = new Map<string, LspRelationFact>();
  for (const relation of relations) {
    const key = [
      relation.kind,
      relation.sourcePath,
      relation.sourceName,
      relation.sourceLine,
      relation.sourceColumn,
      relation.targetPath,
      relation.targetName,
      relation.targetLine,
      relation.targetColumn,
    ].join("|");
    if (!rows.has(key)) rows.set(key, relation);
  }
  return [...rows.values()];
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 200) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isInside(candidate: string, parent: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("process exit timed out")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
