import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import {
  type FactSymbolKind,
  type ParsedFile,
  type SourceRange,
  type StaticSymbolFact,
  stableDigest,
  symbolStableId,
} from "./facts.js";
import { languageForPath } from "./languages.js";
import { decodeSource, readSnapshotFile } from "./source-input.js";
import { extractTypeScriptSyntax } from "./typescript.js";
import { bindPythonSyntax } from "./python-syntax.js";
import { syntaxToolchain } from "./toolchain.js";
export type {
  ParsedCallSite as ParsedCall,
  ParsedFile,
  ParsedImport,
  StaticSymbolFact as ParsedSymbol,
} from "./facts.js";
const require = createRequire(import.meta.url);
type Rules = {
  declarations: Record<string, FactSymbolKind>;
  scopes: string[];
  imports: string[];
  calls: string[];
};
/** Grammar-specific nodes; source-text regular expressions never invent facts. */
const rules: Record<string, Rules> = {
  python: {
    declarations: {
      class_definition: "class",
      function_definition: "function",
      lambda: "function",
    },
    scopes: [],
    imports: ["import_statement", "import_from_statement"],
    calls: ["call"],
  },
  go: {
    declarations: {
      type_spec: "struct",
      function_declaration: "function",
      method_declaration: "method",
      func_literal: "function",
    },
    scopes: [],
    imports: ["import_spec"],
    calls: ["call_expression"],
  },
  java: {
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "struct",
      method_declaration: "method",
      constructor_declaration: "constructor",
      lambda_expression: "function",
    },
    scopes: [],
    imports: ["import_declaration"],
    calls: [
      "method_invocation",
      "object_creation_expression",
      "explicit_constructor_invocation",
    ],
  },
  rust: {
    declarations: {
      struct_item: "struct",
      enum_item: "enum",
      trait_item: "interface",
      function_item: "function",
      function_signature_item: "function",
      closure_expression: "function",
      mod_item: "namespace",
    },
    scopes: ["impl_item"],
    imports: ["use_declaration", "extern_crate_declaration", "mod_item"],
    calls: ["call_expression"],
  },
  php: {
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "interface",
      function_definition: "function",
      method_declaration: "method",
      anonymous_function: "function",
      arrow_function: "function",
      namespace_definition: "namespace",
    },
    scopes: [],
    imports: [
      "namespace_use_declaration",
      "include_expression",
      "require_expression",
      "include_once_expression",
      "require_once_expression",
    ],
    calls: [
      "function_call_expression",
      "member_call_expression",
      "scoped_call_expression",
      "object_creation_expression",
      "nullsafe_member_call_expression",
    ],
  },
  csharp: {
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      struct_declaration: "struct",
      record_declaration: "struct",
      enum_declaration: "enum",
      method_declaration: "method",
      constructor_declaration: "constructor",
      local_function_statement: "function",
      lambda_expression: "function",
      anonymous_method_expression: "function",
      accessor_declaration: "accessor",
      namespace_declaration: "namespace",
      file_scoped_namespace_declaration: "namespace",
    },
    scopes: [],
    imports: ["using_directive"],
    calls: ["invocation_expression", "object_creation_expression"],
  },
  cpp: {
    declarations: {
      class_specifier: "class",
      struct_specifier: "struct",
      enum_specifier: "enum",
      function_definition: "function",
      lambda_expression: "function",
      namespace_definition: "namespace",
    },
    scopes: [],
    imports: ["preproc_include"],
    calls: ["call_expression", "new_expression"],
  },
};
const range = (node: Node): SourceRange => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
const field = (node: Node, ...names: string[]): Node | null =>
  names.map((n) => node.childForFieldName(n)).find(Boolean) ?? null;
