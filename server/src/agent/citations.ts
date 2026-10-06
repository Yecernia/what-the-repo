import type { EvidenceRef } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import type { CitationReviewResult } from "./citation-review.js";
import { canonicalEvidence, evidenceIdentity, type CitationCoverage } from './evidence-packets.js';

export interface CitationValidation {
  text: string;
  unresolved: string[];
  evidence: EvidenceRef[];
  errors: string[];
  coverage: CitationCoverage;
}

interface ReferencedPathToken {
  path: string;
  line: number | null;
  endLine: number | null;
  offset?: number;
  length?: number;
  directory?: string | null;
}

const INLINE_REFERENCE = /`([^`\r\n]+)`/gu;
const PLAIN_PATH = /(?<![A-Za-z0-9_@+$~./-])(?:[A-Za-z0-9_@+$~.-]+\/)+[A-Za-z0-9_@+$~.-]+\.[A-Za-z0-9_-]+(?:(?::\d{1,7}(?:-\d{1,7})?)|(?:#L\d+(?:-L?\d+)?))?/giu;

function withoutCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, (block) => " ".repeat(block.length));
}

/** Conservative prefilter: unknown basenames in inline code may still be citations. */
export function hasPotentialCitation(text: string): boolean {
  const candidate = withoutCodeFences(text);
  for (const _ of candidate.matchAll(INLINE_REFERENCE)) return true;
  for (const _ of candidate.matchAll(PLAIN_PATH)) return true;
  return false;
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
    if (row?.stable_id) byId.set(JSON.stringify([row.path, row.start_line, row.end_line, row.stable_id]), row);
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
  const withoutFences = withoutCodeFences(text);
  const inlineRanges: Array<[number, number]> = [];
  let directory: string | null = null;
  let previousEnd = 0;
  for (const match of withoutFences.matchAll(INLINE_REFERENCE)) {
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
  for (const match of withoutFences.matchAll(PLAIN_PATH)) {
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

function exposedFallback(exposed: Map<string, SnapshotEvidence>): SnapshotEvidence[] {
  const rows = [...exposed.values()];
  const inspected = rows.filter(row => row.kind === "source_excerpt");
  const inspectedPaths = new Set(inspected.map(row => normalizeReferencePath(row.path)));
  // Prefer ranges the answering agent actually inspected over earlier graph anchors.
  return [...inspected, ...rows.filter(row => row.kind !== "source_excerpt" && !inspectedPaths.has(normalizeReferencePath(row.path)))];
}

export async function validateAnswerCitations(input: {
  text: string;
  snapshot: EvidenceSnapshot | null;
  getSnapshot?: () => Promise<EvidenceSnapshot | null>;
  snapshotId?: string | null;
  exposed: Map<string, SnapshotEvidence>;
  projectId: string;
  store: ProductStore;
  /** Bound teaching blocks carry their own provenance; do not inherit other blocks' reads. */
  fallbackEvidence?: boolean;
  /** Bare paths in a block may use only its supplied ranges, never snapshot graph anchors from another block. */
  isolateBareReferences?: boolean;
}): Promise<CitationValidation> {
  if (input.getSnapshot && input.snapshotId && !hasPotentialCitation(input.text)) {
    return { text: input.text, unresolved: [], errors: [], evidence: canonicalEvidence((input.fallbackEvidence === false ? [] : exposedFallback(input.exposed))
      .map((row) => toMessageEvidence(row, input.snapshotId!))), coverage: { parsed: 0, resolved: 0, references: [] } };
  }
  const snapshot = input.getSnapshot ? await input.getSnapshot() : input.snapshot;
  if (!snapshot) {
    const references = referencedPathTokens(input.text, new Set()).map(token => ({ reference: token.path + (token.line === null ? '' : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ''}`),
      resolved: false, evidence: [], reason: 'invalid_reference' as const, explicit: token.line !== null }));
    return { text: input.text, unresolved: references.map(row => row.reference), evidence: [], errors: references.map(row => `unknown_path:${row.reference}`),
      coverage: { parsed: references.length, resolved: 0, references } };
  }
  const rows = [...allEvidence(snapshot), ...input.exposed.values()].sort((a, b) => {
    const left = evidenceIdentity(toMessageEvidence(a, snapshot.snapshot_id)), right = evidenceIdentity(toMessageEvidence(b, snapshot.snapshot_id));
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const byPath = new Map<string, SnapshotEvidence[]>();
  for (const row of rows) {
    const path = normalizeReferencePath(row.path);
    if (!path) continue;
    const existing = byPath.get(path) ?? [];
    if (!existing.some((candidate) => candidate.stable_id === row.stable_id && candidate.start_line === row.start_line && candidate.end_line === row.end_line)) existing.push(row);
    byPath.set(path, existing);
  }
  if (!referencedPathTokens(input.text, new Set(byPath.keys())).length) {
    return { text: input.text, unresolved: [], errors: [], evidence: canonicalEvidence((input.fallbackEvidence === false ? [] : exposedFallback(input.exposed))
      .map((row) => toMessageEvidence(row, snapshot.snapshot_id))), coverage: { parsed: 0, resolved: 0, references: [] } };
  }
  // The source manifest includes files that were not selected as graph evidence.
  // PostgreSQL caches this manifest; no source content is read for name lookup.
  let files: string[];
  try {
    files = await input.store.listSourceFiles(input.projectId, snapshot.snapshot_id);
  } catch {
    const references = referencedPathTokens(input.text, new Set(byPath.keys())).map(token => ({
      reference: token.path + (token.line === null ? '' : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ''}`),
      resolved: false, evidence: [], reason: 'read_failed' as const, explicit: token.line !== null,
    }));
    return { text: input.text, unresolved: references.map(row => row.reference), evidence: [],
      errors: references.map(row => `read_failed:${row.reference}`), coverage: { parsed: references.length, resolved: 0, references } };
  }
  const knownPaths = new Set(files.map(normalizeReferencePath).filter((path): path is string => Boolean(path)));
  const byName = new Map<string, string[]>();
  for (const path of knownPaths) {
    const name = path.split("/").at(-1)!;
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const accepted = new Map<string, SnapshotEvidence>();
  const coverage: CitationCoverage = { parsed: 0, resolved: 0, references: [] };
  const errors: string[] = [];
  const unresolved: string[] = [];
  const replacements: Array<{ offset: number; length: number; text: string }> = [];
  const tokens = referencedPathTokens(input.text, knownPaths);
  coverage.parsed = tokens.length;
  for (const token of tokens) {
    const reference = token.path + (token.line === null ? "" : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ""}`);
    const entry: CitationCoverage['references'][number] = { reference, resolved: false, evidence: [], reason: 'invalid_reference', explicit: token.line !== null };
    coverage.references.push(entry);
    if (token.line !== null && (!Number.isInteger(token.line) || token.line < 1 || token.endLine === null
      || !Number.isInteger(token.endLine) || token.endLine < token.line)) {
      unresolved.push(reference); errors.push('invalid_line:' + reference); continue;
    }
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
        errors.push("read_failed:" + reference);
        entry.reason = 'read_failed';
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
      const row = { ...selected, path: canonicalPath, start_line: token.line, end_line: token.endLine };
      entry.evidence.push(toMessageEvidence(row, snapshot.snapshot_id));
      accepted.set(evidenceIdentity(entry.evidence[0]), row);
    } else {
      const inspected = [...input.exposed.values()].filter(row => (input.isolateBareReferences || row.kind === "source_excerpt")
        && normalizeReferencePath(row.path) === canonicalPath);
      const selected = inspected.length ? inspected : input.isolateBareReferences ? [{
        stable_id: `source-file:${canonicalPath}`, label: canonicalPath, path: canonicalPath,
        start_line: 1, end_line: null, kind: 'source_file',
      }] : [pathCandidates.find((row) => row.kind === "file") ?? pathCandidates[0]].filter((row): row is SnapshotEvidence => Boolean(row));
      if (!selected.length) continue;
      for (const row of selected) {
        const resolved = { ...row, path: canonicalPath };
        const evidence = toMessageEvidence(resolved, snapshot.snapshot_id);
        entry.evidence.push(evidence);
        accepted.set(evidenceIdentity(evidence), resolved);
      }
    }
    entry.resolved = true; entry.reason = null; coverage.resolved++;
    entry.evidence = canonicalEvidence(entry.evidence);
    if (token.offset !== undefined && token.length !== undefined && canonicalPath !== token.path) {
      const line = token.line === null ? "" : `:${token.line}${token.endLine !== token.line ? `-${token.endLine}` : ""}`;
      replacements.push({ offset: token.offset, length: token.length, text: canonicalPath + line });
    }
  }
  const explicit = canonicalEvidence(coverage.references.filter(entry => entry.explicit && entry.resolved).flatMap(entry => entry.evidence));
  const explicitKeys = new Set(explicit.map(evidenceIdentity));
  for (const entry of coverage.references.filter(entry => !entry.explicit && entry.resolved)) {
    const covered = entry.evidence.map(row => explicit.find(anchor => anchor.snapshot_id === row.snapshot_id && anchor.path === row.path
      && row.start_line !== null && row.end_line !== null && anchor.start_line !== null && anchor.end_line !== null
      && anchor.start_line <= row.start_line && anchor.end_line >= row.end_line));
    if (covered.every(Boolean)) {
      entry.covered_by = canonicalEvidence(covered.filter((row): row is EvidenceRef => Boolean(row)));
      for (const row of entry.evidence) if (!explicitKeys.has(evidenceIdentity(row))) accepted.delete(evidenceIdentity(row));
    }
  }
  return {
    unresolved: [...new Set(unresolved)],
    text: replacements.sort((a, b) => b.offset - a.offset).reduce(
      (text, replacement) => text.slice(0, replacement.offset) + replacement.text + text.slice(replacement.offset + replacement.length),
      input.text,
    ),
    evidence: canonicalEvidence([...accepted.values()].map((row) => toMessageEvidence(row, snapshot.snapshot_id))),
    errors,
    coverage,
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

/** Bounded plain text: reviewer content must not introduce links, HTML, or Markdown instructions. */
export function withEvidenceReviewNotice(text: string, review: CitationReviewResult): string {
  if (review.status === "not_applicable" || (review.status === "reviewed" && review.supported)) return text;
  const chinese = /[\u4e00-\u9fff]/u.test(text);
  const safe = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").replace(/[<>&`\[\]()*_#!\\]/gu, "").slice(0, 350);
  if (!review.completed && !review.evidenceIncomplete) return `${text}\n\n> ${chinese
    ? '未能完成证据核对，请将相关说明视为尚未核实。'
    : 'Evidence review could not be completed; treat the related claims as unverified.'}`;
  const rows = review.issues.slice(0, 4).map(issue => {
    const label = issue.kind === "contradicted"
      ? chinese ? "与已读取源码矛盾" : "Contradicted by inspected source"
      : chinese ? "证据不足" : "Insufficient evidence";
    return `> ${label}：${safe(issue.claim)} — ${safe(issue.reason)}`;
  });
  if (review.evidenceIncomplete) rows.push(chinese ? "> 引用源码未完整读取，相关主张尚未核实。" : "> Source coverage is incomplete; the related claims remain unverified.");
  if (!rows.length) rows.push(`> ${chinese ? "未能完成证据核对" : "Evidence review could not verify this answer"}：${safe(review.summary)}`);
  return `${text}\n\n${rows.join("\n>\n")}`;
}
