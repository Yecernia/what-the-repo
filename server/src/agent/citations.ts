import type { EvidenceRef } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";

export interface CitationValidation {
  text: string;
  unresolved: string[];
  evidence: EvidenceRef[];
  errors: string[];
}

interface ReferencedPathToken {
  path: string;
  line: number | null;
  endLine: number | null;
  offset?: number;
  length?: number;
  directory?: string | null;
}

const KNOWN_BARE_FILE_NAMES = new Set([
  ".dockerignore",
  ".env",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  ".yarnrc",
  "containerfile",
  "dockerfile",
  "gemfile",
  "gnumakefile",
  "license",
  "makefile",
  "pipfile",
  "procfile",
  "rakefile",
  "readme",
  "go.mod",
  "go.sum",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const KNOWN_SOURCE_EXTENSIONS = new Set([
  ".bash", ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".cxx",
  ".dart", ".ex", ".exs", ".fish", ".fs", ".fsx", ".go", ".graphql", ".gql",
  ".h", ".hh", ".hpp", ".hrl", ".hs", ".hxx", ".html", ".htm", ".ini", ".java",
  ".jl", ".js", ".json", ".jsonc", ".jsx", ".kt", ".kts", ".less", ".lhs", ".lua",
  ".m", ".md", ".mdx", ".mjs", ".mm", ".php", ".pl", ".pm", ".proto", ".py", ".pyi",
  ".r", ".rb", ".rs", ".sass", ".scala", ".scss", ".sh", ".sol", ".sql", ".swift",
  ".terraform", ".toml", ".ts", ".tsx", ".vb", ".vbs", ".vue", ".wasm", ".xml", ".yaml",
  ".yml", ".zsh",
]);

function allEvidence(snapshot: EvidenceSnapshot): SnapshotEvidence[] {
  const rows = [
    ...snapshot.graph.nodes.flatMap((node) => [...node.evidence, ...node.members]),
    ...snapshot.graph.edges.flatMap((edge) => edge.evidence),
    ...(snapshot.fact_graph?.nodes
      .filter((node) => node.lifecycle_status !== "tombstoned" && node.lifecycle_status !== "superseded")
      .flatMap((node) => [...node.evidence, ...node.members]) ?? []),
    ...(snapshot.fact_graph?.edges
      .filter((edge) => edge.lifecycle_status !== "tombstoned" && edge.lifecycle_status !== "superseded")
      .flatMap((edge) => edge.evidence) ?? []),
    ...snapshot.graph.layers.flatMap((layer) => layer.evidence),
    ...snapshot.value_points.flatMap((point) => point.evidence),
  ];
  const byId = new Map<string, SnapshotEvidence>();
  for (const row of rows) {
    if (row?.stable_id && !byId.has(row.stable_id)) byId.set(row.stable_id, row);
  }
  return [...byId.values()];
}

function normalizeReferencePath(value: string): string | null {
  const path = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !path
    || path.startsWith("/")
    || /^[A-Za-z]:\//u.test(path)
    || path.includes("//")
    || path.split("/").some((part) => part === ".." || part.length === 0)
    || !/^[A-Za-z0-9_@+$~./-]+$/u.test(path)
  ) return null;
  return path;
}

function isLikelyFilePath(path: string, knownPaths: Set<string>): boolean {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? path.toLowerCase();
  if (KNOWN_BARE_FILE_NAMES.has(fileName) || /^dockerfile(?:\.|$)/u.test(fileName)) return true;
  const extension = fileName.match(/\.[a-z0-9][a-z0-9_-]*$/u)?.[0] ?? "";
  if (fileName === extension && !knownPaths.has(path)) return false;
  return KNOWN_SOURCE_EXTENSIONS.has(extension)
    || knownPaths.has(path)
    || [...knownPaths].some((candidate) => candidate.endsWith(`/${path}`));
}

function parseReferencedPath(value: string, knownPaths: Set<string>): ReferencedPathToken | null {
  let reference = value.trim();
  if (!reference || reference.includes("\n") || reference.length > 240) return null;
  reference = reference
    .replace(/^[([{<'"`]+/u, "")
    .replace(/[\]),.;!?，。；！？}>"'`]+$/u, "");
  if (!reference) return null;
  const suffix = reference.match(/(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/iu);
  const pathValue = suffix ? reference.slice(0, suffix.index).trim() : reference;
  const path = normalizeReferencePath(pathValue);
  if (!path || !isLikelyFilePath(path, knownPaths)) return null;
  const line = suffix ? Number(suffix[1] ?? suffix[3]) : null;
  const endLine = suffix ? Number(suffix[2] ?? suffix[4] ?? line) : null;
  if (
    line !== null
    && (!Number.isInteger(line) || line < 1 || endLine === null || !Number.isInteger(endLine) || endLine < line)
  ) return null;
  return { path, line, endLine };
}

function referencedPathTokens(
  text: string,
  knownPaths: Set<string>,
): ReferencedPathToken[] {
  const result: ReferencedPathToken[] = [];
  const add = (value: string, offset: number, directory: string | null): void => {
    const token = parseReferencedPath(value, knownPaths);
    if (!token) return;
    if (!result.some((item) => item.offset === offset)) {
      result.push({ ...token, offset, length: value.length, directory });
    }
  };

  // Inline code is the required format for a basename; fenced code is source,
  // not a user-facing citation, and must not create evidence chips.
  const withoutFences = text.replace(/```[\s\S]*?```/gu, (block) => " ".repeat(block.length));
  const inlineRanges: Array<[number, number]> = [];
  let directory: string | null = null;
  let previousEnd = 0;
  for (const match of withoutFences.matchAll(/`([^`\r\n]+)`/gu)) {
    const offset = match.index;
    if (/\n\s*\n/u.test(withoutFences.slice(previousEnd, offset))) directory = null;
    const value = match[1] ?? "";
    inlineRanges.push([offset, offset + match[0].length]);
    if (value.endsWith("/")) {
      const candidate = normalizeReferencePath(value.slice(0, -1));
      directory = candidate && [...knownPaths].some((path) => path.startsWith(`${candidate}/`)) ? candidate : null;
    } else add(value, offset + 1, directory);
    previousEnd = offset + match[0].length;
  }

  // Keep legacy plain full paths working, while requiring inline code for a
  // short basename so symbols such as Field.eval stay inert.
  const plainPath = /(?<![A-Za-z0-9_@+$~./-])(?:[A-Za-z0-9_@+$~.-]+\/)+[A-Za-z0-9_@+$~.-]+\.[A-Za-z0-9_-]+(?:(?::\d{1,7}(?:-\d{1,7})?)|(?:#L\d+(?:-L?\d+)?))?/giu;
  for (const match of withoutFences.matchAll(plainPath)) {
    if (!inlineRanges.some(([start, end]) => match.index >= start && match.index < end)) {
      add(match[0] ?? "", match.index, null);
    }
  }
  return result;
}

function toMessageEvidence(
  row: SnapshotEvidence,
  snapshotId: string,
  canonicalPath = row.path,
): EvidenceRef {
  return {
    stable_id: row.stable_id,
    label: row.label,
    path: canonicalPath,
    start_line: row.start_line,
    end_line: row.end_line,
    kind: row.kind,
    snapshot_id: snapshotId,
  };
}

export async function validateAnswerCitations(input: {
  text: string;
  snapshot: EvidenceSnapshot | null;
  exposed: Map<string, SnapshotEvidence>;
  projectId: string;
  store: ProductStore;
}): Promise<CitationValidation> {
  if (!input.snapshot) return { text: input.text, unresolved: [], evidence: [], errors: [] };
  const snapshot = input.snapshot;
  const rows = [...allEvidence(snapshot), ...input.exposed.values()];
  const byPath = new Map<string, SnapshotEvidence[]>();
  for (const row of rows) {
    const path = normalizeReferencePath(row.path);
    if (!path) continue;
    const existing = byPath.get(path) ?? [];
    if (!existing.some((candidate) => candidate.stable_id === row.stable_id)) existing.push(row);
    byPath.set(path, existing);
  }
  if (!referencedPathTokens(input.text, new Set(byPath.keys())).length) {
    return { text: input.text, unresolved: [], errors: [], evidence: [...input.exposed.values()].slice(0, 6)
      .map((row) => toMessageEvidence(row, snapshot.snapshot_id)) };
  }
  // The source manifest includes files that were not selected as graph evidence.
  // PostgreSQL caches this manifest; no source content is read for name lookup.
  const files = await input.store.listSourceFiles(input.projectId, snapshot.snapshot_id);
  const knownPaths = new Set(files.map(normalizeReferencePath).filter((path): path is string => Boolean(path)));
  const byName = new Map<string, string[]>();
  for (const path of knownPaths) {
    const name = path.split("/").at(-1)!;
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const accepted = new Map<string, SnapshotEvidence>();
  const acceptedPaths = new Map<string, string>();
  const errors: string[] = [];
  const unresolved: string[] = [];
  const replacements: Array<{ offset: number; length: number; text: string }> = [];
  const tokens = referencedPathTokens(input.text, knownPaths);
  for (const token of tokens) {
    const reference = token.path + (token.line === null ? "" : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ""}`);
    const contextualPath = token.directory && !token.path.includes("/") ? `${token.directory}/${token.path}` : null;
    const exactPath = contextualPath && knownPaths.has(contextualPath)
      ? [contextualPath]
      : knownPaths.has(token.path) ? [token.path] : [];
    const candidates = exactPath.length
      ? exactPath
      : token.path.includes("/")
        ? [...knownPaths].filter((path) => path.endsWith(`/${token.path}`))
        : byName.get(token.path) ?? [];
    if (!candidates.length) {
      unresolved.push(reference);
      errors.push("unknown_path:" + token.path);
      continue;
    }

    // Multiple matches establish existence, but do not establish a link target.
    if (candidates.length !== 1) { unresolved.push(reference); continue; }
    const canonicalPath = candidates[0];
    const pathCandidates = byPath.get(canonicalPath) ?? [{
      stable_id: `source-file:${canonicalPath}`, label: canonicalPath, path: canonicalPath,
      start_line: 1, end_line: null, kind: "source_file",
    }];
    if (token.line !== null) {
      try {
        const boundaries = [...new Set([token.line, token.endLine ?? token.line])];
        const excerpts = await Promise.all(boundaries.map((line) => input.store.readSourceLines(
          input.projectId, snapshot.snapshot_id, canonicalPath, line, line,
        )));
        if (excerpts.some((excerpt) => !excerpt.lines.length)) {
          unresolved.push(reference);
          errors.push("invalid_line:" + reference);
          continue;
        }
      } catch {
        unresolved.push(reference);
        errors.push("invalid_line:" + reference);
        continue;
      }
      const exact = pathCandidates.find((row) =>
        row.start_line !== null
        && row.end_line !== null
        && token.line !== null
        && token.line >= row.start_line
        && token.line <= row.end_line);
      const selected = exact
        ?? pathCandidates.find((row) => row.kind === "file")
        ?? pathCandidates[0];
      if (!selected) continue;
      accepted.set(`${selected.stable_id}:${token.line}:${token.endLine}`, {
        ...selected, start_line: token.line, end_line: token.endLine,
      });
      acceptedPaths.set(selected.stable_id, canonicalPath);
    } else {
      const selected = pathCandidates.find((row) => row.kind === "file") ?? pathCandidates[0];
      if (!selected) continue;
      accepted.set(selected.stable_id, selected);
      acceptedPaths.set(selected.stable_id, canonicalPath);
    }
    if (token.offset !== undefined && token.length !== undefined && canonicalPath !== token.path) {
      const line = token.line === null ? "" : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ""}`;
      replacements.push({ offset: token.offset, length: token.length, text: canonicalPath + line });
    }
  }
  return {
    unresolved: [...new Set(unresolved)],
    text: replacements.sort((a, b) => b.offset - a.offset).reduce(
      (text, replacement) => text.slice(0, replacement.offset) + replacement.text + text.slice(replacement.offset + replacement.length),
      input.text,
    ),
    evidence: [...accepted.values()].slice(0, 12)
      .map((row) => toMessageEvidence(row, snapshot.snapshot_id, acceptedPaths.get(row.stable_id) ?? row.path)),
    errors,
  };
}

/** Keep uncertainty in the answer both the user and the next turn receive. */
export function withCitationNotice(text: string, errors: readonly string[]): string {
  if (!errors.length) return text;
  const locations = [...new Set(errors.filter((error) => /^(unknown_path|invalid_line):/u.test(error))
    .map((error) => error.slice(error.indexOf(":") + 1)))];
  const chinese = /[\u4e00-\u9fff]/u.test(text);
  const notice = locations.length
    ? (chinese ? "引用未核实：" : "Unverified references: ") + locations.map((path) => `\`${path}\``).join("、")
      + (chinese ? "。当前源码中未确认对应文件或行号；相关说明请先视为未核实。" : ". These files or lines were not confirmed in the saved source; treat the related claims as unverified.")
    : chinese ? "部分说明尚未通过证据核对，请先视为未核实。" : "Some claims have not passed evidence review; treat them as unverified.";
  return `${text}\n\n> ${notice}`;
}