function declaratorName(node: Node): Node | null {
  if (
    [
      "identifier",
      "field_identifier",
      "type_identifier",
      "name",
      "operator_name",
      "destructor_name",
      "qualified_identifier",
    ].includes(node.type)
  )
    return node;
  const nested = field(node, "declarator", "name");
  return nested ? declaratorName(nested) : null;
}
function importSources(node: Node, language: string): string[] {
  if (language === "python") {
    const from = field(node, "module_name");
    if (from) return [from.text];
    return node.namedChildren
      .filter((c) => ["dotted_name", "aliased_import"].includes(c.type))
      .map((c) => (field(c, "name") ?? c).text);
  }
  if (language === "rust" && node.type === "mod_item" && field(node, "body"))
    return [];
  const path = field(node, "path", "source", "argument", "name");
  return (
    path
      ? [path]
      : node.namedChildren.filter((c) => !["comment", "block"].includes(c.type))
  )
    .map((c) => c.text.replace(/^["'<]|["'>]$/g, ""))
    .filter(Boolean);
}
function collect(
  root: Node,
  file: ParsedFile,
  rule: Rules,
  signal?: AbortSignal,
): void {
  const seen = new Map<string, number>();
  const stack: Array<{
    node: Node;
    owner: StaticSymbolFact | null;
    lexical: string;
    execution: string | null;
  }> = [{ node: root, owner: null, lexical: "", execution: null }];
  while (stack.length) {
    const item = stack.pop()!,
      { node } = item;
    signal?.throwIfAborted();
    let { owner, lexical, execution } = item;
    if (node.type === "ERROR" || node.isMissing)
      file.diagnostics!.push({
        code: node.isMissing ? "syntax_missing" : "syntax_error",
        range: range(node),
      });
    let kind = rule.declarations[node.type];
    if (file.language === "go" && node.type === "type_spec") {
      const type = field(node, "type")?.type;
      kind =
        type === "interface_type"
          ? "interface"
          : type === "struct_type"
            ? "struct"
            : "type_alias";
    }
    if (
      file.language === "cpp" &&
      ["declaration", "field_declaration"].includes(node.type) &&
      field(node, "declarator")?.type === "function_declarator"
    )
      kind = "function";
    if (kind) {
      const nameNode =
        field(node, "name") ??
        (field(node, "declarator")
          ? declaratorName(field(node, "declarator")!)
          : null);
      const name =
        nameNode?.text ??
        (kind === "accessor" ? node.firstChild?.text : null) ??
        "<anonymous>";
      const body = field(node, "body", "value");
      const header = node.text
        .slice(0, body ? body.startIndex - node.startIndex : node.text.length)
        .replace(/\s+/g, " ");
      const receiver = field(node, "receiver")?.text ?? "";
      const key = `${lexical}/${kind}:${name}:${receiver}:${header}`;
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      const qualifiedName = [lexical, receiver, name].filter(Boolean).join(".");
      const stableId = symbolStableId(
        file.path,
        qualifiedName,
        kind,
        `${stableDigest(header)}:${ordinal}`,
      );
      const parameters =
        field(node, "parameters") ??
        field(node, "declarator")?.childForFieldName("parameters");
      const symbol: StaticSymbolFact = {
        stableId,
        name,
        qualifiedName,
        kind,
        path: file.path,
        language: file.language,
        ...range(node),
        parameterCount: parameters?.namedChildCount ?? null,
        implicitReceiverCount: 0,
        bases: [],
        sources: ["tree_sitter"],
        trackingKey: key,
        scopeId: owner?.stableId ?? null,
        valid: !node.hasError,
        declarations: [
          {
            id: `declaration:${stableDigest(`${file.path}:${node.startIndex}:${node.endIndex}`)}`,
            path: file.path,
            range: range(node),
            selection: range(nameNode ?? node),
            role: body ? "definition" : "declaration",
            valid: !node.hasError,
          },
        ],
      };
      file.symbols.push(symbol);
      owner = symbol;
      lexical = qualifiedName;
      for (const base of node.namedChildren.filter((child) =>
        [
          "superclass",
          "super_interfaces",
          "interfaces",
          "base_list",
          "base_class_clause",
          "superclasses",
        ].includes(child.type),
      )) {
        (file.unresolvedHeritage ??= []).push({
          sourceId: stableId,
          name: base.text,
          kind: ["interfaces", "super_interfaces"].includes(base.type)
            ? "implements"
            : base.type === "base_list"
              ? "supertype"
              : "inherits",
          range: range(base),
        });
      }
      if (["function", "method", "constructor", "accessor"].includes(kind))
        execution = stableId;
    } else if (rule.scopes.includes(node.type)) {
      lexical += `.${node.type}:${field(node, "trait")?.text ?? ""}:${field(node, "type")?.text ?? ""}`;
    } else if (
      ["block", "compound_statement"].includes(node.type) &&
      node.parent &&
      field(node.parent, "body")?.id !== node.id
    ) {
      const key = `${lexical}/block`,
        ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      lexical += `.<block:${ordinal}>`;
    }
    if (rule.imports.includes(node.type))
      for (const source of importSources(node, file.language))
        file.imports.push({
          source,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          range: range(node),
          status: "unresolved",
          kind: "imports",
        });
    if (rule.calls.includes(node.type)) {
      const callee =
        field(node, "function", "name", "method", "type") ??
        node.namedChildren[0];
      if (callee)
        file.calls.push({
          id: `call:${stableDigest(`${file.path}:${node.startIndex}:${node.endIndex}`)}`,
          callerStableId: execution,
          callee: callee.text,
          argumentCount: field(node, "arguments")?.namedChildCount ?? null,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          range: range(node),
          target: null,
          status: "unresolved",
          meaning: "syntax",
        });
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      const outside =
        file.language === "python" &&
        kind === "function" &&
        child.id !== field(node, "body")?.id;
      stack.push({
        node: child,
        owner,
        lexical,
        execution: outside ? item.execution : execution,
      });
    }
  }
  if (root.hasError) file.parseError = "syntax_error_recovery";
}
export class TreeSitterAnalyzer {
  private static initialized: Promise<void> | undefined;
  private readonly languages = new Map<string, Language>();
  async init(): Promise<void> {
    await (TreeSitterAnalyzer.initialized ??= Parser.init());
  }
  async analyzeFile(
    root: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<ParsedFile> {
    return this.analyzeBytes(path, await readSnapshotFile(root, path), signal);
  }
  async analyzeBytes(
    path: string,
    raw: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ParsedFile> {
    return this.analyzeDecoded(decodeSource(path, raw), signal);
  }
  async analyzeDecoded(
    decoded: ReturnType<typeof decodeSource>,
    signal?: AbortSignal,
  ): Promise<ParsedFile> {
    signal?.throwIfAborted();
    const { file, text } = decoded,
      path = file.path,
      spec = languageForPath(path);
    if (
      text === null ||
      !spec ||
      !["source", "declaration"].includes(file.role!)
    )
      return file;
    if (["typescript", "javascript"].includes(spec.id))
      return extractTypeScriptSyntax(file, text, signal);
    await this.init();
    const key = path.endsWith(".c") ? "c" : spec.id;
    let language = this.languages.get(key);
    try {
      if (!language) {
        language = await Language.load(
          require.resolve(
            key === "c"
              ? "tree-sitter-c/tree-sitter-c.wasm"
              : `${spec.grammarPackage}/${spec.grammarFile}`,
          ),
        );
        this.languages.set(key, language);
      }
    } catch {
      return {
        ...file,
        parseError: "tree_sitter_grammar_unavailable",
        diagnostics: [{ code: "tree_sitter_grammar_unavailable" }],
      };
    }
    const parser = new Parser();
    parser.setLanguage(language);
    file.parser = syntaxToolchain(path);
    try {
      const started = performance.now();
      const tree = parser.parse(text, null, {
        progressCallback: () => {
          signal?.throwIfAborted();
          if (performance.now() - started > 10_000)
            throw new Error("parse_budget");
        },
      });
      if (!tree) return { ...file, parseError: "tree_parse_empty" };
      try {
        collect(tree.rootNode, file, rules[spec.id]!, signal);
        if (spec.id === "python") bindPythonSyntax(tree.rootNode, file);
      } finally {
        tree.delete();
      }
      return file;
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...file,
        parseError: "tree_parse_failed",
        diagnostics: [
          ...file.diagnostics!,
          {
            code: error instanceof Error ? error.message : "tree_parse_failed",
          },
        ],
      };
    } finally {
      parser.delete();
    }
  }
}
