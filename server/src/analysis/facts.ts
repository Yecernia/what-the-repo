import { createHash } from "node:crypto";

export type FactSymbolKind =
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "function"
  | "method"
  | "constructor"
  | "variable";

export type StaticRelationKind = "imports" | "calls" | "inherits" | "implements";

export interface StaticSymbolFact {
  stableId: string;
  name: string;
  qualifiedName: string;
  kind: FactSymbolKind;
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  parameterCount: number | null;
  implicitReceiverCount: number;
  bases: string[];
  sources: Array<"tree_sitter" | "lsp">;
}

export interface ParsedImport {
  source: string;
  line: number;
  resolvedPath?: string | null;
  typeOnly?: boolean;
}

export interface ParsedCallSite {
  callerStableId: string | null;
  callee: string;
  argumentCount: number | null;
  line: number;
  column: number;
  /** Explicit declaration binding; null means unresolved, never a name-based fallback. */
  target?: { path: string; line: number; column: number; symbolId?: string } | null;
}

export interface ParsedFile {
  path: string;
  language: string;
  bytes: number;
  digest: string;
  symbols: StaticSymbolFact[];
  imports: ParsedImport[];
  calls: ParsedCallSite[];
  parseError: string | null;
  relationBinding?: "typescript";
}

export interface SourceFileManifest {
  path: string;
  bytes: number;
  digest: string;
}

export interface LspSymbolFact {
  path: string;
  name: string;
  qualifiedName: string;
  kind: FactSymbolKind;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export interface LspRelationFact {
  kind: Extract<StaticRelationKind, "calls" | "inherits" | "implements">;
  sourcePath: string;
  sourceName: string;
  sourceLine: number;
  sourceColumn: number;
  targetPath: string;
  targetName: string;
  targetLine: number;
  targetColumn: number;
}

export interface LspRunResult {
  language: string;
  completed: boolean;
  truthVerified: boolean;
  serverName: string | null;
  serverVersion: string | null;
  capabilities: string[];
  reasonCodes: string[];
  symbols: LspSymbolFact[];
  relations: LspRelationFact[];
}

export function stableDigest(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function symbolStableId(
  path: string,
  qualifiedName: string,
  kind: FactSymbolKind,
): string {
  return `fact:symbol:${stableDigest(`${path}:${qualifiedName}:${kind}`)}`;
}

export function unavailableLspResult(language: string, ...reasonCodes: string[]): LspRunResult {
  return {
    language,
    completed: false,
    truthVerified: false,
    serverName: null,
    serverVersion: null,
    capabilities: [],
    reasonCodes: [...new Set(reasonCodes.length ? reasonCodes : ["lsp_unavailable"])],
    symbols: [],
    relations: [],
  };
}
