/** Read-only TypeScript binding over the safe source manifest. No emit, plugins or repository execution. */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import type { ParsedCallSite, ParsedFile, ParsedImport } from "./facts.js";

const VIRTUAL_ROOT = "/repository";
const scriptPath = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const inside = (path: string) => path.startsWith(VIRTUAL_ROOT + "/");

/** The compiler only sees these verified texts. All other filesystem lookups fail closed. */
export async function bindTypeScriptRelations(
  files: ParsedFile[], sourceRoot: string, signal?: AbortSignal,
): Promise<ParsedFile[]> {
  const selected = files.filter((file) => scriptPath.test(file.path)
    || posix.basename(file.path) === "package.json" || /(?:^|\/)tsconfig[^/]*\.json$/i.test(file.path));
  if (!selected.some((file) => scriptPath.test(file.path))) return files;
  const root = await realpath(sourceRoot);
  const texts = new Map<string, string>();
  for (const file of selected) {
    signal?.throwIfAborted();
    const path = await realpath(resolve(root, file.path));
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("typescript_source_boundary");
    const body = await readFile(path);
    if (body.length !== file.bytes || createHash("sha256").update(body).digest("hex") !== file.digest) {
      throw new Error("typescript_source_digest_mismatch");
    }
    texts.set(posix.join(VIRTUAL_ROOT, file.path), body.toString("utf8"));
  }
  return bindTypeScriptTexts(files, texts, signal);
}

