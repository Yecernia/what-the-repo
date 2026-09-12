import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type FactSymbolKind,
  type LspRelationFact,
  type LspRunResult,
  type LspSymbolFact,
  unavailableLspResult,
} from "./facts.js";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;

interface WorkerRequest {
  language: string;
  serverCommand: string[];
  sourceRoot: string;
  files: string[];
  workspaceFiles: string[];
  requestTimeoutMs: number;
  maxSymbols: number;
  maxRelations: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LspMethodError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "LspMethodError";
  }
}

export class LspSession {
  private process: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  serverInfo: Record<string, unknown> = {};

  constructor(
    private readonly command: string[],
    private readonly root: string,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    if (!this.command.length || !isAbsolute(this.command[0] as string)) {
      throw new Error("LSP executable must be an absolute regular file");
    }
    const executableInfo = await lstat(this.command[0] as string);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
      throw new Error("LSP executable must be an absolute regular file");
    }
    const child = spawn(this.command[0] as string, this.command.slice(1), {
      cwd: this.root,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.process = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", () => this.rejectAll(new Error("LSP server exited before replying")));
    const rootUri = pathToFileURL(this.root).href;
    const initialized = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).at(-1) ?? "source" }],
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: {},
          references: {},
          callHierarchy: {},
          typeHierarchy: {},
        },
      },
      initializationOptions: {},
    });
    if (isRecord(initialized) && isRecord(initialized.serverInfo)) this.serverInfo = initialized.serverInfo;
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    if (child.exitCode === null && !child.killed) {
      try {
        await this.request("shutdown", null, Math.min(3_000, this.timeoutMs));
        this.notify("exit", null);
        await waitForExit(child, 2_000);
      } catch {
        child.kill();
        await waitForExit(child, 2_000).catch(() => undefined);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    this.rejectAll(new Error("LSP session closed"));
    this.process = null;
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

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    this.requestId += 1;
    const id = this.requestId;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
  }

  async optionalRequest(method: string, params: unknown): Promise<unknown | null> {
    try {
      return await this.request(method, params);
    } catch (error) {
      if (error instanceof LspMethodError || String((error as Error).message).startsWith("LSP request timed out")) return null;
      throw error;
    }
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("LSP server is not running");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdin.write(Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"));
    stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_MESSAGE_BYTES * 2) {
      this.rejectAll(new Error("LSP response buffer limit exceeded"));
      this.process?.kill();
      return;
    }
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      const length = Number(match?.[1] ?? 0);
      if (!Number.isInteger(length) || length <= 0 || length > MAX_MESSAGE_BYTES) {
        this.rejectAll(new Error("invalid LSP content length"));
        this.process?.kill();
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        const message = JSON.parse(body.toString("utf8")) as unknown;
        if (isRecord(message)) this.routeMessage(message);
      } catch {
        this.rejectAll(new Error("invalid LSP JSON response"));
        this.process?.kill();
        return;
      }
    }
  }

  private routeMessage(message: Record<string, unknown>): void {
    if (message.id !== undefined && typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: serverRequestResult(message.method, message.params),
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(new LspMethodError(Number(message.error.code ?? 0), String(message.error.message ?? "LSP error")));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function analyzeLspRequest(request: WorkerRequest): Promise<LspRunResult> {
  validateWorkerRequest(request);
  const sourceRoot = await realpath(request.sourceRoot);
  const allowedPaths = new Set(request.workspaceFiles);
  const documents: Array<{ relativePath: string; path: string; content: string }> = [];
  for (const relativePath of request.files) {
    const path = await safeSourcePath(sourceRoot, relativePath);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_FILE_BYTES) throw new Error("unsafe LSP mirror file");
    documents.push({ relativePath, path, content: (await readFile(path)).toString("utf8") });
  }

  const symbols: LspSymbolFact[] = [];
  const relations: LspRelationFact[] = [];
  const capabilities: string[] = [];
  const reasonCodes: string[] = [];
  const session = new LspSession(request.serverCommand, sourceRoot, request.requestTimeoutMs);
  try {
    await session.start();
    for (const document of documents) session.openDocument(document.path, request.language, document.content);
    await sleep(50);

    const rawSymbols: Array<{ symbol: LspSymbolFact; raw: Record<string, unknown> }> = [];
    for (const document of documents) {
      const response = await session.optionalRequest("textDocument/documentSymbol", {
        textDocument: { uri: pathToFileURL(document.path).href },
      });
      if (!Array.isArray(response)) continue;
      rawSymbols.push(...await flattenSymbols(
        response,
        document.relativePath,
        sourceRoot,
        allowedPaths,
        [],
      ));
      if (rawSymbols.length > request.maxSymbols) return unavailableLspResult(request.language, "lsp_symbol_limit_exceeded");
    }
    symbols.push(...rawSymbols.map((item) => item.symbol));
    if (symbols.length) capabilities.push("document_symbols");

    let callSupported = false;
    let typeSupported = false;
    for (const { symbol } of rawSymbols) {
      const document = {
        textDocument: { uri: pathToFileURL(resolve(sourceRoot, ...symbol.path.split("/"))).href },
        position: { line: symbol.startLine - 1, character: symbol.startColumn },
      };
      const preparedCalls = await session.optionalRequest("textDocument/prepareCallHierarchy", document);
      if (Array.isArray(preparedCalls)) {
        callSupported = true;
        const item = preparedCalls[0];
        if (item !== undefined) {
          const outgoing = await session.optionalRequest("callHierarchy/outgoingCalls", { item });
          if (Array.isArray(outgoing)) relations.push(...await callRelations(sourceRoot, symbol, outgoing, allowedPaths));
        }
      }
      if (["class", "interface", "struct"].includes(symbol.kind)) {
        const preparedTypes = await session.optionalRequest("textDocument/prepareTypeHierarchy", document);
        if (Array.isArray(preparedTypes)) {
          typeSupported = true;
          const item = preparedTypes[0];
          if (item !== undefined) {
            const supertypes = await session.optionalRequest("typeHierarchy/supertypes", { item });
            if (Array.isArray(supertypes)) relations.push(...await typeRelations(sourceRoot, symbol, supertypes, allowedPaths));
          }
        }
      }
      if (relations.length > request.maxRelations) return unavailableLspResult(request.language, "lsp_relation_limit_exceeded");
    }
    if (callSupported) capabilities.push("call_hierarchy"); else reasonCodes.push("call_hierarchy_unavailable");
    if (typeSupported) capabilities.push("type_hierarchy"); else reasonCodes.push("type_hierarchy_unavailable");

    return {
      language: request.language,
      completed: symbols.length > 0,
      truthVerified: false,
      serverName: optionalText(session.serverInfo.name),
      serverVersion: optionalText(session.serverInfo.version),
      capabilities,
      reasonCodes: [...new Set(reasonCodes)],
      symbols: dedupeSymbols(symbols),
      relations: dedupeRelations(relations),
    };
  } finally {
    await session.close();
  }
}

export async function runLspWorkerCli(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 2) return 2;
  const requestPath = resolve(argv[0] as string);
  const resultPath = resolve(argv[1] as string);
  let language = "unknown";
  let result: LspRunResult;
  try {
    const request = parseWorkerRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
    language = request.language;
    const requestRoot = await realpath(dirname(requestPath));
    const sourceRoot = await realpath(request.sourceRoot);
    if (!isInside(sourceRoot, requestRoot)) throw new Error("LSP source mirror escaped the run root");
    result = await analyzeLspRequest(request);
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
  const result: Array<{ symbol: LspSymbolFact; raw: Record<string, unknown> }> = [];
  for (const value of rawSymbols) {
    if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) continue;
    let rawRange = value.selectionRange ?? value.range;
    if (isRecord(value.location)) {
      if (typeof value.location.uri !== "string") continue;
      if (await workspaceUriRelative(sourceRoot, value.location.uri, allowedPaths) !== relativePath) continue;
      rawRange = value.location.range ?? rawRange;
    }
    const range = parseRange(rawRange);
    const kind = nodeKind(value.kind);
    if (!range || !kind) continue;
    const symbol: LspSymbolFact = {
      path: relativePath,
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
      result.push(...await flattenSymbols(
        value.children,
        relativePath,
        sourceRoot,
        allowedPaths,
        [...parentNames, value.name],
      ));
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
    let sourceLine = source.startLine;
    let sourceColumn = source.startColumn;
    if (Array.isArray(value.fromRanges) && value.fromRanges.length) {
      const range = parseRange(value.fromRanges[0]);
      if (range) {
        sourceLine = range.startLine;
        sourceColumn = range.startColumn;
      }
    }
    result.push({
      kind: "calls",
      sourcePath: source.path,
      sourceName: source.qualifiedName,
      sourceLine,
      sourceColumn,
      targetPath: target.path,
      targetName: target.name,
      targetLine: target.line,
      targetColumn: target.column,
    });
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
      kind: "inherits",
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
): Promise<{ path: string; name: string; line: number; column: number } | null> {
  if (typeof value.name !== "string" || typeof value.uri !== "string") return null;
  const range = parseRange(value.selectionRange ?? value.range);
  if (!range) return null;
  const path = await workspaceUriRelative(sourceRoot, value.uri, allowedPaths);
  return path ? { path, name: value.name, line: range.startLine, column: range.startColumn } : null;
}

function parseRange(value: unknown): {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
} | null {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return null;
  const startLine = Number(value.start.line) + 1;
  const endLine = Number(value.end.line) + 1;
  const startColumn = Number(value.start.character);
  const endColumn = Number(value.end.character);
  if (![startLine, endLine, startColumn, endColumn].every(Number.isInteger)) return null;
  if (Math.min(startLine, endLine) < 1 || Math.min(startColumn, endColumn) < 0) return null;
  return { startLine, endLine, startColumn, endColumn };
}

function nodeKind(value: unknown): FactSymbolKind | null {
  const kind = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(kind)) return null;
  return new Map<number, FactSymbolKind>([
    [5, "class"],
    [6, "method"],
    [9, "constructor"],
    [10, "enum"],
    [11, "interface"],
    [12, "function"],
    [13, "variable"],
    [23, "struct"],
  ]).get(kind) ?? null;
}

async function safeSourcePath(root: string, relativePath: string): Promise<string> {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe LSP mirror path");
  }
  const candidate = await realpath(resolve(root, ...normalized.split("/")));
  if (!isInside(candidate, root)) throw new Error("LSP mirror path escaped the source root");
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
  if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
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
    serverCommand: Array.isArray(value.serverCommand) ? value.serverCommand.map(String) : [],
    sourceRoot: String(value.sourceRoot ?? ""),
    files: Array.isArray(value.files) ? value.files.map(String) : [],
    workspaceFiles: Array.isArray(value.workspaceFiles) ? value.workspaceFiles.map(String) : [],
    requestTimeoutMs: Number(value.requestTimeoutMs),
    maxSymbols: Number(value.maxSymbols),
    maxRelations: Number(value.maxRelations),
  };
  validateWorkerRequest(request);
  return request;
}

