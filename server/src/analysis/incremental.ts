import { createHash, type Hash } from "node:crypto";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotNode,
} from "../domain/snapshot.js";
import type { BuiltSnapshot } from "./graph.js";
import {
  type LspRunResult,
  type ParsedFile,
  type SourceFileManifest,
  unavailableLspResult,
} from "./facts.js";

export const ANALYSIS_CACHE_SCHEMA_VERSION = "analysis-cache-v2";

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  previous_digest: string | null;
  current_digest: string | null;
  renamed_from: string | null;
}

export interface AnalysisCache {
  schema_version: typeof ANALYSIS_CACHE_SCHEMA_VERSION;
  manifest: SourceFileManifest[];
  parsed_files: ParsedFile[];
  lsp_results: LspRunResult[];
}

export interface IncrementalPlan {
  mode: "full" | "incremental";
  parentSnapshotId: string | null;
  changes: FileChange[];
  affectedPaths: string[];
  affectedStableIds: string[];
  recomputePaths: string[];
  reusedPaths: string[];
  tombstonePaths: string[];
}

type FactGraph = NonNullable<EvidenceSnapshot["fact_graph"]>;

export function createAnalysisCache(input: {
  manifest: SourceFileManifest[];
  parsedFiles: ParsedFile[];
  lspResults: LspRunResult[];
}): AnalysisCache {
  return {
    schema_version: ANALYSIS_CACHE_SCHEMA_VERSION,
    manifest: input.manifest.map((item) => ({ ...item })),
    parsed_files: input.parsedFiles.map(cloneParsedFile),
    lsp_results: input.lspResults.map(cloneLspResult),
  };
}

export function readAnalysisCache(value: unknown): AnalysisCache | null {
  if (!isRecord(value) || value.schema_version !== ANALYSIS_CACHE_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.manifest) || !Array.isArray(value.parsed_files) || !Array.isArray(value.lsp_results)) return null;
  const manifest = value.manifest.filter(isManifestEntry).map((item) => ({ ...item }));
  const parsedFiles = value.parsed_files.filter(isParsedFile).map(cloneParsedFile);
  const lspResults = value.lsp_results.filter(isLspRunResult).map(cloneLspResult);
  if (manifest.length !== value.manifest.length || parsedFiles.length !== value.parsed_files.length || lspResults.length !== value.lsp_results.length) return null;
  const manifestPaths = new Set(manifest.map((item) => item.path));
  const parsedByPath = new Map(parsedFiles.map((file) => [file.path, file]));
  if (
    manifestPaths.size !== manifest.length
    || parsedByPath.size !== manifest.length
    || parsedFiles.some((file) => !manifestPaths.has(file.path))
    || manifest.some((item) => {
      const parsed = parsedByPath.get(item.path);
      return !parsed || parsed.digest !== item.digest || parsed.bytes !== item.bytes;
    })
  ) return null;
  return {
    schema_version: ANALYSIS_CACHE_SCHEMA_VERSION,
    manifest,
    parsed_files: parsedFiles,
    lsp_results: lspResults,
  };
}

