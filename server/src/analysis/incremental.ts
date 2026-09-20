import { createHash } from "node:crypto";
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
} from "./facts.js";

export const ANALYSIS_CACHE_SCHEMA_VERSION = "analysis-cache-v3-project-facts";

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
  syntax_files: ParsedFile[];
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
  syntaxFiles?: ParsedFile[];
  lspResults: LspRunResult[];
}): AnalysisCache {
  return {
    schema_version: ANALYSIS_CACHE_SCHEMA_VERSION,
    manifest: input.manifest.map((item) => ({ ...item })),
    // Analysis outputs are immutable values. Serialization owns the persisted
    // copy; duplicating every declaration/call here doubles peak stage memory.
    parsed_files: input.parsedFiles,
    syntax_files: input.syntaxFiles ?? [],
    lsp_results: input.lspResults,
  };
}

/** Transfer an exclusively owned publication checkpoint's compiler data.
 * The persisted checkpoint is unchanged and remains available after a failure.
 */
export function takeCheckpointAnalysisCache(checkpoint: {
  fetched: { manifest: SourceFileManifest[] };
  parsed?: ParsedFile[];
  syntax_files?: ParsedFile[];
  lsp_results?: LspRunResult[];
  previous_fact_graph?: FactGraph | null;
  plan?: IncrementalPlan;
}): AnalysisCache | undefined {
  if (!checkpoint.parsed || !checkpoint.lsp_results || !checkpoint.plan) return undefined;
  const cache = createAnalysisCache({ manifest: checkpoint.fetched.manifest,
    parsedFiles: checkpoint.parsed, syntaxFiles: checkpoint.syntax_files, lspResults: checkpoint.lsp_results });
  delete checkpoint.parsed;
  delete checkpoint.syntax_files;
  delete checkpoint.lsp_results;
  delete checkpoint.previous_fact_graph;
  return cache;
}

