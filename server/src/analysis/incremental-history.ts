import type { SnapshotEdge, SnapshotNode } from "../domain/snapshot.js";
import type { BuiltSnapshot } from "./graph.js";
import type { ParsedFile } from "./facts.js";
import type { IncrementalPlan } from "./incremental.js";
import {
  FACT_LINEAGE_ACTIVE, FACT_LINEAGE_LSP, type EdgeLineageRow, type NodeLineageRow,
} from "../persistence/fact-lineage.js";

export interface HistoricalFactIdentity {
  id: string;
  revision_id?: string;
  first_seen_snapshot_id?: string | null;
}

/** Only vanished facts that may be published as tombstones retain full rows. */
export interface IncrementalHistoryProjection {
  kind: "incremental-history-projection-v1";
  /** Includes inactive nodes because edge deletion checks their old paths too. */
  nodePaths: ReadonlyMap<string, string | null>;
  matchedNodes: HistoricalFactIdentity[];
  matchedEdges: HistoricalFactIdentity[];
  tombstoneNodes: SnapshotNode[];
  tombstoneEdges: SnapshotEdge[];
}

interface FactSummary {
  id: string;
  revision_id: string | null;
  first_seen_snapshot_id: string | null;
  active: boolean;
  lsp: boolean;
}

/** Tombstones selected from lineage, awaiting their complete historical rows. */
interface PendingTombstone { ordinal: number; id: string; revision_id: string | null }