export function classifyFileChanges(
  previous: SourceFileManifest[],
  current: SourceFileManifest[],
): FileChange[] {
  const oldByPath = new Map(previous.map((item) => [item.path, item]));
  const newByPath = new Map(current.map((item) => [item.path, item]));
  const deleted = new Map([...oldByPath].filter(([path]) => !newByPath.has(path)));
  const added = new Map([...newByPath].filter(([path]) => !oldByPath.has(path)));
  const deletedByDigest = new Map<string, string[]>();
  for (const [path, item] of deleted) {
    deletedByDigest.set(item.digest, [...(deletedByDigest.get(item.digest) ?? []), path].sort());
  }
  const addedByDigest = new Map<string, string[]>();
  for (const [path, item] of added) {
    addedByDigest.set(item.digest, [...(addedByDigest.get(item.digest) ?? []), path].sort());
  }

  const changes: FileChange[] = [];
  for (const [path, item] of [...added].sort(([left], [right]) => left.localeCompare(right))) {
    const candidates = deletedByDigest.get(item.digest) ?? [];
    const renamedFrom = candidates.length === 1 && addedByDigest.get(item.digest)?.length === 1
      ? candidates.shift() ?? null
      : null;
    if (renamedFrom) {
      deleted.delete(renamedFrom);
      changes.push({
        path,
        kind: "renamed",
        previous_digest: item.digest,
        current_digest: item.digest,
        renamed_from: renamedFrom,
      });
    } else {
      changes.push({
        path,
        kind: "added",
        previous_digest: null,
        current_digest: item.digest,
        renamed_from: null,
      });
    }
  }
  for (const [path, item] of [...deleted].sort(([left], [right]) => left.localeCompare(right))) {
    changes.push({
      path,
      kind: "deleted",
      previous_digest: item.digest,
      current_digest: null,
      renamed_from: null,
    });
  }
  for (const path of [...oldByPath.keys()].filter((item) => newByPath.has(item)).sort()) {
    const before = oldByPath.get(path) as SourceFileManifest;
    const after = newByPath.get(path) as SourceFileManifest;
    if (before.digest === after.digest) continue;
    changes.push({
      path,
      kind: "modified",
      previous_digest: before.digest,
      current_digest: after.digest,
      renamed_from: null,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

export function buildFullPlan(current: SourceFileManifest[]): IncrementalPlan {
  return {
    mode: "full",
    parentSnapshotId: null,
    changes: current.map((item) => ({
      path: item.path,
      kind: "added",
      previous_digest: null,
      current_digest: item.digest,
      renamed_from: null,
    })),
    affectedPaths: current.map((item) => item.path).sort(),
    affectedStableIds: [],
    recomputePaths: current.map((item) => item.path).sort(),
    reusedPaths: [],
    tombstonePaths: [],
  };
}

export function buildIncrementalPlan(input: {
  parentSnapshotId: string;
  previousCache: AnalysisCache;
  previousFactGraph: FactGraph;
  currentManifest: SourceFileManifest[];
}): IncrementalPlan {
  const changes = classifyFileChanges(input.previousCache.manifest, input.currentManifest);
  const changedPaths = new Set<string>();
  const tombstonePaths = new Set<string>();
  for (const change of changes) {
    changedPaths.add(change.path);
    if (change.renamed_from) {
      changedPaths.add(change.renamed_from);
      tombstonePaths.add(change.renamed_from);
    }
    if (change.kind === "deleted") tombstonePaths.add(change.path);
  }

  const nodePaths = new Map(input.previousFactGraph.nodes.map((node) => [node.id, nodePath(node)]));
  const affectedIds = new Set(input.previousFactGraph.nodes
    .filter((node) => {
      const path = nodePath(node);
      return path !== null && changedPaths.has(path);
    })
    .map((node) => node.id));
  let frontier = new Set(affectedIds);
  const traversable = new Set(["contains", "imports", "calls", "inherits", "implements"]);
  while (frontier.size) {
    const discovered = new Set<string>();
    for (const edge of input.previousFactGraph.edges) {
      if (!traversable.has(edge.relation_kind) || !frontier.has(edge.target)) continue;
      if (!affectedIds.has(edge.source)) discovered.add(edge.source);
    }
    if (!discovered.size) break;
    for (const stableId of discovered) affectedIds.add(stableId);
    frontier = discovered;
  }

  const affectedPaths = new Set(changedPaths);
  for (const stableId of affectedIds) {
    const path = nodePaths.get(stableId);
    if (path) affectedPaths.add(path);
  }
  const currentPaths = new Set(input.currentManifest.map((item) => item.path));
  const recomputePaths = [...affectedPaths].filter((path) => currentPaths.has(path)).sort();
  const reusedPaths = [...currentPaths].filter((path) => !affectedPaths.has(path)).sort();
  return {
    mode: "incremental",
    parentSnapshotId: input.parentSnapshotId,
    changes,
    affectedPaths: [...affectedPaths].sort(),
    affectedStableIds: [...affectedIds].sort(),
    recomputePaths,
    reusedPaths,
    tombstonePaths: [...tombstonePaths].sort(),
  };
}

export function mergeParsedFiles(input: {
  previous: ParsedFile[];
  recomputed: ParsedFile[];
  currentManifest: SourceFileManifest[];
  plan: IncrementalPlan;
}): ParsedFile[] {
  if (input.plan.mode === "full") return input.recomputed.map(cloneParsedFile);
  const previous = new Map(input.previous.map((file) => [file.path, file]));
  const recomputed = new Map(input.recomputed.map((file) => [file.path, file]));
  const reused = new Set(input.plan.reusedPaths);
  return input.currentManifest.map((manifest) => {
    const fresh = recomputed.get(manifest.path);
    if (fresh) return cloneParsedFile(fresh);
    const cached = previous.get(manifest.path);
    if (!cached || !reused.has(manifest.path) || cached.digest !== manifest.digest || cached.bytes !== manifest.bytes) {
      throw new Error(`incremental_cache_miss:${manifest.path}`);
    }
    return cloneParsedFile(cached);
  });
}

export function lspTargetFiles(
  files: ParsedFile[],
  language: string,
  plan: IncrementalPlan,
): ParsedFile[] {
  const languageFiles = files.filter((file) => file.language === language);
  if (plan.mode === "full") return languageFiles;
  const affected = new Set(plan.affectedPaths);
  return languageFiles.filter((file) => affected.has(file.path));
}

export function mergeLspResult(input: {
  language: string;
  previous: LspRunResult | null;
  fresh: LspRunResult | null;
  invalidatedPaths: Set<string>;
  currentPaths: Set<string>;
}): LspRunResult {
  if (!input.previous && !input.fresh) return unavailableLspResult(input.language, "lsp_unavailable");
  const previousSymbols = input.previous?.symbols.filter((symbol) =>
    input.currentPaths.has(symbol.path) && !input.invalidatedPaths.has(symbol.path)) ?? [];
  const previousRelations = input.previous?.relations.filter((relation) =>
    input.currentPaths.has(relation.sourcePath)
    && input.currentPaths.has(relation.targetPath)
    && !input.invalidatedPaths.has(relation.sourcePath)
    && !input.invalidatedPaths.has(relation.targetPath)) ?? [];
  const fresh = input.fresh;
  const symbols = dedupeBy(
    [...previousSymbols, ...(fresh?.symbols ?? [])],
    (symbol) => [symbol.path, symbol.qualifiedName, symbol.startLine, symbol.startColumn].join("|"),
  );
  const relations = dedupeBy(
    [...previousRelations, ...(fresh?.relations ?? [])],
    (relation) => [
      relation.kind,
      relation.sourcePath,
      relation.sourceName,
      relation.sourceLine,
      relation.sourceColumn,
      relation.targetPath,
      relation.targetName,
      relation.targetLine,
      relation.targetColumn,
    ].join("|"),
  );
  return {
    language: input.language,
    completed: Boolean(fresh?.completed || input.previous?.completed || symbols.length),
    truthVerified: fresh
      ? fresh.truthVerified && (input.previous?.truthVerified ?? true)
      : Boolean(input.previous?.truthVerified),
    serverName: fresh?.serverName ?? input.previous?.serverName ?? null,
    serverVersion: fresh?.serverVersion ?? input.previous?.serverVersion ?? null,
    capabilities: [...new Set([...(input.previous?.capabilities ?? []), ...(fresh?.capabilities ?? [])])],
    reasonCodes: [...new Set([
      ...(input.previous?.reasonCodes ?? []).filter(code => code !== "incremental_reuse"),
      ...(fresh?.reasonCodes ?? []).filter(code => code !== "incremental_reuse"),
      ...(previousSymbols.length || previousRelations.length ? ["incremental_reuse"] : []),
    ])],
    symbols,
    relations,
  };
}

export function applyIncrementalProvenance(input: {
  snapshot: BuiltSnapshot;
  previousFactGraph: FactGraph | null;
  plan: IncrementalPlan;
  currentParsedFiles: ParsedFile[];
}): BuiltSnapshot {
  const snapshotId = input.snapshot.snapshot_id;
  const parsedByPath = new Map(input.currentParsedFiles.map((file) => [file.path, file]));
  const affectedPaths = new Set(input.plan.affectedPaths);
  const reusedPaths = new Set(input.plan.reusedPaths);
  const directPaths = new Set(input.plan.changes.flatMap((change) => [change.path, ...(change.renamed_from ? [change.renamed_from] : [])]));

  // A full analysis has no previous graph to protect. Mutating the freshly
  // built fact rows avoids retaining a second copy of every file/symbol fact.
  if (input.plan.mode === "full" && !input.previousFactGraph) {
    const nodePathById = new Map(input.snapshot.fact_graph.nodes.map((node) => [node.id, nodePath(node)]));
    for (const node of input.snapshot.fact_graph.nodes) {
      const path = nodePath(node);
      node.lifecycle_status = "active";
      node.tombstoned_at_snapshot_id = null;
      node.superseded_by = null;
      node.first_seen_snapshot_id = snapshotId;
      node.last_seen_snapshot_id = snapshotId;
      node.revision_id = revision("node", node);
      node.incremental_provenance = {
        change_kind: "added",
        reused_from_snapshot_id: null,
        affected_by_stable_ids: path && affectedPaths.has(path) ? boundedAffectedIds(input.plan.affectedStableIds) : [],
        recompute_reason: "full_analysis",
        cache_key: path ? parsedByPath.get(path)?.digest ?? null : null,
        cache_hit: false,
      };
    }
    for (const edge of input.snapshot.fact_graph.edges) {
      const sourcePath = nodePathById.get(edge.source) ?? null;
      const targetPath = nodePathById.get(edge.target) ?? null;
      edge.lifecycle_status = "active";
      edge.tombstoned_at_snapshot_id = null;
      edge.superseded_by = null;
      edge.first_seen_snapshot_id = snapshotId;
      edge.last_seen_snapshot_id = snapshotId;
      edge.revision_id = revision("edge", edge);
      edge.incremental_provenance = {
        change_kind: "added",
        reused_from_snapshot_id: null,
        affected_by_stable_ids: sourcePath && affectedPaths.has(sourcePath) || targetPath && affectedPaths.has(targetPath)
          ? boundedAffectedIds(input.plan.affectedStableIds)
          : [],
        recompute_reason: "full_analysis",
        cache_key: null,
        cache_hit: false,
      };
    }
    return {
      ...input.snapshot,
      parent_snapshot_id: null,
      analysis_mode: "full",
      active_fact_fingerprint: activeFactFingerprint(input.snapshot),
    };
  }

  const previousNodes = new Map((input.previousFactGraph?.nodes ?? [])
    .filter(isActiveNode)
    .map((node) => [node.id, node]));
  const previousEdges = new Map((input.previousFactGraph?.edges ?? [])
    .filter(isActiveEdge)
    .map((edge) => [edge.id, edge]));
  const changedByPath = new Map<string, FileChange>();
  for (const change of input.plan.changes) {
    changedByPath.set(change.path, change);
    if (change.renamed_from) changedByPath.set(change.renamed_from, change);
  }

  const nodes: SnapshotNode[] = input.snapshot.fact_graph.nodes.map((node): SnapshotNode => {
    const previous = previousNodes.get(node.id);
    const path = nodePath(node);
    const revisionId = revision("node", node);
    const reused = Boolean(previous && path && reusedPaths.has(path) && previous.revision_id === revisionId);
    const change = path ? changedByPath.get(path) : undefined;
    const changeKind = reused ? "reused" : change?.kind ?? (previous ? "recomputed" : "added");
    return {
      ...node,
      lifecycle_status: "active" as const,
      tombstoned_at_snapshot_id: null,
      superseded_by: null,
      first_seen_snapshot_id: previous?.first_seen_snapshot_id ?? (previous ? input.plan.parentSnapshotId : snapshotId),
      last_seen_snapshot_id: snapshotId,
      revision_id: revisionId,
      incremental_provenance: {
        change_kind: changeKind,
        reused_from_snapshot_id: reused ? input.plan.parentSnapshotId : null,
        affected_by_stable_ids: path && affectedPaths.has(path) ? boundedAffectedIds(input.plan.affectedStableIds) : [],
        recompute_reason: reused
          ? "unchanged_file_outside_affected_closure"
          : path && directPaths.has(path)
            ? "direct_file_change"
            : path && affectedPaths.has(path)
              ? "reverse_dependency_closure"
              : input.plan.mode === "full" ? "full_analysis" : "new_fact",
        cache_key: path ? parsedByPath.get(path)?.digest ?? null : null,
        cache_hit: reused,
      },
    };
  });
  const activeNodeIds = new Set(nodes.map((node) => node.id));
  const tombstonePathSet = new Set(input.plan.tombstonePaths);
  for (const previous of previousNodes.values()) {
    if (activeNodeIds.has(previous.id)) continue;
    const path = nodePath(previous);
    const extractionSucceeded = path ? parsedByPath.get(path)?.parseError === null : false;
    if (!path || (!tombstonePathSet.has(path) && !(affectedPaths.has(path) && extractionSucceeded))) continue;
    const change = changedByPath.get(path);
    nodes.push({
      ...previous,
      members: [],
      evidence: [],
      certainty: "historical",
      lifecycle_status: "tombstoned",
      tombstoned_at_snapshot_id: snapshotId,
      last_seen_snapshot_id: input.plan.parentSnapshotId,
      superseded_by: change?.kind === "renamed" ? findRenamedReplacement(previous, nodes, change.path) : null,
      revision_id: revision("node", { ...previous, lifecycle_status: "tombstoned", tombstoned_at_snapshot_id: snapshotId }),
      incremental_provenance: {
        change_kind: change?.kind === "renamed" ? "renamed" : "deleted",
        reused_from_snapshot_id: input.plan.parentSnapshotId,
        affected_by_stable_ids: boundedAffectedIds(input.plan.affectedStableIds),
        recompute_reason: "fact_absent_after_successful_reanalysis",
        cache_key: null,
        cache_hit: false,
      },
    });
  }

  const nodePathById = new Map(nodes.map((node) => [node.id, nodePath(node)]));
  const edges: SnapshotEdge[] = input.snapshot.fact_graph.edges.map((edge): SnapshotEdge => {
    const previous = previousEdges.get(edge.id);
    const sourcePath = nodePathById.get(edge.source) ?? null;
    const targetPath = nodePathById.get(edge.target) ?? null;
    const revisionId = revision("edge", edge);
    const reused = Boolean(
      previous
      && previous.revision_id === revisionId
      && (!sourcePath || reusedPaths.has(sourcePath))
      && (!targetPath || reusedPaths.has(targetPath)),
    );
    return {
      ...edge,
      lifecycle_status: "active" as const,
      tombstoned_at_snapshot_id: null,
      superseded_by: null,
      first_seen_snapshot_id: previous?.first_seen_snapshot_id ?? (previous ? input.plan.parentSnapshotId : snapshotId),
      last_seen_snapshot_id: snapshotId,
      revision_id: revisionId,
      incremental_provenance: {
        change_kind: reused ? "reused" : previous ? "recomputed" : "added",
        reused_from_snapshot_id: reused ? input.plan.parentSnapshotId : null,
        affected_by_stable_ids: sourcePath && affectedPaths.has(sourcePath) || targetPath && affectedPaths.has(targetPath)
          ? boundedAffectedIds(input.plan.affectedStableIds)
          : [],
        recompute_reason: reused ? "unchanged_endpoints" : input.plan.mode === "full" ? "full_analysis" : "edge_recomputed_from_current_facts",
        cache_key: null,
        cache_hit: reused,
      },
    };
  });
  const activeEdgeIds = new Set(edges.map((edge) => edge.id));
  const previousNodePaths = new Map((input.previousFactGraph?.nodes ?? []).map((node) => [node.id, nodePath(node)]));
  for (const previous of previousEdges.values()) {
    if (activeEdgeIds.has(previous.id)) continue;
    const sourcePath = previousNodePaths.get(previous.source) ?? null;
    const targetPath = previousNodePaths.get(previous.target) ?? null;
    const shouldTombstone = Boolean(
      sourcePath && (tombstonePathSet.has(sourcePath) || affectedPaths.has(sourcePath))
      || targetPath && (tombstonePathSet.has(targetPath) || affectedPaths.has(targetPath)),
    );
    if (!shouldTombstone) continue;
    edges.push({
      ...previous,
      evidence: [],
      certainty: "historical",
      lifecycle_status: "tombstoned",
      tombstoned_at_snapshot_id: snapshotId,
      last_seen_snapshot_id: input.plan.parentSnapshotId,
      superseded_by: null,
      revision_id: revision("edge", { ...previous, lifecycle_status: "tombstoned", tombstoned_at_snapshot_id: snapshotId }),
      incremental_provenance: {
        change_kind: "deleted",
        reused_from_snapshot_id: input.plan.parentSnapshotId,
        affected_by_stable_ids: boundedAffectedIds(input.plan.affectedStableIds),
        recompute_reason: "edge_absent_after_successful_reanalysis",
        cache_key: null,
        cache_hit: false,
      },
    });
  }

  const withFacts: BuiltSnapshot = {
    ...input.snapshot,
    parent_snapshot_id: input.plan.parentSnapshotId,
    analysis_mode: input.plan.mode,
    fact_graph: { nodes, edges },
  };
  return {
    ...withFacts,
    active_fact_fingerprint: activeFactFingerprint(withFacts),
  };
}

export function activeFactFingerprint(snapshot: Pick<BuiltSnapshot, "fact_graph">): string {
  // Hash each fact independently and sort only fixed-size digests. Building a
  // canonical clone for every fact and then serializing the complete graph can
  // retain several copies of a large repository in memory and starve the
  // worker heartbeat while the snapshot is being closed.
  const nodeDigests = snapshot.fact_graph.nodes
    .filter(isActiveNode)
    .map((node) => canonicalFactDigest(node))
    .sort();
  const edgeDigests = snapshot.fact_graph.edges
    .filter(isActiveEdge)
    .map((edge) => canonicalFactDigest(edge))
    .sort();
  const hash = createHash("sha256");
  hash.update("nodes\0");
  for (const digest of nodeDigests) hash.update(digest).update("\0");
  hash.update("edges\0");
  for (const digest of edgeDigests) hash.update(digest).update("\0");
  return hash.digest("hex");
}

export function incrementalSummary(plan: IncrementalPlan): Record<string, unknown> {
  const total = plan.reusedPaths.length + plan.recomputePaths.length;
  return {
    mode: plan.mode,
    parent_snapshot_id: plan.parentSnapshotId,
    changes: plan.changes,
    affected_paths: plan.affectedPaths,
    files_recomputed: plan.recomputePaths.length,
    files_reused: plan.reusedPaths.length,
    cache_reuse_ratio: total ? plan.reusedPaths.length / total : 1,
  };
}

function cloneParsedFile(file: ParsedFile): ParsedFile {
  return {
    ...file,
    symbols: file.symbols.map((symbol) => ({
      ...symbol,
      bases: [...symbol.bases],
      sources: [...symbol.sources],
    })),
    imports: file.imports.map((item) => ({ ...item })),
    calls: file.calls.map((item) => ({ ...item, ...(item.target ? { target: { ...item.target } } : {}) })),
  };
}

function cloneLspResult(result: LspRunResult): LspRunResult {
  return {
    ...result,
    capabilities: [...result.capabilities],
    reasonCodes: [...result.reasonCodes],
    symbols: result.symbols.map((item) => ({ ...item })),
    relations: result.relations.map((item) => ({ ...item })),
  };
}

function nodePath(node: SnapshotNode): string | null {
  const path = node.attributes?.path;
  if (typeof path === "string" && path) return path;
  return node.evidence[0]?.path ?? node.members[0]?.path ?? null;
}

function isActiveNode(node: SnapshotNode): boolean {
  return node.lifecycle_status !== "tombstoned" && node.lifecycle_status !== "superseded";
}

function isActiveEdge(edge: SnapshotEdge): boolean {
  return edge.lifecycle_status !== "tombstoned" && edge.lifecycle_status !== "superseded";
}

function revision(kind: "node" | "edge", value: unknown): string {
  const hash = createHash("sha256");
  writeCanonicalJson(hash, value);
  const digest = hash.digest("hex").slice(0, 24);
  return `rev:${kind}:${digest}`;
}

function canonicalFact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFact);
  if (!isRecord(value)) return value;
  const ignored = new Set([
    "incremental_provenance",
    "first_seen_snapshot_id",
    "last_seen_snapshot_id",
    "revision_id",
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ignored.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalFact(item)]));
}

const CANONICAL_IGNORED_KEYS = new Set([
  "incremental_provenance",
  "first_seen_snapshot_id",
  "last_seen_snapshot_id",
  "revision_id",
]);

function canonicalFactDigest(value: unknown): string {
  const hash = createHash("sha256");
  writeCanonicalFact(hash, value);
  return hash.digest("hex");
}

/**
 * Deterministic JSON-like encoding that writes directly into a hash. Facts are
 * JSON data, so explicit type/length markers avoid ambiguity without creating
 * a full canonical object or string in memory.
 */
function writeCanonicalFact(hash: Hash, value: unknown): void {
  if (value === null) {
    hash.update("null;");
    return;
  }
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}[`);
    for (const item of value) writeCanonicalFact(hash, item);
    hash.update("];" );
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([key, item]) => !CANONICAL_IGNORED_KEYS.has(key) && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    hash.update(`object:${entries.length}{`);
    for (const [key, item] of entries) {
      const encodedKey = JSON.stringify(key);
      hash.update(`key:${encodedKey.length}:`).update(encodedKey);
      writeCanonicalFact(hash, item);
    }
    hash.update("};");
    return;
  }
  if (value === undefined) {
    hash.update("undefined;");
    return;
  }
  if (typeof value === "string") {
    const encoded = JSON.stringify(value);
    hash.update(`string:${encoded.length}:`).update(encoded);
    return;
  }
  if (typeof value === "number") {
    hash.update(`number:${JSON.stringify(value)};`);
    return;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "boolean:true;" : "boolean:false;");
    return;
  }
  hash.update(`other:${JSON.stringify(String(value))};`);
}

/** Preserve the legacy revision digest while avoiding a full canonical clone. */
function writeCanonicalJson(hash: Hash, value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    hash.update("null");
    return;
  }
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    hash.update(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((item, index) => {
      if (index) hash.update(",");
      writeCanonicalJson(hash, item);
    });
    hash.update("]");
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([key]) => !CANONICAL_IGNORED_KEYS.has(key) && value[key] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    hash.update("{");
    entries.forEach(([key, item], index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key)).update(":");
      writeCanonicalJson(hash, item);
    });
    hash.update("}");
    return;
  }
  hash.update("null");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalFact(value));
}

function compareCanonical(left: unknown, right: unknown): number {
  return stableStringify(left).localeCompare(stableStringify(right));
}

function boundedAffectedIds(values: string[]): string[] {
  return values.slice(0, 32);
}

function findRenamedReplacement(previous: SnapshotNode, current: SnapshotNode[], newPath: string): string | null {
  const qualifiedName = previous.attributes?.qualified_name;
  const kind = previous.attributes?.kind;
  return current.find((candidate) =>
    nodePath(candidate) === newPath
    && candidate.attributes?.qualified_name === qualifiedName
    && candidate.attributes?.kind === kind)?.id ?? null;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const rows = new Map<string, T>();
  for (const item of items) if (!rows.has(key(item))) rows.set(key(item), item);
  return [...rows.values()];
}

function isManifestEntry(value: unknown): value is SourceFileManifest {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.digest === "string"
    && /^[0-9a-f]{64}$/i.test(value.digest)
    && Number.isInteger(value.bytes)
    && Number(value.bytes) >= 0;
}

function isParsedFile(value: unknown): value is ParsedFile {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.language === "string"
    && typeof value.digest === "string"
    && Number.isInteger(value.bytes)
    && Array.isArray(value.symbols)
    && Array.isArray(value.imports)
    && Array.isArray(value.calls);
}

function isLspRunResult(value: unknown): value is LspRunResult {
  return isRecord(value)
    && typeof value.language === "string"
    && typeof value.completed === "boolean"
    && typeof value.truthVerified === "boolean"
    && Array.isArray(value.capabilities)
    && Array.isArray(value.reasonCodes)
    && Array.isArray(value.symbols)
    && Array.isArray(value.relations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