/** Pure in-memory host also makes binding testable without executing a fixture. */
export async function bindTypeScriptTexts(files: ParsedFile[], texts: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<ParsedFile[]> {
  const json = (path: string): Record<string, any> | null => {
    const text = texts.get(path);
    if (text === undefined) return null;
    const parsed = ts.parseConfigFileTextToJson(path, text);
    return !parsed.error && parsed.config && typeof parsed.config === "object" ? parsed.config : null;
  };
  const packages = new Map<string, string | null>();
  const outputMaps: Array<{ output: string; source: string }> = [];
  for (const path of texts.keys()) {
    if (posix.basename(path) === "package.json") {
      const name = json(path)?.name;
      if (typeof name === "string" && /^(?:@[^/]+\/)?[^/]+$/.test(name)) {
        packages.set(name, packages.has(name) ? null : posix.dirname(path));
      }
    }
    if (!/(?:^|\/)tsconfig[^/]*\.json$/i.test(path)) continue;
    const options = json(path)?.compilerOptions;
    if (!options || typeof options.rootDir !== "string") continue;
    const source = posix.resolve(posix.dirname(path), options.rootDir);
    for (const value of [options.outDir, options.declarationDir]) {
      if (typeof value !== "string") continue;
      const output = posix.resolve(posix.dirname(path), value);
      if (inside(source) && inside(output) && source !== output) outputMaps.push({ source, output });
    }
  }
  outputMaps.sort((a, b) => b.output.length - a.output.length);
  const canonical = (raw: string): string | undefined => {
    let path = posix.normalize(raw.replaceAll("\\", "/"));
    if (!inside(path)) return undefined;
    const dependency = path.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/);
    if (dependency) {
      const directory = packages.get(dependency[1]!);
      if (!directory) return undefined;
      path = directory + (dependency[2] ?? "");
    }
    if (texts.has(path)) return path;
    // Only reverse explicitly declared compiler output paths; never guess src/ from package names.
    const candidates = new Set<string>();
    for (const map of outputMaps) {
      if (!path.startsWith(map.output + "/")) continue;
      const stem = (map.source + path.slice(map.output.length)).replace(/(?:\.d)?\.[cm]?[jt]sx?$/i, "");
      for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
        if (texts.has(stem + extension)) candidates.add(stem + extension);
      }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, moduleDetection: ts.ModuleDetectionKind.Force,
    allowJs: true, checkJs: false, noLib: true, noEmit: true, types: [],
    skipLibCheck: true, jsx: ts.JsxEmit.Preserve, allowImportingTsExtensions: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      signal?.throwIfAborted();
      const path = canonical(name);
      const text = path && texts.get(path);
      return path && text !== undefined ? ts.createSourceFile(path, text, languageVersion, true) : undefined;
    },
    getDefaultLibFileName: () => "", writeFile: () => { throw new Error("typescript_emit_forbidden"); },
    getCurrentDirectory: () => VIRTUAL_ROOT, getDirectories: () => [],
    getCanonicalFileName: (name) => canonical(name) ?? name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: (name) => canonical(name) !== undefined,
    readFile: (name) => { const path = canonical(name); return path ? texts.get(path) : undefined; },
    realpath: (name) => canonical(name) ?? name,
  };
  const moduleCache = ts.createModuleResolutionCache(VIRTUAL_ROOT, (name) => name, options);
  const moduleFor = (source: string, containing: string) => {
    const result = ts.resolveModuleName(source, containing, options, host, moduleCache).resolvedModule;
    const path = result && canonical(result.resolvedFileName);
    return result && path ? { ...result, resolvedFileName: path } : undefined;
  };
  host.resolveModuleNames = (names, containing) => names.map((name) => moduleFor(name, containing));
  const roots = files.filter((file) => scriptPath.test(file.path)).map((file) => posix.join(VIRTUAL_ROOT, file.path));
  const byPath = new Map(files.map((file) => [posix.join(VIRTUAL_ROOT, file.path), file]));
  const outputs = new Map<string, ParsedFile>();
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  type CallableDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.ConstructorDeclaration | ts.ClassDeclaration | ts.ClassExpression;
  // Resolve identity, not argument types. getResolvedSignature instantiates generics for every
  // call and can retain far more memory; identity binding also rejects ambiguous union targets.
  const callableDeclarations = (symbol: ts.Symbol | undefined, construct: boolean, seen = new Set<ts.Symbol>()): CallableDeclaration[] => {
    if (!symbol || seen.has(symbol) || seen.size >= 16) return [];
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) return callableDeclarations(checker.getAliasedSymbol(symbol), construct, seen);
    const targets: CallableDeclaration[] = [];
    for (const declaration of symbol.declarations ?? []) {
      if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionExpression(declaration)
        || ts.isArrowFunction(declaration) || ts.isConstructorDeclaration(declaration)) && declaration.body) targets.push(declaration);
      else if (construct && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
        if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) continue;
        const constructor = declaration.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && Boolean(member.body));
        targets.push(constructor ?? declaration);
      } else if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
        if (ts.isVariableDeclaration(declaration) && !(declaration.parent.flags & ts.NodeFlags.Const)) continue;
        const initializer = declaration.initializer;
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) targets.push(initializer);
        else if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer)) {
          targets.push(...callableDeclarations(checker.getSymbolAtLocation(initializer), construct, seen));
        }
      }
    }
    return [...new Set(targets)];
  };
  for (const path of roots) {
    signal?.throwIfAborted();
    const source = program.getSourceFile(path);
    const file = byPath.get(path)!;
    if (!source) throw new Error("typescript_source_missing");
    const calls: ParsedCallSite[] = [];
    const imports: ParsedImport[] = [];
    const visit = (node: ts.Node): void => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const raw = node.moduleSpecifier.text;
        const target = moduleFor(raw, path);
        imports.push({ source: raw, line: location.line + 1, resolvedPath: target?.resolvedFileName.slice(VIRTUAL_ROOT.length + 1) ?? null,
          typeOnly: ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly ?? false : node.isTypeOnly });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        const raw = expression.getText(source);
        if (ts.isCallExpression(node) && (raw === "require" || expression.kind === ts.SyntaxKind.ImportKeyword)
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
          const name = (node.arguments[0] as ts.StringLiteral).text;
          const target = moduleFor(name, path);
          imports.push({ source: name, line: location.line + 1, resolvedPath: target?.resolvedFileName.slice(VIRTUAL_ROOT.length + 1) ?? null });
        } else {
          const declarations = callableDeclarations(checker.getSymbolAtLocation(expression), ts.isNewExpression(node));
          const declaration = declarations.length === 1 ? declarations[0] : undefined;
          let target: ParsedCallSite["target"] = null;
          // Type-only signatures, unknown/any receivers and standard/external library methods are not repository implementations.
          if (declaration) {
            const targetSource = declaration.getSourceFile();
            if (byPath.has(targetSource.fileName)) {
              const at = targetSource.getLineAndCharacterOfPosition(declaration.getStart(targetSource));
              const end = targetSource.getLineAndCharacterOfPosition(declaration.end);
              const name = declaration.name?.getText(targetSource);
              const matches = byPath.get(targetSource.fileName)!.symbols.filter((symbol) => symbol.name === name
                && symbol.startLine >= at.line + 1 && symbol.endLine <= end.line + 1
                && (symbol.startLine !== at.line + 1 || symbol.startColumn >= at.character)
                && (symbol.endLine !== end.line + 1 || symbol.endColumn <= end.character));
              target = { path: targetSource.fileName.slice(VIRTUAL_ROOT.length + 1), line: at.line + 1, column: at.character,
                ...(matches.length === 1 ? { symbolId: matches[0]!.stableId } : {}) };
            }
          }
          const caller = file.symbols.filter((symbol) => symbol.startLine <= location.line + 1 && symbol.endLine >= location.line + 1)
            .filter((symbol) => (symbol.startLine !== location.line + 1 || symbol.startColumn <= location.character)
              && (symbol.endLine !== location.line + 1 || symbol.endColumn > location.character))
            .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine) || b.startColumn - a.startColumn)[0];
          calls.push({ callerStableId: caller?.stableId ?? null, callee: raw, argumentCount: node.arguments?.length ?? 0,
            line: location.line + 1, column: location.character, target });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    outputs.set(file.path, { ...file, language: /\.(?:[cm]?ts|tsx)$/i.test(file.path) ? "typescript" : "javascript", calls, imports, relationBinding: "typescript" });
    await setImmediate();
  }
  return files.map((file) => outputs.get(file.path) ?? file);
}
