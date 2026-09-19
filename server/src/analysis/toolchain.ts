import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LANGUAGE_SPECS, languageForPath } from "./languages.js";

const require = createRequire(import.meta.url);
const versions = new Map<string, string>();
function packageVersion(name: string): string {
  let version = versions.get(name);
  if (version) return version;
  // web-tree-sitter hides package.json in its exports. Its resolved entry is at
  // the package root; all other grammars expose their own package metadata.
  const path =
    name === "web-tree-sitter"
      ? join(dirname(require.resolve(name)), "package.json")
      : require.resolve(`${name}/package.json`);
  version = String(JSON.parse(readFileSync(path, "utf8")).version);
  versions.set(name, version);
  return version;
}

export function syntaxToolchain(path: string): {
  name: string;
  version: string;
} {
  const spec = languageForPath(path);
  if (!spec) return { name: "text", version: "utf8-strict-v1" };
  if (["typescript", "javascript"].includes(spec.id)) {
    return { name: "typescript", version: packageVersion("typescript") };
  }
  const grammar =
    spec.id === "cpp" && /\.c$/i.test(path)
      ? "tree-sitter-c"
      : spec.grammarPackage!;
  return {
    name: grammar,
    version: `${packageVersion(grammar)};web-tree-sitter=${packageVersion("web-tree-sitter")}`,
  };
}

export const STATIC_TOOLCHAIN_IDENTITY = JSON.stringify([
  ...LANGUAGE_SPECS.map((spec) =>
    syntaxToolchain(`source${spec.extensions[0]}`),
  ),
  syntaxToolchain("source.c"),
]);
