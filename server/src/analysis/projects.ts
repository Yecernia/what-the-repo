import { posix } from "node:path";
import type { ParsedFile, ProjectContext } from "./facts.js";
import { stableDigest, STATIC_KERNEL_VERSION } from "./facts.js";
const descriptors: Record<string, RegExp> = {
  python: /^(pyproject\.toml|setup\.cfg|setup\.py)$/,
  go: /^go\.(mod|work)$/,
  rust: /^Cargo\.toml$/,
  java: /^(pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/,
  csharp: /\.(csproj|sln)$/,
  php: /^composer\.json$/,
  cpp: /^(compile_commands\.json|CMakeLists\.txt)$/,
};
/** Descriptors identify a workspace; only native backends may interpret build semantics. */
export function assignSyntaxProjects(files: ParsedFile[]): ParsedFile[] {
  // Enrichment must not mutate the reusable syntax cache or the parent snapshot.
  files = files.map((file) =>
    descriptors[file.language]
      ? { ...file, imports: file.imports.map((imported) => ({ ...imported })) }
      : file,
  );
  const contexts = new Map<string, ProjectContext>();
  const configsByLanguage = new Map(
    Object.entries(descriptors).map(([language, matcher]) => [
      language,
      files.filter((file) => matcher.test(posix.basename(file.path))),
    ]),
  );
  for (const file of files) {
    const matcher = descriptors[file.language];
    if (!matcher) continue;
    const configs = configsByLanguage
      .get(file.language)!
      .filter(
        (candidate) =>
          posix.dirname(candidate.path) === "." ||
          file.path.startsWith(posix.dirname(candidate.path) + "/"),
      )
      .sort(
        (a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path),
      );
    const config = configs[0],
      root =
        config && posix.dirname(config.path) !== "."
          ? posix.dirname(config.path)
          : "";
    const id = `project:${stableDigest(`${file.language}:${config?.path ?? "inferred"}`)}`;
    let context = contexts.get(id);
    if (!context) {
      context = {
        id,
        root,
        configPath: config?.path ?? null,
        configDigest: stableDigest(
          `${STATIC_KERNEL_VERSION}:${config?.digest ?? "inferred"}`,
        ),
        language: file.language,
        inferred: !config,
        files: [],
        references: [],
        diagnostics: [
          {
            code: config
              ? "project_descriptor_recognized_not_executed"
              : "inferred_project",
          },
        ],
      };
      contexts.set(id, context);
    }
    file.project = context;
  }
  for (const context of contexts.values()) context.files.sort();
  const paths = new Set(files.map((f) => f.path));
  for (const file of files)
    if (file.language === "python")
      for (const imported of file.imports) {
        const dots = imported.source.match(/^\.+/)?.[0].length ?? 0;
        const directory = dots
          ? posix.join(posix.dirname(file.path), ...Array(dots - 1).fill(".."))
          : file.project?.root || ".";
        const module = posix.join(
          directory,
          imported.source.slice(dots).replaceAll(".", "/"),
        );
        const candidates = [
          module + ".py",
          module + ".pyi",
          posix.join(module, "__init__.py"),
        ].filter((p) => paths.has(p));
        imported.resolvedPath = candidates.length === 1 ? candidates[0]! : null;
        imported.status = imported.resolvedPath
          ? "candidate"
          : dots
            ? "unresolved"
            : "missing_dependency";
      }
  return files;
}