export function readAnalysisCache(value: unknown): AnalysisCache | null {
  if (!isRecord(value) || value.schema_version !== ANALYSIS_CACHE_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.manifest) || !Array.isArray(value.parsed_files) || !Array.isArray(value.lsp_results)) return null;
  const manifest = value.manifest.filter(isManifestEntry).map((item) => ({ ...item }));
  const parsedFiles = value.parsed_files.filter(isParsedFile);
  const lspResults = value.lsp_results.filter(isLspRunResult);
  if (manifest.length !== value.manifest.length || parsedFiles.length !== value.parsed_files.length || lspResults.length !== value.lsp_results.length) return null;
  const manifestPaths = new Set(manifest.map((item) => item.path));
  const parsedByPath = new Map(parsedFiles.map((file) => [file.path, file]));
  const syntaxFiles = Array.isArray(value.syntax_files) ? value.syntax_files.filter(isParsedFile) : [];
  if (!Array.isArray(value.syntax_files) || syntaxFiles.length !== value.syntax_files.length
    || new Set(syntaxFiles.map(file=>file.path)).size !== syntaxFiles.length
    || syntaxFiles.some(file => {
      const parsed=parsedByPath.get(file.path);
      return !parsed || parsed.digest!==file.digest || parsed.bytes!==file.bytes;
    })) return null;
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
    syntax_files: syntaxFiles,
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
  currentCompleteness?: import("./facts.js").SourceCompleteness;
}): IncrementalPlan {
  const omitted = new Set(input.currentCompleteness?.omitted.map(row=>row.path) ?? []);
  const changes = classifyFileChanges(input.previousCache.manifest, input.currentManifest).filter(change =>
    change.kind !== "deleted" || input.currentCompleteness?.inventoryComplete === true && !omitted.has(change.path)).map(change =>
      change.kind === "renamed" && (input.currentCompleteness?.inventoryComplete !== true || omitted.has(change.renamed_from!))
        ? { ...change, kind: "added" as const, renamed_from: null, previous_digest: null } : change);
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
  // Semantics may change without an old successful edge (new files, failed lookups,
  // declarations, package exports). Invalidate project domains, not just old edges.
  const affectedPaths = new Set(changedPaths);
  const changedLanguages = new Set(input.previousCache.parsed_files.filter(f => changedPaths.has(f.path)).map(f => f.language));
  const structural = changes.some(c => c.kind !== 'modified' || /\.(json|toml|xml|mod|work|csproj|props|targets)$/.test(c.path));
  const projects = new Set(input.previousCache.parsed_files.filter(f => changedPaths.has(f.path)).map(f => f.project?.id));
  for (const file of input.previousCache.parsed_files) {
    if (structural || projects.has(file.project?.id) || changedLanguages.has(file.language)) affectedPaths.add(file.path);
  }
  for (const node of input.previousFactGraph.nodes) if (affectedPaths.has(nodePath(node) ?? '')) affectedIds.add(node.id);
  const currentPaths = new Set(input.currentManifest.map((item) => item.path));
  const recomputePaths = [...changedPaths].filter((path) => currentPaths.has(path)).sort();
  const reusedPaths = [...currentPaths].filter((path) => !changedPaths.has(path)).sort();
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

export function applyIncrementalProvenance(input: {
  snapshot: BuiltSnapshot;
  previousFactGraph: FactGraph | null;
  plan: IncrementalPlan;
  currentParsedFiles: ParsedFile[];
  /** Current rows are exclusively owned by publication, never the previous graph. */
  takeOwnership?: boolean;
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
    return Object.assign(input.takeOwnership && previous !== node ? node : { ...node }, {
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
    });
  });
  const activeNodeIds = new Set(nodes.map((node) => node.id));
  const tombstonePathSet = new Set(input.plan.tombstonePaths);
  for (const previous of previousNodes.values()) {
    if (activeNodeIds.has(previous.id)) continue;
    const path = nodePath(previous);
    const parsed = path ? parsedByPath.get(path) : undefined;
    const fromLsp = previous.source_observations?.some(observation => observation.extractor === "lsp");
    const extractionSucceeded = parsed?.parseError === null && (!fromLsp || parsed.semanticComplete === true);
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
    return Object.assign(input.takeOwnership && previous !== edge ? edge : { ...edge }, {
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
    });
  });
  const activeEdgeIds = new Set(edges.map((edge) => edge.id));
  const previousNodePaths = new Map((input.previousFactGraph?.nodes ?? []).map((node) => [node.id, nodePath(node)]));
  for (const previous of previousEdges.values()) {
    if (activeEdgeIds.has(previous.id)) continue;
    const sourcePath = previousNodePaths.get(previous.source) ?? null;
    const targetPath = previousNodePaths.get(previous.target) ?? null;
    const lspEdge = previous.source_observations?.some(row=>row.extractor === "lsp");
    const completed = [sourcePath, targetPath].filter((p): p is string => !!p).every(p => tombstonePathSet.has(p)
      || parsedByPath.get(p)?.parseError === null && (!lspEdge || parsedByPath.get(p)?.semanticComplete === true));
    const shouldTombstone = completed && Boolean(
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

export function activeFactFingerprint(snapshot: Pick<BuiltSnapshot, 'fact_graph'>): string {
  const hash = createHash('sha256');
  const group = <T>(name: string, rows: T[], active: (row: T) => boolean) => {
    const digests: string[] = [];
    for (const row of rows) if (active(row)) digests.push(canonicalFactDigest(row));
    digests.sort();
    hash.update(name).update('\0');
    for (const digest of digests) hash.update(digest).update('\0');
  };
  group('nodes', snapshot.fact_graph.nodes, isActiveNode);
  group('edges', snapshot.fact_graph.edges, isActiveEdge);
  return hash.digest('hex');
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
  const hash = new CanonicalHashWriter();
  writeCanonicalJson(hash, value);
  const digest = hash.digest().slice(0, 24);
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
  const hash = new CanonicalHashWriter();
  writeCanonicalFact(hash, value);
  return hash.digest();
}

/**
 * Deterministic JSON-like encoding that writes directly into a hash. Facts are
 * JSON data, so explicit type/length markers avoid ambiguity without creating
 * a full canonical object or string in memory.
 */
function writeCanonicalFact(hash: CanonicalHashWriter, value: unknown): void {
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
function writeCanonicalJson(hash: CanonicalHashWriter, value: unknown): void {
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
  const matches = current.filter((candidate) =>
    nodePath(candidate) === newPath
    && candidate.attributes?.qualified_name === qualifiedName
    && candidate.attributes?.kind === kind
    && candidate.attributes?.tracking_key === previous.attributes?.tracking_key
    && isActiveNode(candidate));
  return matches.length === 1 ? matches[0]!.id : null;
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
    && typeof value.toolchainVerified === "boolean"
    && Array.isArray(value.capabilities)
    && Array.isArray(value.reasonCodes)
    && Array.isArray(value.symbols)
    && Array.isArray(value.relations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Batch tiny canonical tokens without retaining a repository-sized representation. */
class CanonicalHashWriter {
  private readonly hash = createHash('sha256');
  private parts: string[] = [];
  private characters = 0;
  update(value: string): this {
    this.parts.push(value);
    this.characters += value.length;
    if (this.characters >= 16_384) this.flush();
    return this;
  }
  private flush(): void {
    if (!this.parts.length) return;
    this.hash.update(this.parts.join(''));
    this.parts = [];
    this.characters = 0;
  }
  digest(): string { this.flush(); return this.hash.digest('hex'); }
}
