/** Native TS/JS entities and bindings share one compiler model and a closed virtual filesystem. */
import ts from "typescript";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  type ParsedFile,
  type SourceRange,
  type StaticSymbolFact,
  type FactSymbolKind,
  type ProjectContext,
  STATIC_KERNEL_VERSION,
  stableDigest,
  symbolStableId,
} from "./facts.js";
import { bytesDigest, decodeSource, readSnapshotFile } from "./source-input.js";
const ROOT = "/repository";
export const scriptPath = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const relativePath = (name: string): string => name.slice(ROOT.length + 1);
const normalize = (name: string): string =>
  posix.normalize(name.replaceAll("\\", "/"));
const inside = (name: string): boolean => name.startsWith(ROOT + "/");
function isDynamicImport(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isMetaProperty(expression) && expression.keywordToken === ts.SyntaxKind.ImportKeyword && expression.name.text === "defer");
}
function childrenOf(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, child => { children.push(child); });
  return children;
}
function* preorder(root: ts.Node, signal?: AbortSignal): Generator<ts.Node> {
  const pending = [root];
  while (pending.length) {
    signal?.throwIfAborted();
    const node = pending.pop()!;
    yield node;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  }
}
const range = (node: ts.Node): SourceRange => {
  const file = node.getSourceFile(),
    start = file.getLineAndCharacterOfPosition(node.getStart(file)),
    end = file.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
};
function kindOf(node: ts.Node): FactSymbolKind | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  )
    return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
    return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
    return "accessor";
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type_alias";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isClassStaticBlockDeclaration(node)) return "function";
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    !ts.isArrowFunction(node.initializer) &&
    !ts.isFunctionExpression(node.initializer)
  )
    return "function";
  return null;
}
function nameOf(node: ts.Node): ts.Node | undefined {
  const named = node as ts.NamedDeclaration;
  if (named.name) return named.name;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) ||
      ts.isPropertyAssignment(node.parent) ||
      ts.isPropertyDeclaration(node.parent))
  )
    return node.parent.name;
  return undefined;
}
interface Extraction {
  files: Map<string, ParsedFile>;
  entities: Map<ts.Node, StaticSymbolFact>;
  calls: Map<ts.Node, { file: ParsedFile; owner: string | null }>;
}
function extract(
  sources: ts.SourceFile[],
  originals: Map<string, ParsedFile>,
  checker?: ts.TypeChecker,
  signal?: AbortSignal,
): Extraction {
  const result: Extraction = {
    files: new Map(),
    entities: new Map(),
    calls: new Map(),
  };
  const native = new Map<ts.Symbol, Map<FactSymbolKind, StaticSymbolFact>>();
  const counters = new Map<string, number>();
  for (const source of sources) {
    const original = originals.get(source.fileName);
    if (!original) continue;
    const diagnostics =
      (
        source as ts.SourceFile & {
          parseDiagnostics: ts.DiagnosticWithLocation[];
        }
      ).parseDiagnostics ?? [];
    const file: ParsedFile = {
      ...original,
      symbols: [],
      imports: [],
      calls: [],
      heritage: [],
      parser: { name: "typescript", version: ts.version },
      parseError: diagnostics.length ? "typescript_syntax_error" : null,
      diagnostics: diagnostics.map((d) => ({
        code: `typescript_${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      })),
    };
    result.files.set(source.fileName, file);
    // Deep binary expressions are valid input. Keep lexical/execution context
    // on a heap stack instead of consuming the JavaScript call stack per node.
    const pending: Array<{node: ts.Node; lexical: string; parent: StaticSymbolFact | null; execution: string | null}> = [
      {node: source, lexical: "", parent: null, execution: null},
    ];
    while (pending.length) {
      const {node, lexical, parent, execution} = pending.pop()!;
      signal?.throwIfAborted();
      const kind = kindOf(node),
        named = nameOf(node);
      let owner = parent,
        nextLexical = lexical,
        nextExecution = execution;
      if (kind) {
        const name = ts.isPropertyDeclaration(node)
          ? `<initialize:${named?.getText(source)}>`
          : (named?.getText(source) ??
            (ts.isConstructorDeclaration(node)
              ? "constructor"
              : ts.isClassStaticBlockDeclaration(node)
                ? "<static>"
                : "<anonymous>"));
        const symbol =
          checker && named ? checker.getSymbolAtLocation(named) : undefined;
        let existing = symbol ? native.get(symbol)?.get(kind) : undefined;
        if (
          existing?.declarations?.some((d) => d.role === "definition") &&
          (node as ts.FunctionLikeDeclaration).body
        )
          existing = undefined;
        const key = `${lexical}/${kind}:${name}`;
        const ordinal = counters.get(`${source.fileName}:${key}`) ?? 0;
        const discriminator =
          name === "<anonymous>"
            ? stableDigest(node.getText(source)) + ":" + ordinal
            : String(ordinal);
        const qualifiedName = [lexical, name].filter(Boolean).join(".");
        const site = {
          id: `declaration:${stableDigest(`${file.path}:${node.getStart(source)}:${node.end}`)}`,
          path: file.path,
          range: range(node),
          selection: range(named ?? node),
          role:
            ((node as ts.FunctionLikeDeclaration).body ||
              ts.isClassDeclaration(node) ||
              ts.isClassExpression(node)) &&
            !source.isDeclarationFile
              ? ("definition" as const)
              : ("declaration" as const),
          valid: !diagnostics.some(
            (d) =>
              d.start <= node.end && d.start + d.length >= node.getStart(source),
          ),
        };
        owner = existing ?? {
          stableId: symbolStableId(
            file.path,
            qualifiedName,
            kind,
            discriminator,
          ),
          name,
          qualifiedName,
          kind,
          path: file.path,
          language: file.language,
          ...range(node),
          parameterCount:
            (node as ts.FunctionLikeDeclaration).parameters?.length ?? null,
          implicitReceiverCount: 0,
          bases: [],
          sources: ["typescript"],
          trackingKey: key,
          scopeId: parent?.stableId ?? null,
          declarations: [],
          valid: true,
        };
        if (!existing) {
          file.symbols.push(owner);
          counters.set(`${source.fileName}:${key}`, ordinal + 1);
          if (symbol) {
            const kinds = native.get(symbol) ?? new Map();
            kinds.set(kind, owner);
            native.set(symbol, kinds);
          }
        }
        owner.declarations!.push(site);
        owner.valid &&= site.valid;
        if (site.role === "definition") Object.assign(owner, range(node));
        result.entities.set(node, owner);
        if (
          named &&
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        )
          result.entities.set(node.parent, owner);
        nextLexical = qualifiedName;
        if (["function", "method", "constructor", "accessor"].includes(kind))
          nextExecution = owner.stableId;
      } else if (
        ts.isBlock(node) &&
        !ts.isFunctionLike(node.parent) &&
        !ts.isClassStaticBlockDeclaration(node.parent)
      ) {
        const key = `${source.fileName}:${lexical}/block`,
          ordinal = counters.get(key) ?? 0;
        counters.set(key, ordinal + 1);
        nextLexical += `.<block:${ordinal}>`;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node))
        result.calls.set(node, { file, owner: nextExecution });
      const children = childrenOf(node);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]!;
        pending.push({node: child, lexical: nextLexical, parent: owner,
          execution: ts.isDecorator(child) ||
            (child === named && ts.isComputedPropertyName(child))
            ? execution
            : nextExecution,
        });
      }
    }
  }
  return result;
}
export function extractTypeScriptSyntax(
  file: ParsedFile,
  text: string,
  signal?: AbortSignal,
): ParsedFile {
  const name = `${ROOT}/${file.path}`,
    source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const model = extract([source], new Map([[name, file]]), undefined, signal);
  for (const [node, { file: output, owner }] of model.calls) {
    const call = node as ts.CallExpression,
      site = range(node);
    output.calls.push({
      id: `call:${stableDigest(`${file.path}:${node.getStart()}:${node.end}`)}`,
      callerStableId: owner,
      callee: call.expression.getText(),
      argumentCount: call.arguments?.length ?? 0,
      line: site.startLine,
      column: site.startColumn,
      range: site,
      target: null,
      status: "unresolved",
      meaning: "syntax",
    });
  }
  return model.files.get(name)!;
}
let libraries: Map<string, string> | undefined;
function trustedLibraries(): Map<string, string> {
  if (libraries) return libraries;
  const root = dirname(createRequire(import.meta.url).resolve("typescript"));
  libraries = new Map();
  for (const file of readdirSync(root))
    if (/^lib\.[\w.]+\.d\.ts$/.test(file))
      libraries.set(
        `/toolchain/${file}`,
        readFileSync(join(root, file), "utf8"),
      );
  return libraries;
}
interface CompilerProject {
  context: ProjectContext;
  parsed: ts.ParsedCommandLine;
}
/** No filesystem/network fallback: config extends and module resolution can only observe approved texts. */
export function createCompilerWorkspace(texts: ReadonlyMap<string, string>) {
  const all = new Map([...texts, ...trustedLibraries()]);
  const packages = new Map<string, string | null>();
  for (const [path, text] of texts)
    if (posix.basename(path) === "package.json") {
      const json = ts.parseConfigFileTextToJson(path, text).config;
      if (typeof json?.name === "string")
        packages.set(
          json.name,
          packages.has(json.name) ? null : posix.dirname(path),
        );
    }
  const outputMaps = new Map<string, Set<string>>();
  const canonical = (input: string): string => {
    const path = normalize(input);
    if (!inside(path)) return path;
    const dependency = path.match(
      /\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/,
    );
    const packageRoot = dependency && packages.get(dependency[1]!);
    const mapped = packageRoot ? packageRoot + (dependency![2] ?? "") : path;
    if (all.has(mapped) || !outputMaps.size) return mapped;
    const candidates = new Set<string>();
    // Only ancestor directories can be output prefixes. Keep all matching
    // roots: nested or shared outputs must still reject ambiguous sources.
    for (let output = posix.dirname(mapped); output !== "/" && output !== "."; output = posix.dirname(output))
      for (const source of outputMaps.get(output) ?? []) {
        const stem = (source + mapped.slice(output.length)).replace(
          /(?:\.d)?\.[cm]?[jt]sx?$/,
          "",
        );
        for (const extension of [
          ".ts",
          ".tsx",
          ".mts",
          ".cts",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
        ])
          if (all.has(stem + extension)) candidates.add(stem + extension);
      }
    return candidates.size === 1 ? [...candidates][0]! : mapped;
  };
  const directories = new Map<
    string,
    { files: Set<string>; directories: Set<string> }
  >();
  for (const path of all.keys()) {
    let child = posix.basename(path),
      parent = posix.dirname(path),
      isFile = true;
    while (parent !== ".") {
      const entry = directories.get(parent) ?? {
        files: new Set(),
        directories: new Set(),
      };
      (isFile ? entry.files : entry.directories).add(child);
      directories.set(parent, entry);
      if (parent === "/") break;
      child = posix.basename(parent);
      parent = posix.dirname(parent);
      isFile = false;
    }
  }
  type MatchFiles = (
    path: string,
    extensions: readonly string[] | undefined,
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    sensitive: boolean,
    cwd: string,
    depth: number | undefined,
    entries: (path: string) => { files: string[]; directories: string[] },
    realpath: (path: string) => string,
  ) => string[];
  const matchFiles = (ts as unknown as { matchFiles: MatchFiles }).matchFiles;
  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => all.has(canonical(path)),
    readFile: (path) => all.get(canonical(path)),
    readDirectory: (path, extensions, excludes, includes, depth) =>
      matchFiles(
        path,
        extensions,
        excludes,
        includes,
        true,
        ROOT,
        depth,
        (path) => {
          const value = directories.get(canonical(path));
          return {
            files: [...(value?.files ?? [])].sort(),
            directories: [...(value?.directories ?? [])].sort(),
          };
        },
        canonical,
      ),
  };
  const projects: CompilerProject[] = [];
  const configQueue = [...texts.keys()]
    .filter((p) => /(?:^|\/)[jt]sconfig\.json$/i.test(p))
    .sort();
  const visitedConfigs = new Set<string>();
  for (let configIndex = 0; configIndex < configQueue.length; configIndex++) {
    const path = configQueue[configIndex]!;
    if (visitedConfigs.has(path) || !texts.has(path)) continue;
    visitedConfigs.add(path);
    const source = ts.parseJsonText(path, texts.get(path)!);
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      source,
      configHost,
      posix.dirname(path),
      undefined,
      path,
    );
    const references = (parsed.projectReferences ?? []).map((r) => r.path);
    for (const reference of references) {
      const config = reference.endsWith(".json")
        ? reference
        : posix.join(reference, "tsconfig.json");
      if (inside(config)) configQueue.push(config);
    }
    const context: ProjectContext = {
      id: `project:${stableDigest(path)}`,
      root: relativePath(posix.dirname(path)) || "",
      configPath: relativePath(path),
      configDigest: bytesDigest(
        JSON.stringify([
          parsed.options,
          parsed.fileNames,
          references,
          parsed.errors.map((d) => [
            d.code,
            ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          ]),
        ]),
      ),
      language: "typescript",
      inferred: false,
      files: parsed.fileNames.filter(inside).map(relativePath),
      references: references.map(relativePath),
      diagnostics: parsed.errors.map((d) => ({
        code: `config_${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      })),
    };
    projects.push({ context, parsed });
  }
  for (const project of projects) {
    const options = project.parsed.options;
    if (options.rootDir && inside(options.rootDir))
      for (const output of [options.outDir, options.declarationDir])
        if (output && inside(output) && output !== options.rootDir) {
          const sources = outputMaps.get(output) ?? new Set<string>();
          sources.add(options.rootDir);
          outputMaps.set(output, sources);
        }
  }
  // A file belongs to the closest including config. Solution configs retain project references.
  const owners = new Map<string, CompilerProject>();
  for (const project of [...projects].sort(
    (a, b) =>
      b.context.root.length - a.context.root.length ||
      a.context.id.localeCompare(b.context.id),
  ))
    for (const path of project.parsed.fileNames)
      if (!owners.has(path)) owners.set(path, project);
  const inferred = new Map<string, string[]>();
  for (const path of texts.keys())
    if (scriptPath.test(path) && !owners.has(path)) {
      const pkg =
        [...packages.values()]
          .filter((p): p is string => !!p && path.startsWith(p + "/"))
          .sort((a, b) => b.length - a.length)[0] ?? ROOT;
      const files = inferred.get(pkg) ?? [];
      files.push(path);
      inferred.set(pkg, files);
    }
  for (const [root, fileNames] of inferred) {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
    };
    const project: CompilerProject = {
      context: {
        id: `project:${stableDigest(root + ":inferred")}`,
        root: root === ROOT ? "" : relativePath(root),
        configPath: null,
        configDigest: bytesDigest(JSON.stringify(options)),
        language: "typescript",
        inferred: true,
        files: fileNames.map(relativePath).sort(),
        references: [],
        diagnostics: [{ code: "inferred_project_options" }],
      },
      parsed: { options, fileNames: fileNames.sort(), errors: [] },
    };
    projects.push(project);
    for (const file of fileNames) owners.set(file, project);
  }
  // Module resolution probes missing directories repeatedly. Index these once
  // so each probe canonicalizes its path once, instead of once per project.
  const outputDirectories = new Set<string>();
  const parsedConfigs = new Map<string, ts.ParsedCommandLine>();
  for (const project of projects) {
    for (const output of [project.parsed.options.outDir, project.parsed.options.declarationDir])
      if (output !== undefined) outputDirectories.add(output);
    const path = `${ROOT}/${project.context.configPath}`;
    if (!parsedConfigs.has(path)) parsedConfigs.set(path, project.parsed);
  }
  const directoryExists = (name: string): boolean => {
    const path = canonical(name);
    return directories.has(path) || outputDirectories.has(path) || /\/node_modules(?:\/[^/]+)?$/.test(name);
  };
  const getParsedCommandLine = (path: string) => parsedConfigs.get(canonical(path));
  return { all, canonical, directories, configHost, projects, owners, directoryExists, getParsedCommandLine };
}
export async function analyzeTypeScript(
  files: ParsedFile[],
  root: string,
  signal?: AbortSignal,
): Promise<ParsedFile[]> {
  const texts = new Map<string, string>();
  for (const file of files)
    if (
      scriptPath.test(file.path) ||
      file.role === "config" ||
      /\.json$/i.test(file.path)
    ) {
      signal?.throwIfAborted();
      const raw = await readSnapshotFile(root, file.path, file);
      const decoded = decodeSource(file.path, raw);
      if (decoded.text !== null)
        texts.set(`${ROOT}/${file.path}`, decoded.text);
    }
  return analyzeTypeScriptTexts(files, texts, signal);
}
type ProjectCompilation = {
  project: CompilerProject;
  owned: string[];
  contextInputs: string[];
  keyFor: (inputs: string[]) => string;
};
/** Let each compiler Program, checker and AST index leave the call stack before
 * the next project starts. Only plain ParsedFile facts escape this function. */