export function createIncrementalHistorySelector(input: {
  snapshot?: Pick<BuiltSnapshot, "fact_graph">;
  currentFactIds?: { nodes: readonly string[]; edges: readonly string[] };
  plan: IncrementalPlan;
  currentParsedFiles: Pick<ParsedFile, "path" | "parseError" | "semanticComplete">[];
}): {
  addNode: (row: SnapshotNode) => void;
  addEdge: (row: SnapshotEdge) => void;
  addNodeLineage: (row: NodeLineageRow, ordinal: number) => void;
  addEdgeLineage: (row: EdgeLineageRow, ordinal: number) => void;
  /** Graph ordinals whose full rows are needed after a lineage visit. */
  pendingTombstones: () => { nodes: number[]; edges: number[] };
  resolveTombstones: (rows: { nodes: ReadonlyMap<number, unknown>; edges: ReadonlyMap<number, unknown> }) => void;
  finish: () => IncrementalHistoryProjection;
} {
  if (!input.snapshot && !input.currentFactIds) throw new Error('incremental_history_current_facts_missing');
  const currentNodeIds = new Set(input.currentFactIds?.nodes ?? input.snapshot!.fact_graph.nodes.map(row => row.id));
  const currentEdgeIds = new Set(input.currentFactIds?.edges ?? input.snapshot!.fact_graph.edges.map(row => row.id));
  const parsedByPath = new Map(input.currentParsedFiles.map(row => [row.path, row]));
  const affectedPaths = new Set(input.plan.affectedPaths);
  const tombstonePaths = new Set(input.plan.tombstonePaths);
  const nodePaths = new Map<string, string | null>();
  const lineageNodeIds: string[] = [];
  const matchedNodes: HistoricalFactIdentity[] = [];
  const matchedEdges: HistoricalFactIdentity[] = [];
  const tombstoneNodes: SnapshotNode[] = [];
  const tombstoneEdges: SnapshotEdge[] = [];
  const pendingNodes: PendingTombstone[] = [];
  const pendingEdges: PendingTombstone[] = [];
  let readingEdges = false;

  /** Returns true when the vanished node must become a tombstone. */
  const node = (fact: FactSummary, path: string | null): boolean => {
    if (readingEdges) throw new Error("incremental_history_nodes_after_edges");
    nodePaths.set(fact.id, path);
    if (!fact.active) return false;
    if (currentNodeIds.has(fact.id)) {
      matchedNodes.push(identity(fact));
      return false;
    }
    if (!path) return false;
    const parsed = parsedByPath.get(path);
    const extractionSucceeded = parsed?.parseError === null && (!fact.lsp || parsed.semanticComplete === true);
    return tombstonePaths.has(path) || affectedPaths.has(path) && extractionSucceeded;
  };
  const edge = (fact: FactSummary, source: string, target: string): boolean => {
    readingEdges = true;
    if (!fact.active) return false;
    if (currentEdgeIds.has(fact.id)) {
      matchedEdges.push(identity(fact));
      return false;
    }
    const sourcePath = nodePaths.get(source) ?? null;
    const targetPath = nodePaths.get(target) ?? null;
    const completed = [sourcePath, targetPath].filter((path): path is string => Boolean(path))
      .every(path => tombstonePaths.has(path)
        || parsedByPath.get(path)?.parseError === null
          && (!fact.lsp || parsedByPath.get(path)?.semanticComplete === true));
    const affected = Boolean(
      sourcePath && (tombstonePaths.has(sourcePath) || affectedPaths.has(sourcePath))
      || targetPath && (tombstonePaths.has(targetPath) || affectedPaths.has(targetPath)),
    );
    return completed && affected;
  };
  const lineageEndpoint = (value: number | string): string => {
    if (typeof value === 'string') return value;
    const id = lineageNodeIds[value];
    if (id === undefined) throw new Error('analysis_fact_lineage_invalid');
    return id;
  };
  const resolve = <T extends SnapshotNode | SnapshotEdge>(pending: PendingTombstone[], rows: ReadonlyMap<number, unknown>, target: T[]) => {
    for (const expected of pending) {
      const row = rows.get(expected.ordinal) as T | undefined;
      // The lineage and graph are published together; any drift is corruption.
      if (!row || row.id !== expected.id || (row.revision_id ?? null) !== expected.revision_id) {
        throw new Error('analysis_fact_lineage_mismatch');
      }
      target.push(row);
    }
    pending.length = 0;
  };

  return {
    addNode(row) {
      if (node(fullSummary(row), historicalNodePath(row))) tombstoneNodes.push(row);
    },
    addEdge(row) {
      if (edge(fullSummary(row), row.source, row.target)) tombstoneEdges.push(row);
    },
    addNodeLineage(row, ordinal) {
      if (ordinal !== lineageNodeIds.length) throw new Error('analysis_fact_lineage_invalid');
      lineageNodeIds.push(row[0]);
      if (node(lineageSummary(row[0], row[1], row[2], row[4]), row[3])) {
        pendingNodes.push({ ordinal, id: row[0], revision_id: row[1] });
      }
    },
    addEdgeLineage(row, ordinal) {
      if (edge(lineageSummary(row[0], row[1], row[2], row[5]), lineageEndpoint(row[3]), lineageEndpoint(row[4]))) {
        pendingEdges.push({ ordinal, id: row[0], revision_id: row[1] });
      }
    },
    pendingTombstones() {
      return { nodes: pendingNodes.map(row => row.ordinal), edges: pendingEdges.map(row => row.ordinal) };
    },
    resolveTombstones(rows) {
      resolve(pendingNodes, rows.nodes, tombstoneNodes);
      resolve(pendingEdges, rows.edges, tombstoneEdges);
    },
    finish() {
      if (pendingNodes.length || pendingEdges.length) throw new Error('incremental_history_tombstones_unresolved');
      lineageNodeIds.length = 0;
      return { kind: "incremental-history-projection-v1", nodePaths,
        matchedNodes, matchedEdges, tombstoneNodes, tombstoneEdges };
    },
  };
}

function fullSummary(row: SnapshotNode | SnapshotEdge): FactSummary {
  return {
    id: row.id,
    revision_id: row.revision_id ?? null,
    first_seen_snapshot_id: row.first_seen_snapshot_id ?? null,
    active: row.lifecycle_status !== "tombstoned" && row.lifecycle_status !== "superseded",
    lsp: row.source_observations?.some(observation => observation.extractor === "lsp") === true,
  };
}

function lineageSummary(id: string, revision: string | null, firstSeen: string | null, flags: number): FactSummary {
  return {
    id, revision_id: revision, first_seen_snapshot_id: firstSeen,
    active: (flags & FACT_LINEAGE_ACTIVE) !== 0,
    lsp: (flags & FACT_LINEAGE_LSP) !== 0,
  };
}

function historicalNodePath(row: SnapshotNode): string | null {
  const path = row.attributes?.path;
  if (typeof path === "string" && path) return path;
  return row.evidence[0]?.path ?? row.members[0]?.path ?? null;
}

function identity(fact: FactSummary): HistoricalFactIdentity {
  return {
    id: fact.id,
    ...(fact.revision_id === null ? {} : { revision_id: fact.revision_id }),
    ...(fact.first_seen_snapshot_id === null ? {} : { first_seen_snapshot_id: fact.first_seen_snapshot_id }),
  };
}
