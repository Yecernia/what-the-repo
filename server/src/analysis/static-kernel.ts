import { setImmediate } from "node:timers/promises";
import { type ParsedFile, type SourceFileManifest } from "./facts.js";
import type { AnalysisCache } from "./incremental.js";
import { readSnapshotFile, decodeSource } from "./source-input.js";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { analyzeTypeScriptTexts, scriptPath } from "./typescript.js";
import { assignSyntaxProjects } from "./projects.js";

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
  for (const manifest of [...input.manifest].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    input.signal?.throwIfAborted();
    try {
      const raw = await readSnapshotFile(
          input.sourceRoot,
          manifest.path,
          manifest,
        ),
        decoded = decodeSource(manifest.path, raw);
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
          await parser.analyzeBytes(manifest.path, raw, input.signal),
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
