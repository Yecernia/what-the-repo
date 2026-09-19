import { createHash } from "node:crypto";

export type FactSymbolKind =
  | "class"
  | "interface"
  | "type_alias"
  | "struct"
  | "enum"
  | "function"
  | "method"
  | "constructor"
  | "accessor"
  | "namespace"
  | "variable";

export type StaticRelationKind =
  | "imports"
  | "type_imports"
  | "reexports"
  | "dynamic_imports"
  | "calls"
  | "inherits"
  | "implements"
  | "supertype";

export const STATIC_KERNEL_VERSION = "project-facts-v1";
/** One-based lines, zero-based UTF-16 columns, half-open ranges throughout. */
export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
export interface DeclarationSite {
  id: string;
  path: string;
  range: SourceRange;
  selection: SourceRange;
  role: "declaration" | "definition";
  valid: boolean;
}
export interface AnalysisDiagnostic {
  code: string;
  message?: string;
  range?: SourceRange;
}
export type BindingStatus =
  | "static"
  | "candidate"
  | "external"
  | "standard_library"
  | "missing_dependency"
  | "unresolved";
export interface ProjectContext {
  id: string;
  root: string;
  configPath: string | null;
  configDigest: string;
  language: string;
  inferred: boolean;
  files: string[];
  references: string[];
  diagnostics: AnalysisDiagnostic[];
}
export interface SourceCompleteness {
  inventoryComplete: boolean;
  knownSourceFiles: number;
  omitted: Array<{ path: string; reason: string }>;
  reasons: string[];
}

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
  sources: Array<"tree_sitter" | "lsp" | "typescript">;
  /** Entity identity is distinct from declaration sites and cross-version matching. */
  trackingKey?: string;
  scopeId?: string | null;
  declarations?: DeclarationSite[];
  valid?: boolean;
}

export interface ParsedImport {
  source: string;
  line: number;
  resolvedPath?: string | null;
  typeOnly?: boolean;
  kind?: "imports" | "type_imports" | "reexports" | "dynamic_imports";
  status?: BindingStatus;
  column?: number;
  range?: SourceRange;
  /** Missing lookups are invalidated against the complete snapshot path domain. */
  resolutionDomain?: string;
}

export interface ParsedCallSite {
  callerStableId: string | null;
  callee: string;
  argumentCount: number | null;
  line: number;
  column: number;
  /** Explicit declaration binding; null means unresolved, never a name-based fallback. */
  target?: {
    path: string;
    line: number;
    column: number;
    symbolId?: string;
  } | null;
  id?: string;
  range?: SourceRange;
  status?: BindingStatus;
  meaning?: "implementation" | "declaration" | "dynamic_dispatch" | "syntax";
  candidates?: string[];
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
  role?:
    | "source"
    | "declaration"
    | "config"
    | "documentation"
    | "text"
    | "generated"
    | "dependency"
    | "binary";
  encoding?: "utf8" | "invalid_utf8" | "binary";
  diagnostics?: AnalysisDiagnostic[];
  syntaxKey?: string;
  semanticKey?: string;
  semanticInputs?: string[];
  semanticComplete?: boolean;
  project?: ProjectContext;
  parser?: { name: string; version: string };
  exports?: Array<{ name: string; entityId: string | null; typeOnly: boolean }>;
  unresolvedHeritage?: Array<{
    sourceId: string;
    name: string;
    kind: "inherits" | "implements" | "supertype";
    range: SourceRange;
  }>;
  heritage?: Array<{
    sourceId: string;
    targetId: string;
    kind: "inherits" | "implements";
    range: SourceRange;
    status?: BindingStatus;
  }>;
}

export interface SourceFileManifest {
  path: string;
  bytes: number;
  digest: string;
  role?: ParsedFile["role"];
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
  selection?: SourceRange;
  hierarchy?: "lexical" | "flat";
}

export interface LspRelationFact {
  kind: Extract<
    StaticRelationKind,
    "calls" | "inherits" | "implements" | "supertype"
  >;
  sourcePath: string;
  sourceName: string;
  sourceLine: number;
  sourceColumn: number;
  targetPath: string;
  targetName: string;
  targetLine: number;
  targetColumn: number;
  sourceSelection?: SourceRange;
  range?: SourceRange;
}

export interface LspRunResult {
  language: string;
  projectId?: string;
  inputIdentity?: string;
  completed: boolean;
  toolchainVerified: boolean;
  serverName: string | null;
  serverVersion: string | null;
  capabilities: string[];
  reasonCodes: string[];
  workspaceDiagnostics?: Array<{
    severity: "error" | "warning";
    message: string;
  }>;
  symbols: LspSymbolFact[];
  relations: LspRelationFact[];
  coverage?: {
    filesRequested: number;
    filesCompleted: string[];
    targetsRequested: number;
    targetsCompleted: number;
    requests: number;
    failures: Record<string, number>;
    targets?: Array<{
      path: string;
      line: number;
      column: number;
      kind: "call_hierarchy" | "type_hierarchy";
      status: "pending" | "completed" | "failed";
    }>;
  };
}

export function stableDigest(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function symbolStableId(
  path: string,
  qualifiedName: string,
  kind: FactSymbolKind,
  discriminator = "",
): string {
  return `fact:symbol:${stableDigest(`${path}:${qualifiedName}:${kind}:${discriminator}`)}`;
}

export function unavailableLspResult(
  language: string,
  ...reasonCodes: string[]
): LspRunResult {
  return {
    language,
    completed: false,
    toolchainVerified: false,
    serverName: null,
    serverVersion: null,
    capabilities: [],
    reasonCodes: [
      ...new Set(reasonCodes.length ? reasonCodes : ["lsp_unavailable"]),
    ],
    symbols: [],
    relations: [],
  };
}
