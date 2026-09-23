import type { SnapshotEdge, SnapshotNode } from "../domain/snapshot.js";
import type { BuiltSnapshot } from "./graph.js";
import type { ParsedFile } from "./facts.js";
import type { IncrementalPlan } from "./incremental.js";

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

export function createIncrementalHistorySelector(input: {
  snapshot: Pick<BuiltSnapshot, "fact_graph">;
  plan: IncrementalPlan;
  currentParsedFiles: Pick<ParsedFile, "path" | "parseError" | "semanticComplete">[];
}): {
  addNode: (row: SnapshotNode) => void;
  addEdge: (row: SnapshotEdge) => void;
  finish: () => IncrementalHistoryProjection;
} {
  const currentNodeIds = new Set(input.snapshot.fact_graph.nodes.map(row => row.id));
  const currentEdgeIds = new Set(input.snapshot.fact_graph.edges.map(row => row.id));
  const parsedByPath = new Map(input.currentParsedFiles.map(row => [row.path, row]));
  const affectedPaths = new Set(input.plan.affectedPaths);
  const tombstonePaths = new Set(input.plan.tombstonePaths);
  const nodePaths = new Map<string, string | null>();
  const matchedNodes: HistoricalFactIdentity[] = [];
  const matchedEdges: HistoricalFactIdentity[] = [];
  const tombstoneNodes: SnapshotNode[] = [];
  const tombstoneEdges: SnapshotEdge[] = [];
  let readingEdges = false;

  return {
    addNode(row) {
      if (readingEdges) throw new Error("incremental_history_nodes_after_edges");
      const path = historicalNodePath(row);
      nodePaths.set(row.id, path);
      if (!isActive(row)) return;
      if (currentNodeIds.has(row.id)) {
        matchedNodes.push(identity(row));
        return;
      }
      if (!path) return;
      const parsed = parsedByPath.get(path);
      const fromLsp = row.source_observations?.some(observation => observation.extractor === "lsp");
      const extractionSucceeded = parsed?.parseError === null && (!fromLsp || parsed.semanticComplete === true);
      if (tombstonePaths.has(path) || affectedPaths.has(path) && extractionSucceeded) {
        tombstoneNodes.push(row);
      }
    },
    addEdge(row) {
      readingEdges = true;
      if (!isActive(row)) return;
      if (currentEdgeIds.has(row.id)) {
        matchedEdges.push(identity(row));
        return;
      }
      const sourcePath = nodePaths.get(row.source) ?? null;
      const targetPath = nodePaths.get(row.target) ?? null;
      const fromLsp = row.source_observations?.some(observation => observation.extractor === "lsp");
      const completed = [sourcePath, targetPath].filter((path): path is string => Boolean(path))
        .every(path => tombstonePaths.has(path)
          || parsedByPath.get(path)?.parseError === null
            && (!fromLsp || parsedByPath.get(path)?.semanticComplete === true));
      const affected = Boolean(
        sourcePath && (tombstonePaths.has(sourcePath) || affectedPaths.has(sourcePath))
        || targetPath && (tombstonePaths.has(targetPath) || affectedPaths.has(targetPath)),
      );
      if (completed && affected) tombstoneEdges.push(row);
    },
    finish() {
      return { kind: "incremental-history-projection-v1", nodePaths,
        matchedNodes, matchedEdges, tombstoneNodes, tombstoneEdges };
    },
  };
}

function historicalNodePath(row: SnapshotNode): string | null {
  const path = row.attributes?.path;
  if (typeof path === "string" && path) return path;
  return row.evidence[0]?.path ?? row.members[0]?.path ?? null;
}

function isActive(row: SnapshotNode | SnapshotEdge): boolean {
  return row.lifecycle_status !== "tombstoned" && row.lifecycle_status !== "superseded";
}

function identity(row: SnapshotNode | SnapshotEdge): HistoricalFactIdentity {
  return { id: row.id, revision_id: row.revision_id,
    first_seen_snapshot_id: row.first_seen_snapshot_id };
}
