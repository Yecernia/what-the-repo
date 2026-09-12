import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import {
  type FactSymbolKind,
  type ParsedCallSite,
  type ParsedFile,
  type ParsedImport,
  type StaticSymbolFact,
  symbolStableId,
} from "./facts.js";
import { languageForPath, LANGUAGE_SPECS, type LanguageSpec } from "./languages.js";

const require = createRequire(import.meta.url);
const ignoredCallNames = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "require",
  "print",
]);

export type {
  ParsedCallSite as ParsedCall,
  ParsedFile,
  ParsedImport,
  StaticSymbolFact as ParsedSymbol,
} from "./facts.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstIdentifier(node: Node): string | null {
  if ([
    "identifier",
    "type_identifier",
    "property_identifier",
    "field_identifier",
    "name",
  ].includes(node.type)) {
    const value = node.text.trim();
    return /^[A-Za-z_$][\w$]*$/.test(value) ? value : null;
  }
  for (const child of node.namedChildren) {
    const value = firstIdentifier(child);
    if (value) return value;
  }
  return null;
}

function nameFromNode(node: Node): string | null {
  for (const field of ["name", "declarator", "type", "left"]) {
    const candidate = node.childForFieldName(field);
    if (!candidate) continue;
    const value = firstIdentifier(candidate);
    if (value) return value;
  }
  return firstIdentifier(node);
}

function symbolKind(node: Node): FactSymbolKind | null {
  const type = node.type;
  if (type.includes("constructor")) return "constructor";
  if (type.includes("interface") || type === "trait_item" || type === "type_alias_declaration") return "interface";
  if (type.includes("struct") || type === "record_declaration") return "struct";
  if (type.includes("enum")) return "enum";
  if (type.includes("class")) return "class";
  if (type.includes("method")) return "method";
  if (type.includes("function")) return "function";
  if (type === "type_spec") return "struct";
  return null;
}