function compileTypeScriptProject(input: ProjectCompilation & {
  workspace: ReturnType<typeof createCompilerWorkspace>;
  originals: Map<string, ParsedFile>;
  outputs: Map<string, ParsedFile>;
  texts: ReadonlyMap<string, string>;
  resolutionDomain: string;
  signal?: AbortSignal;
}): void {
  const { project, owned, contextInputs, keyFor, workspace, originals, outputs,
    texts, resolutionDomain, signal } = input;
  const { all, canonical, directories, configHost } = workspace;
  signal?.throwIfAborted();
  const options = {
    ...project.parsed.options,
    noEmit: true,
    skipLibCheck: true,
    disableSizeLimit: false,
    plugins: undefined,
  };
  const sourceCache = new Map<string, ts.SourceFile>();
  const host: ts.CompilerHost = {
    ...configHost,
    readDirectory: (...args) => [...configHost.readDirectory(...args)],
    getSourceFile: (name, target) => {
      signal?.throwIfAborted();
      const path = canonical(name),
        text = all.get(path);
      if (text === undefined) return undefined;
      let source = sourceCache.get(path);
      if (!source) {
        source = ts.createSourceFile(path, text, target, true);
        sourceCache.set(path, source);
      }
      return source;
    },
    getDefaultLibFileName: () =>
      `/toolchain/${ts.getDefaultLibFileName(options)}`,
    getDefaultLibLocation: () => "/toolchain",
    getParsedCommandLine: workspace.getParsedCommandLine,
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: canonical,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    writeFile: () => {
      throw new Error("typescript_emit_forbidden");
    },
    realpath: canonical,
    directoryExists: workspace.directoryExists,
    getDirectories: (name) => [
      ...(directories.get(canonical(name))?.directories ?? []),
    ],
  };
  const program = ts.createProgram({
    rootNames: project.parsed.fileNames,
    options,
    host,
    projectReferences: project.parsed.projectReferences,
  });
  const checker = program.getTypeChecker();
  const sources = program
    .getSourceFiles()
    .filter((s) => originals.has(s.fileName))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const model = extract(sources, originals, checker, signal);
  const mutated = new Set<ts.Symbol>();
  for (const source of sources) {
    for (const node of preorder(source, signal)) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) mutated.add(symbol);
      }
    }
  }
  const unalias = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const targetFor = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): {
    entity?: StaticSymbolFact;
    declaration?: ts.Declaration;
    dynamic?: boolean;
  } => {
    if (ts.isParenthesizedExpression(expression))
      return targetFor(expression.expression, seen);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
      return {
        entity: model.entities.get(expression),
        declaration: expression,
      };
    const at = ts.isPropertyAccessExpression(expression)
      ? expression.name
      : expression;
    let sym = checker.getSymbolAtLocation(at);
    if (!sym) return {};
    sym = unalias(sym);
    if (seen.has(sym)) return {};
    seen.add(sym);
    const declarations = sym.declarations ?? [];
    if (
      mutated.has(sym) ||
      declarations.filter((d) => (d as ts.FunctionLikeDeclaration).body)
        .length > 1
    )
      return {};
    const declaration =
      declarations.find((d) => (d as ts.FunctionLikeDeclaration).body) ??
      sym.valueDeclaration ??
      declarations[0];
    if (!declaration) return {};
    if (ts.isParameter(declaration)) return {};
    if (
      ts.isPropertyDeclaration(declaration) &&
      declaration.initializer &&
      !ts.isArrowFunction(declaration.initializer) &&
      !ts.isFunctionExpression(declaration.initializer)
    )
      return {};
    if (ts.isVariableDeclaration(declaration)) {
      if (
        !(ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) ||
        !declaration.initializer
      )
        return {};
      return targetFor(declaration.initializer, seen);
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      checker.getTypeAtLocation(expression.expression).isUnion()
    )
      return { dynamic: true };
    return {
      entity: model.entities.get(declaration),
      declaration,
      dynamic:
        ts.isMethodDeclaration(declaration) ||
        ts.isMethodSignature(declaration) ||
        ts.isGetAccessorDeclaration(declaration),
    };
  };
  const resolutionCache = ts.createModuleResolutionCache(
    ROOT,
    canonical,
    options,
  );
  for (const source of sources) {
    const file = model.files.get(source.fileName)!;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    file.exports = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol).map((exported) => {
          const symbol = unalias(exported);
          const declaration =
            symbol.valueDeclaration ?? symbol.declarations?.[0];
          return {
            name: exported.name,
            entityId: declaration
              ? (model.entities.get(declaration)?.stableId ?? null)
              : null,
            typeOnly: !(symbol.flags & ts.SymbolFlags.Value),
          };
        })
      : [];
    for (const node of preorder(source, signal)) {
      let expression: ts.Expression | undefined,
        typeOnly = false,
        kind: "imports" | "type_imports" | "reexports" | "dynamic_imports" =
          "imports";
      if (ts.isImportDeclaration(node)) {
        expression = node.moduleSpecifier;
        typeOnly =
          node.importClause?.isTypeOnly === true ||
          !!(
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            !node.importClause.name &&
            node.importClause.namedBindings.elements.length &&
            node.importClause.namedBindings.elements.every(
              (e) => e.isTypeOnly,
            )
          );
      }
      if (ts.isExportDeclaration(node)) {
        expression = node.moduleSpecifier;
        typeOnly = node.isTypeOnly;
        kind = "reexports";
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        expression = node.moduleReference.expression;
      if (
        ts.isCallExpression(node) &&
        (isDynamicImport(node.expression) ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            !checker
              .getSymbolAtLocation(node.expression)
              ?.declarations?.some((d) =>
                inside(d.getSourceFile().fileName),
              )))
      ) {
        expression = node.arguments[0];
        kind =
          isDynamicImport(node.expression)
            ? "dynamic_imports"
            : "imports";
      }
      if (expression && ts.isStringLiteralLike(expression)) {
        const resolved = ts.resolveModuleName(
          expression.text,
          source.fileName,
          options,
          host,
          resolutionCache,
        );
        const path =
          resolved.resolvedModule &&
          canonical(resolved.resolvedModule.resolvedFileName);
        const internal = path && originals.has(path),
          site = range(expression);
        file.imports.push({
          source: expression.text,
          line: site.startLine,
          column: site.startColumn,
          range: site,
          typeOnly,
          kind: typeOnly ? "type_imports" : kind,
          resolvedPath: internal ? relativePath(path) : null,
          status: internal
            ? "static"
            : path
              ? "external"
              : expression.text.startsWith(".")
                ? "unresolved"
                : "missing_dependency",
          // The semantic key covers this entire path domain. Persisting every
          // attempted node_modules path per import duplicates large compiler
          // lookup caches without improving invalidation correctness.
          resolutionDomain,
        });
      }
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))
        for (const clause of node.heritageClauses ?? [])
          for (const base of clause.types) {
            const target = targetFor(base.expression).entity,
              owner = model.entities.get(node);
            if (target && owner)
              file.heritage!.push({
                sourceId: owner.stableId,
                targetId: target.stableId,
                kind:
                  clause.token === ts.SyntaxKind.ImplementsKeyword
                    ? "implements"
                    : "inherits",
                range: range(base),
              });
          }
    }
  }
  for (const [node, { file, owner }] of model.calls) {
    // The AST remains in the Program for binding, but this lookup entry is no
    // longer needed after its call fact has been emitted.
    model.calls.delete(node);
    const call = node as ts.CallExpression;
    if (isDynamicImport(call.expression)) continue;
    const target = targetFor(call.expression),
      declaration = target.declaration;
    const site = range(node),
      library = declaration
        ?.getSourceFile()
        .fileName.startsWith("/toolchain/");
    const entity = target.entity;
    file.calls.push({
      id: `call:${stableDigest(`${file.path}:${node.getStart()}:${node.end}`)}`,
      callerStableId: owner,
      callee: call.expression.getText(),
      argumentCount: call.arguments?.length ?? 0,
      line: site.startLine,
      column: site.startColumn,
      range: site,
      target:
        entity && entity.valid
          ? {
              path: entity.path,
              line: entity.startLine,
              column: entity.startColumn,
              symbolId: entity.stableId,
            }
          : null,
      status: entity && !entity.valid
        ? "unresolved"
        : entity
        ? target.dynamic
          ? "candidate"
          : "static"
        : library
          ? "standard_library"
          : declaration && !inside(declaration.getSourceFile().fileName)
            ? "external"
            : "unresolved",
      meaning: entity && !entity.valid
        ? "syntax"
        : target.dynamic
        ? "dynamic_dispatch"
        : entity?.declarations?.some((d) => d.role === "definition")
          ? "implementation"
          : "declaration",
    });
  }
  const inputs = [
      ...new Set([...contextInputs, ...sources.map((s) => s.fileName)]),
    ].sort(),
    semanticKey = keyFor(inputs);
  for (const path of owned) {
    // The compiler may intentionally omit a root (for example foo.js beside foo.ts).
    // Preserve its syntax and an explicit gap, and cache that decision too. Otherwise
    // one omitted root makes the entire project miss its semantic cache forever.
    const extracted = model.files.get(path),
      original = originals.get(path);
    if (!original) continue;
    const file =
      extracted ??
      extractTypeScriptSyntax(original, texts.get(path)!, signal);
    if (!extracted)
      file.diagnostics!.push({ code: "source_omitted_by_compiler" });
    file.semanticComplete =
      !!extracted &&
      !file.parseError &&
      !project.context.diagnostics.some((d) => d.code.startsWith("config_"));
    file.relationBinding = "typescript";
    file.project = { ...project.context, files: [] };
    file.semanticKey = semanticKey;
    file.semanticInputs = path === owned[0] ? inputs : undefined;
    file.diagnostics!.push(...project.context.diagnostics);
    outputs.set(path, file);
  }

}
export async function analyzeTypeScriptTexts(
  files: ParsedFile[],
  texts: ReadonlyMap<string, string>,
  signal?: AbortSignal,
  cacheOwnership?: {
    syntaxFiles: ParsedFile[];
    releasePrevious: (paths: string[]) => void;
  },
): Promise<ParsedFile[]> {
  const workspace = createCompilerWorkspace(texts),
    { all, canonical, directories, configHost } = workspace;
  const originals = new Map(
    files.map((file) => [`${ROOT}/${file.path}`, file]),
  );
  const outputs = new Map(originals);
  const syntaxByPath = cacheOwnership ? new Map(cacheOwnership.syntaxFiles.map(file => [`${ROOT}/${file.path}`, file])) : null;
  const candidateIndex = cacheOwnership ? new Map(files.map((file, index) => [`${ROOT}/${file.path}`, index])) : null;
  // Package exports and workspace package names affect lookup across project roots.
  // Other config files are represented by effective compiler options; JSON modules
  // join the project's observed dependency inputs below.
  const globalIdentity = bytesDigest(
    JSON.stringify(
      [...texts].filter(([p]) => posix.basename(p) === "package.json").sort(),
    ),
  );
  const structure = [...texts.keys()].sort();
  const resolutionDomain = `snapshot-paths:${bytesDigest(JSON.stringify(structure))}`;
  // The same dependency often belongs to several project keys. Hash each text
  // once per invocation; do not retain compiler state or inputs between runs.
  const textDigests = new Map<string, string>();
  const inputDigest = (path: string): string => {
    let digest = textDigests.get(path);
    if (!digest) { digest = bytesDigest(texts.get(path) ?? ''); textDigests.set(path, digest); }
    return digest;
  };
  const projectsToCompile: Array<{
    project: (typeof workspace.projects)[number];
    owned: string[];
    contextInputs: string[];
    keyFor: (inputs: string[]) => string;
  }> = [];
  for (const project of workspace.projects) {
    signal?.throwIfAborted();
    const owned = [...workspace.owners]
      .filter(([, owner]) => owner === project)
      .map(([path]) => path)
      .sort();
    if (!owned.length) continue;
    const previousInputs = new Set(
      owned.flatMap((p) => originals.get(p)?.semanticInputs ?? []),
    );
    const contextRoot =
      ROOT + (project.context.root ? "/" + project.context.root : "");
    const contextInputs = [...texts.keys()].filter(
      (p) =>
        (scriptPath.test(p) && p.startsWith(contextRoot + "/")) ||
        previousInputs.has(p),
    );
    const keyFor = (inputs: string[]) =>
      bytesDigest(
        JSON.stringify([
          STATIC_KERNEL_VERSION,
          ts.version,
          project.context.configDigest,
          globalIdentity,
          structure,
          inputs.sort().map((p) => [p, inputDigest(p)]),
        ]),
      );
    const reuseKey = keyFor(contextInputs);
    if (
      owned.every(
        (p) =>
          originals.get(p)?.semanticKey === reuseKey &&
          originals.get(p)?.relationBinding === "typescript",
      )
    )
      continue;
    projectsToCompile.push({ project, owned, contextInputs, keyFor });
  }
  // Decide every project's reuse first, while old semantic keys are intact.
  // Release every invalidated project's old rows before creating any program.
  if (cacheOwnership) for (const { owned } of projectsToCompile) {
    for (const path of owned) {
      const syntax = syntaxByPath?.get(path);
      const index = candidateIndex?.get(path);
      if (!syntax || index === undefined) continue;
      files[index] = syntax;
      originals.set(path, syntax);
      outputs.set(path, syntax);
    }
    cacheOwnership.releasePrevious(owned.map(relativePath));
  }
  for (const compilation of projectsToCompile) {
    compileTypeScriptProject({ ...compilation, workspace, originals, outputs,
      texts, resolutionDomain, signal });
    await setImmediate();
    signal?.throwIfAborted();
  }
  return files.map((file) => outputs.get(`${ROOT}/${file.path}`)!);
}
