import { setImmediate } from "node:timers/promises";
import { type ParsedFile, type SourceFileManifest } from "./facts.js";
import type { AnalysisCache } from "./incremental.js";
import { readSnapshotFile, decodeSource } from "./source-input.js";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { analyzeTypeScriptTexts, scriptPath } from "./typescript.js";
import { assignSyntaxProjects } from "./projects.js";

/** Overlap eight disk reads, keeping deterministic extraction order and at
 * most nine 4 MiB raw buffers including the file being parsed. Every file
 * retains all boundary/digest checks. */
async function* readInputs(input: {
  manifest: SourceFileManifest[]; sourceRoot: string; signal?: AbortSignal;
}) {
  const ordered = [...input.manifest].sort((a, b) => a.path.localeCompare(b.path));
  const pending = new Map<number, Promise<{ raw: Uint8Array } | { error: unknown }>>();
  const start = (index: number) => {
    const file = ordered[index];
    if (file) pending.set(index, readSnapshotFile(input.sourceRoot, file.path, file)
      .then(raw => ({ raw }), error => ({ error })));
  };
  try {
    input.signal?.throwIfAborted();
    for (let i = 0; i < Math.min(8, ordered.length); i++) start(i);
    for (let i = 0; i < ordered.length; i++) {
      input.signal?.throwIfAborted();
      const result = (await pending.get(i))!;
      pending.delete(i);
      if ('error' in result) throw result.error;
      start(i + 8);
      yield { manifest: ordered[i]!, raw: result.raw };
    }
  } finally { await Promise.all(pending.values()); }
}

export async function analyzeStaticSource(input: {
  manifest: SourceFileManifest[];
  sourceRoot: string;
  previous: AnalysisCache | null;
  signal?: AbortSignal;
}) {
  if (
    input.manifest.length > 30_000 ||
    input.manifest.reduce((n, f) => n + f.bytes, 0) > 300 * 1024 * 1024
  )
    throw new Error("source_snapshot_budget");
  if (new Set(input.manifest.map((f) => f.path)).size !== input.manifest.length)
    throw new Error("duplicate_source_path");
  const started = performance.now(),
    parser = new TreeSitterAnalyzer();
  const previousSyntax = new Map(
    (input.previous?.syntax_files ?? []).map((f) => [f.path, f]),
  );
  const previousSemantic = new Map(
    (input.previous?.parsed_files ?? []).map((f) => [f.path, f]),
  );
  const syntax: ParsedFile[] = [],
    texts = new Map<string, string>();
  let syntaxHits = 0;
  for await (const { manifest, raw } of readInputs(input)) {
    input.signal?.throwIfAborted();
    try {
      const decoded = decodeSource(manifest.path, raw);
      const cached = previousSyntax.get(manifest.path);
      if (
        cached &&
        cached.syntaxKey === decoded.file.syntaxKey &&
        !cached.parseError
      ) {
        syntax.push(cached);
        syntaxHits++;
      } else
        syntax.push(
          await parser.analyzeDecoded(decoded, input.signal),
        );
      if (
        decoded.text !== null &&
        (scriptPath.test(manifest.path) ||
          decoded.file.role === "config" ||
          /\.json$/i.test(manifest.path))
      )
        texts.set(`/repository/${manifest.path}`, decoded.text);
    } catch (error) {
      input.signal?.throwIfAborted();
      // Integrity/boundary violations are fatal, never downgraded to parse errors.
      throw error;
    }
    await setImmediate();
  }
  const syntaxMs = performance.now() - started;
  const candidates = syntax.map((file) => {
    const previous = previousSemantic.get(file.path);
    return previous &&
      previous.digest === file.digest &&
      previous.syntaxKey === file.syntaxKey
      ? previous
      : file;
  });
  let files = assignSyntaxProjects(
    await analyzeTypeScriptTexts(candidates, texts, input.signal),
  );
  const entityIds = new Set(
    files.flatMap((file) => file.symbols.map((symbol) => symbol.stableId)),
  );
  files = files.map((file) => {
    const missing = file.calls.filter(
      (call) => call.target?.symbolId && !entityIds.has(call.target.symbolId),
    );
    if (!missing.length) return file;
    const ids = new Set(missing);
    return {
      ...file,
      calls: file.calls.map((call) =>
        ids.has(call)
          ? { ...call, target: null, status: "unresolved" as const }
          : call,
      ),
      diagnostics: [
        ...(file.diagnostics ?? []),
        ...missing.map((call) => ({
          code: "cross_project_entity_unavailable",
          range: call.range,
        })),
      ],
    };
  });
  const semanticHits = files.filter(
    (f) => f.semanticKey && f === previousSemantic.get(f.path),
  ).length;
  input.signal?.throwIfAborted();
  return {
    files,
    syntaxFiles: syntax,
    metrics: {
      duration_ms: performance.now() - started,
      syntax_ms: syntaxMs,
      semantic_ms: performance.now() - started - syntaxMs,
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      syntax_cache_hits: syntaxHits,
      semantic_cache_hits: semanticHits,
    },
  };
}
