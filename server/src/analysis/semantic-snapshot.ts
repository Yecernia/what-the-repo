/** Read-only snapshot evidence access and stable semantic identifiers. */
import { createHash } from "node:crypto";
import { readSourcePage, sourceRootLineReader, type SourceLineReader } from "../agent/source-read.js";
import { type SnapshotEvidence, type SnapshotNode } from "../domain/snapshot.js";
import { type BuiltSnapshot } from "./graph.js";

export function id(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function evidenceIndex(snapshot: BuiltSnapshot): Map<string, SnapshotEvidence> {
  const rows = [
    ...snapshot.graph.nodes.flatMap((node) => [...node.evidence, ...node.members]),
    ...snapshot.graph.edges.flatMap((edge) => edge.evidence),
    ...snapshot.fact_graph.nodes.flatMap((node) => [...node.evidence, ...node.members]),
    ...snapshot.fact_graph.edges.flatMap((edge) => edge.evidence),
  ];
  return new Map(rows.filter((row) => row?.stable_id).map((row) => [row.stable_id, row]));
}

export function sourceReader(snapshot: BuiltSnapshot): SourceLineReader {
  if (!snapshot.source_root) {
    return async () => { throw new Error("source_snapshot_unavailable"); };
  }
  return sourceRootLineReader(snapshot.source_root);
}

export function componentById(snapshot: BuiltSnapshot): Map<string, SnapshotNode> {
  return new Map(snapshot.graph.nodes.map((node) => [node.id, node]));
}

export function componentOverviews(node: SnapshotNode) {
  return node.members.filter((row) => /(?:^|\/)README(?:\.[a-z-]+)?\.md$/iu.test(row.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .slice(0, 2).map((row) => ({ evidence_id: row.stable_id, path: row.path, start_line: row.start_line }));
}

/** Cover every member directory without mistaking the first alphabetic subpackage for the whole component. */
export function componentSections(node: SnapshotNode) {
  const members = [...new Map(node.members.map((row) => [row.path, row])).values()];
  const root = members[0]?.path.split("/").slice(0, -1) ?? [];
  for (const row of members) while (root.length && !row.path.startsWith(root.join("/") + "/")) root.pop();
  const groups = new Map<string, SnapshotEvidence[]>();
  for (const row of members) {
    const local = row.path.split("/").slice(root.length);
    const path = [...root, ...(local.length > 1 ? [local[0]!] : [])].join("/") || ".";
    const rows = groups.get(path) ?? []; rows.push(row); groups.set(path, rows);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([path, rows]) => ({
    path, file_count: rows.length,
    overview_evidence: componentOverviews({ ...node, members: rows }).filter((row) => row.path.split("/").slice(0, -1).join("/") === (path === "." ? "" : path)),
  }));
}

export async function prepareOverviewExcerpts(snapshot: BuiltSnapshot, rows: Array<Record<string, unknown>>, includeSections = false) {
  const started = performance.now();
  const diagnostics = { duration_ms: 0, read_count: 0, bytes: 0, unavailable_count: 0 };
  const readLines = sourceReader(snapshot);
  for (const row of rows) {
    const overview = (row.overview_evidence as ReturnType<typeof componentOverviews>)[0];
    if (!overview) continue;
    diagnostics.read_count++;
    try {
      const page = await readSourcePage({ path: overview.path, offset: 1, limit: 40, maxBytes: 1600, readLines });
      row.overview_excerpt = { evidence_id: overview.evidence_id, status: "available", ...page };
      diagnostics.bytes += Buffer.byteLength(page.content, "utf8");
    } catch {
      diagnostics.unavailable_count++;
      row.overview_excerpt = { ...overview, status: "unavailable" };
    }
    if (includeSections) {
      for (const section of (row.member_sections ?? []) as Array<Record<string, unknown>>) {
        const child = (section.overview_evidence as ReturnType<typeof componentOverviews>)[0];
        if (!child || child.path === overview.path) continue;
        diagnostics.read_count++;
        try {
          const page = await readSourcePage({ path: child.path, offset: 1, limit: 20, maxBytes: 800, readLines });
          section.overview_excerpt = { evidence_id: child.evidence_id, status: "available", ...page };
          diagnostics.bytes += Buffer.byteLength(page.content, "utf8");
        } catch {
          diagnostics.unavailable_count++;
          section.overview_excerpt = { ...child, status: "unavailable" };
        }
      }
    }
  }
  diagnostics.duration_ms = performance.now() - started;
  return diagnostics;
}

export function seedEvidence(snapshot: BuiltSnapshot, componentIds: Iterable<string>): {
  evidenceIds: string[];
  paths: string[];
} {
  const ids = new Set(componentIds);
  const nodes = snapshot.graph.nodes.filter((node) => ids.has(node.id));
  const rows = [
    ...nodes.flatMap((node) => [...node.members.slice(0, 6), ...node.evidence.slice(0, 8),
      ...componentOverviews(node).map((row) => ({ stable_id: row.evidence_id, path: row.path }))]),
    ...snapshot.graph.edges
      .filter((edge) => ids.has(edge.source) || ids.has(edge.target))
      .flatMap((edge) => edge.evidence.slice(0, 4)),
  ];
  return {
    evidenceIds: [...new Set(rows.map((row) => row.stable_id))],
    paths: [...new Set(rows.map((row) => row.path))],
  };
}

export function componentEvidence(node: SnapshotNode): SnapshotEvidence[] {
  const seen = new Set<string>();
  const result: SnapshotEvidence[] = [];
  for (const row of [...node.evidence, ...node.members]) {
    if (!row?.stable_id || seen.has(row.stable_id)) continue;
    seen.add(row.stable_id);
    result.push(row);
  }
  return result;
}