function regexImports(source: string, language: string): ParsedImport[] {
  const patterns: RegExp[] = language === "python"
    ? [/^\s*(?:from\s+([^\s]+)\s+import|import\s+([^\s#]+))/gm]
    : language === "go"
      ? [/^\s*(?:import\s+)?(?:[\w_.]+\s+)?["']([^"']+)["']/gm]
      : [
          /\bimport\s+(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/g,
          /\b(?:from|require\s*\()\s*["']([^"']+)["']/g,
          /#include\s*[<"]([^>"]+)[>"]/g,
          /\b(?:use|mod)\s+([A-Za-z0-9_:]+)/g,
          /^\s*(?:using|import)\s+([A-Za-z0-9_.\\]+)/gm,
        ];
  const rows: ParsedImport[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match.slice(1).find(Boolean);
      if (!value) continue;
      const prefix = source.slice(0, match.index ?? 0);
      rows.push({ source: value, line: prefix.split("\n").length });
    }
  }
  return rows.filter((row, index, all) => all.findIndex(
    (candidate) => candidate.source === row.source && candidate.line === row.line,
  ) === index);
}

function regexCalls(source: string): ParsedCallSite[] {
  const rows: ParsedCallSite[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(([^()]*)\)/g;
  for (const match of source.matchAll(pattern)) {
    const callee = match[1];
    if (!callee || ignoredCallNames.has(callee)) continue;
    const prefix = source.slice(0, match.index ?? 0);
    const line = prefix.split("\n").length;
    const lineStart = prefix.lastIndexOf("\n") + 1;
    const rawArguments = match[2]?.trim() ?? "";
    rows.push({
      callerStableId: null,
      callee,
      argumentCount: rawArguments ? rawArguments.split(",").length : 0,
      line,
      column: (match.index ?? 0) - lineStart,
    });
  }
  return rows;
}

function parameterCount(node: Node): number | null {
  let parameters = node.childForFieldName("parameters");
  if (!parameters) {
    parameters = node.namedChildren.find((child) => [
      "parameters",
      "formal_parameters",
      "parameter_list",
    ].includes(child.type)) ?? null;
  }
  if (!parameters) return null;
  return parameters.namedChildren.filter((child) => child.type !== "comment").length;
}

function basesFromNode(node: Node): string[] {
  const header = node.text.split(/\r?\n/, 3).join(" ");
  const result: string[] = [];
  const patterns = [
    /\bextends\s+([\w.$]+)/g,
    /\bimplements\s+([\w.$, <>]+)/g,
    /\bclass\s+\w+\s*\(([^)]*)\)/g,
    /\b(?:class|struct|interface)\s+\w+\s*:\s*([^\{]+)/g,
    /\bimpl(?:<[^>]+>)?\s+([\w:]+)\s+for\s+[\w:]+/g,
  ];
  for (const pattern of patterns) {
    for (const match of header.matchAll(pattern)) {
      for (const raw of (match[1] ?? "").split(",")) {
        const value = raw
          .trim()
          .replace(/^(public|private|protected)\s+/, "")
          .split("<", 1)[0]
          ?.split("::")
          .at(-1)
          ?.split(".")
          .at(-1)
          ?.trim();
        if (value && /^[A-Za-z_$][\w$]*$/.test(value) && !result.includes(value)) result.push(value);
      }
    }
  }
  return result;
}

function calleeName(node: Node): string | null {
  for (const field of ["function", "name", "method"]) {
    const candidate = node.childForFieldName(field);
    if (candidate) {
      const value = candidate.text.trim();
      if (value) return value;
    }
  }
  const candidate = node.namedChildren.find((child) => [
    "identifier",
    "field_expression",
    "member_expression",
    "scoped_identifier",
  ].includes(child.type));
  return candidate?.text.trim() ?? null;
}

function callArgumentCount(node: Node): number | null {
  let argumentsNode = node.childForFieldName("arguments");
  if (!argumentsNode) {
    argumentsNode = node.namedChildren.find((child) => [
      "argument_list",
      "arguments",
      "value_arguments",
    ].includes(child.type)) ?? null;
  }
  return argumentsNode
    ? argumentsNode.namedChildren.filter((child) => child.type !== "comment").length
    : null;
}

function collectFacts(root: Node, relativePath: string, language: string, spec: LanguageSpec): {
  symbols: StaticSymbolFact[];
  calls: ParsedCallSite[];
} {
  const symbols: StaticSymbolFact[] = [];
  const calls: ParsedCallSite[] = [];

  const visit = (node: Node, parents: StaticSymbolFact[]): void => {
    let scope = parents;
    if (spec.declarationTypes.has(node.type)) {
      const name = nameFromNode(node);
      const kind = symbolKind(node);
      if (name && kind) {
        const qualifiedName = [...parents.map((parent) => parent.name), name].join(".");
        const count = parameterCount(node);
        const parent = parents.at(-1);
        const implicitReceiverCount = language === "python"
          && Boolean(parent && ["class", "interface", "struct"].includes(parent.kind))
          && Boolean(count && count > 0)
          ? 1
          : 0;
        const symbol: StaticSymbolFact = {
          stableId: symbolStableId(relativePath, qualifiedName, kind),
          name,
          qualifiedName,
          kind,
          path: relativePath,
          language,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          parameterCount: count,
          implicitReceiverCount,
          bases: basesFromNode(node),
          sources: ["tree_sitter"],
        };
        symbols.push(symbol);
        scope = [...parents, symbol];
      }
    }
    if (spec.callTypes.has(node.type)) {
      const callee = calleeName(node);
      if (callee && !ignoredCallNames.has(callee)) {
        calls.push({
          callerStableId: scope.at(-1)?.stableId ?? null,
          callee,
          argumentCount: callArgumentCount(node),
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
    for (const child of node.namedChildren) visit(child, scope);
  };

  visit(root, []);
  return {
    symbols: symbols.filter((row, index, all) => all.findIndex(
      (candidate) => candidate.stableId === row.stableId,
    ) === index),
    calls,
  };
}

export class TreeSitterAnalyzer {
  private initialized = false;
  private readonly languages = new Map<string, Language>();
  private readonly parsers = new Map<string, Parser>();

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    await Promise.all(LANGUAGE_SPECS.map(async (spec) => {
      try {
        const grammarPath = require.resolve(`${spec.grammarPackage}/${spec.grammarFile}`);
        this.languages.set(spec.id, await Language.load(grammarPath));
        if (spec.id === "typescript") {
          try {
            this.languages.set(
              "tsx",
              await Language.load(require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm")),
            );
          } catch {
            // TSX remains explicitly degraded when its grammar is unavailable.
          }
        }
      } catch {
        // A missing grammar marks only that language unavailable.
      }
    }));
    this.initialized = true;
  }

  grammarAvailable(language: string): boolean {
    return this.languages.has(language);
  }

  private parserFor(path: string): { parser: Parser; spec: LanguageSpec } | null {
    const spec = languageForPath(path);
    if (!spec) return null;
    const key = path.toLowerCase().endsWith(".tsx") ? "tsx" : spec.id;
    const language = this.languages.get(key);
    if (!language) return null;
    let parser = this.parsers.get(key);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(language);
      this.parsers.set(key, parser);
    }
    return { parser, spec };
  }

  async analyzeFile(root: string, relativePath: string, signal?: AbortSignal): Promise<ParsedFile> {
    signal?.throwIfAborted();
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "..")) {
      throw new Error("unsafe_analysis_path");
    }
    const absolute = resolve(root, ...normalized.split("/"));
    const raw = await readFile(absolute);
    signal?.throwIfAborted();
    const text = raw.toString("utf8");
    const spec = languageForPath(normalized);
    const base: ParsedFile = {
      path: normalized,
      language: spec?.id ?? "unknown",
      bytes: raw.byteLength,
      digest: digest(text),
      symbols: [],
      imports: spec ? regexImports(text, spec.id) : [],
      calls: [],
      parseError: null,
    };
    // Documentation remains file evidence, never executable call/import evidence.
    if (!spec) return base;
    const target = this.parserFor(normalized);
    signal?.throwIfAborted();
    if (!target) {
      return { ...base, calls: regexCalls(text), parseError: "tree_sitter_grammar_unavailable" };
    }
    try {
      const tree = target.parser.parse(text);
      if (!tree) return { ...base, calls: regexCalls(text), parseError: "tree_parse_empty" };
      try {
        signal?.throwIfAborted();
        const facts = collectFacts(tree.rootNode, normalized, target.spec.id, target.spec);
        signal?.throwIfAborted();
        return { ...base, symbols: facts.symbols, calls: facts.calls };
      } finally {
        tree.delete();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ...base,
        calls: regexCalls(text),
        parseError: error instanceof Error ? error.name : "tree_parse_failed",
      };
    }
  }
}
