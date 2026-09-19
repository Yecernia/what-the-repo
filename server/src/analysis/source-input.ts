import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ParsedFile, SourceFileManifest } from "./facts.js";
import { STATIC_KERNEL_VERSION } from "./facts.js";
import { languageForPath } from "./languages.js";
import { syntaxToolchain } from "./toolchain.js";

export const bytesDigest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export function sourceRole(path: string): NonNullable<ParsedFile["role"]> {
  if (/(^|\/)(node_modules|vendor|\.venv|\.git)(\/|$)/i.test(path))
    return "dependency";
  if (
    /(^|\/)(dist|build|target|coverage)(\/|$)|\.min\.[jc]s$|\.generated\./i.test(
      path,
    )
  )
    return "generated";
  if (languageForPath(path))
    return /\.d\.[cm]?ts$|\.pyi$/i.test(path) ? "declaration" : "source";
  if (
    /(?:^|\/)(?:[jt]sconfig[^/]*\.json|package\.json|go\.(mod|work)|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|pyproject\.toml|setup\.cfg|composer\.json|compile_commands\.json|CMakeLists\.txt)$|\.(?:csproj|sln|props|targets)$/i.test(
      path,
    )
  )
    return "config";
  if (
    /\.(md|rst|txt|adoc|markdown)$/i.test(path) ||
    /(^|\/)(README|LICENSE)$/i.test(path)
  )
    return "documentation";
  return "text";
}

export function decodeSource(
  path: string,
  raw: Uint8Array,
): { file: ParsedFile; text: string | null } {
  const digest = bytesDigest(raw),
    language = languageForPath(path)?.id ?? "unknown";
  const file: ParsedFile = {
    path,
    language,
    bytes: raw.byteLength,
    digest,
    symbols: [],
    imports: [],
    calls: [],
    parseError: null,
    role: sourceRole(path),
    encoding: "utf8",
    diagnostics: [],
    syntaxKey: bytesDigest(
      [
        STATIC_KERNEL_VERSION,
        JSON.stringify(syntaxToolchain(path)),
        path,
        language,
        digest,
        "utf8-strict",
      ].join(":"),
    ),
  };
  if (raw.includes(0)) {
    file.role = "binary";
    file.encoding = "binary";
    file.parseError = "binary_input";
    file.diagnostics!.push({ code: file.parseError });
    return { file, text: null };
  }
  try {
    return {
      file,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        raw,
      ),
    };
  } catch {
    file.encoding = "invalid_utf8";
    file.parseError = "invalid_utf8";
    file.diagnostics!.push({ code: file.parseError });
    return { file, text: null };
  }
}

/** Never let compiler hosts or adapters open arbitrary paths, including symlink components. */
export async function readSnapshotFile(
  root: string,
  path: string,
  expected?: SourceFileManifest,
): Promise<Uint8Array> {
  if (
    path.includes("\\") ||
    path.includes(":") ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("unsafe_analysis_path");
  const realRoot = await realpath(root);
  let candidate = realRoot;
  for (const part of path.split("/")) {
    candidate = resolve(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error("source_symlink_forbidden");
  }
  const rel = relative(realRoot, await realpath(candidate));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
    throw new Error("source_boundary");
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
    throw new Error("source_file_limit");
  const raw = await readFile(candidate);
  if (
    expected &&
    (expected.bytes !== raw.length || expected.digest !== bytesDigest(raw))
  )
    throw new Error("source_digest_mismatch");
  return raw;
}