function validateWorkerRequest(request: WorkerRequest): void {
  if (!request.language || request.language.length > 100) throw new Error("invalid LSP language");
  if (!request.serverCommand.length || request.serverCommand.length > 20) throw new Error("invalid LSP server command");
  if (!isAbsolute(request.sourceRoot)) throw new Error("LSP source root must be absolute");
  if (!request.files.length || request.files.length > 30_000) throw new Error("invalid LSP file list");
  if (!request.workspaceFiles.length || request.workspaceFiles.length > 30_000) throw new Error("invalid LSP workspace file list");
  const workspace = new Set(request.workspaceFiles);
  if (workspace.size !== request.workspaceFiles.length || request.files.some((path) => !workspace.has(path))) {
    throw new Error("LSP targets must be inside the workspace file list");
  }
  if (!Number.isFinite(request.requestTimeoutMs) || request.requestTimeoutMs <= 0 || request.requestTimeoutMs > 120_000) throw new Error("invalid LSP timeout");
  if (!Number.isInteger(request.maxSymbols) || request.maxSymbols <= 0) throw new Error("invalid LSP symbol limit");
  if (!Number.isInteger(request.maxRelations) || request.maxRelations <= 0) throw new Error("invalid LSP relation limit");
}

function serverRequestResult(method: string, params: unknown): unknown {
  if (method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)) {
    return params.items.map(() => null);
  }
  if (method === "workspace/workspaceFolders") return [];
  return null;
}

function dedupeSymbols(symbols: LspSymbolFact[]): LspSymbolFact[] {
  const rows = new Map<string, LspSymbolFact>();
  for (const symbol of symbols) {
    const key = [symbol.path, symbol.qualifiedName, symbol.startLine, symbol.startColumn].join("|");
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
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("process exit timed out")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
