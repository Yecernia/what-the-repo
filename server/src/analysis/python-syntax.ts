import type { Node } from "web-tree-sitter";
import type { ParsedFile, StaticSymbolFact } from "./facts.js";

interface Scope {
  parent: Scope | null;
  kind: string;
  bindings: Map<string, StaticSymbolFact | null>;
}
/** Python's lexical lookup, with assignment/import/parameter shadowing. These are
 * candidates: decorators, globals and monkey-patching can change runtime values. */
export function bindPythonSyntax(root: Node, file: ParsedFile): void {
  const symbols = new Map(
    file.symbols.map((s) => [`${s.startLine}:${s.startColumn}`, s]),
  );
  const calls = new Map(file.calls.map((c) => [`${c.line}:${c.column}`, c]));
  const pending: Array<{
    scope: Scope;
    call: NonNullable<ReturnType<typeof calls.get>>;
  }> = [];
  const bases: Array<{ scope: Scope; source: StaticSymbolFact; node: Node }> =
    [];
  const module: Scope = { parent: null, kind: "module", bindings: new Map() };
  const bind = (scope: Scope, name: string, symbol: StaticSymbolFact | null) =>
    scope.bindings.set(name, scope.bindings.has(name) ? null : symbol);
  const names = (node: Node | null, scope: Scope): void => {
    if (!node) return;
    if (node.type === "identifier") {
      bind(scope, node.text, null);
      return;
    }
    if (["attribute", "subscript", "type"].includes(node.type)) return;
    for (const child of node.namedChildren) names(child, scope);
  };
  const visit = (node: Node, scope: Scope): void => {
    const symbol = symbols.get(
      `${node.startPosition.row + 1}:${node.startPosition.column}`,
    );
    if (
      ["function_definition", "class_definition", "lambda"].includes(node.type)
    ) {
      if (symbol && symbol.name !== "<anonymous>")
        bind(scope, symbol.name, symbol);
      const inner: Scope = {
        parent:
          node.type !== "class_definition" && scope.kind === "class_definition"
            ? scope.parent
            : scope,
        kind: node.type,
        bindings: new Map(),
      };
      const parameters = node.childForFieldName("parameters");
      for (const parameter of parameters?.namedChildren ?? []) {
        if (parameter.type === "identifier") names(parameter, inner);
        else
          names(
            parameter.childForFieldName("name") ??
              parameter.namedChildren.find((c) => c.type === "identifier") ??
              null,
            inner,
          );
      }
      if (node.type === "class_definition" && symbol)
        for (const base of node.childForFieldName("superclasses")
          ?.namedChildren ?? [])
          bases.push({ scope, source: symbol, node: base });
      const body = node.childForFieldName("body");
      for (const child of node.namedChildren)
        visit(child, child.id === body?.id ? inner : scope);
      return;
    }
    if (
      [
        "assignment",
        "augmented_assignment",
        "named_expression",
        "for_statement",
        "for_in_clause",
      ].includes(node.type)
    )
      names(
        node.childForFieldName("left") ?? node.childForFieldName("name"),
        scope,
      );
    if (
      node.type === "import_statement" ||
      node.type === "import_from_statement"
    )
      for (const imported of node.namedChildren) {
        if (imported.id === node.childForFieldName("module_name")?.id) continue;
        const alias = imported.childForFieldName("alias");
        bind(scope, alias?.text ?? imported.text.split(".")[0]!, null);
      }
    if (node.type === "global_statement" || node.type === "nonlocal_statement")
      for (const child of node.namedChildren) bind(scope, child.text, null);
    const call = calls.get(
      `${node.startPosition.row + 1}:${node.startPosition.column}`,
    );
    if (
      node.type === "call" &&
      call &&
      node.childForFieldName("function")?.type === "identifier"
    )
      pending.push({ scope, call });
    for (const child of node.namedChildren) visit(child, scope);
  };
  visit(root, module);
  const lookup = (
    scope: Scope | null,
    name: string,
  ): StaticSymbolFact | null => {
    for (let current = scope; current; current = current.parent)
      if (current.bindings.has(name)) return current.bindings.get(name) ?? null;
    return null;
  };
  for (const { scope, call } of pending) {
    const target = lookup(scope, call.callee);
    if (!target?.valid) continue;
    call.target = {
      path: target.path,
      line: target.startLine,
      column: target.startColumn,
      symbolId: target.stableId,
    };
    call.status = "candidate";
    call.meaning = "declaration";
  }
  for (const { scope, source, node } of bases)
    if (node.type === "identifier") {
      const target = lookup(scope, node.text);
      if (!target) continue;
      (file.heritage ??= []).push({
        sourceId: source.stableId,
        targetId: target.stableId,
        kind: "inherits",
        status: "candidate",
        range: {
          startLine: node.startPosition.row + 1,
          startColumn: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column,
        },
      });
    }
}
