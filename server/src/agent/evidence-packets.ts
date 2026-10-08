import type { EvidenceRef } from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";

export const MAX_REVIEW_PACKETS = 12;
export interface CitationCoverageEntry {
  reference: string;
  resolved: boolean;
  evidence: EvidenceRef[];
  reason: 'invalid_reference' | 'read_failed' | null;
  explicit?: boolean;
  covered_by?: EvidenceRef[];
}
export interface CitationCoverage {
  parsed: number;
  resolved: number;
  references: CitationCoverageEntry[];
}
export interface EvidenceCoverage {
  complete: boolean;
  citations?: CitationCoverage;
  /** read means at least one source line was included; actual ranges report how much. */
  packets: Array<Omit<EvidencePacket, 'excerpt'> & { read: boolean }>;
  reasons: Array<'budget_exceeded' | 'read_failed' | 'range_unavailable' | 'snapshot_mismatch' | 'invalid_reference' | 'missing_citation'>;
}

export function evidenceIdentity(row: EvidenceRef): string {
  return JSON.stringify([row.snapshot_id ?? null, row.path, row.start_line, row.end_line, row.stable_id]);
}

/** Fixed ordering makes bounded selection independent of prose and block order. */
export function canonicalEvidence(rows: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(rows.map(row => [evidenceIdentity(row), row])).values()].sort((a, b) => {
    const pathA = `${a.snapshot_id ?? ''}\n${a.path}`, pathB = `${b.snapshot_id ?? ''}\n${b.path}`;
    return (pathA < pathB ? -1 : pathA > pathB ? 1 : 0)
      || (a.start_line ?? 1) - (b.start_line ?? 1)
      || (a.end_line ?? Number.MAX_SAFE_INTEGER) - (b.end_line ?? Number.MAX_SAFE_INTEGER)
      || (a.stable_id < b.stable_id ? -1 : a.stable_id > b.stable_id ? 1 : 0);
  });
}

export interface EvidencePacket {
  /** Original references share source text without sharing their provenance scope. */
  references: Array<{ evidence_id: string; label: string; start_line: number; end_line: number | null }>;
  path: string;
  snapshot_id: string;
  requested_start_line: number;
  requested_end_line: number | null;
  actual_start_line: number | null;
  actual_end_line: number | null;
  excerpt: string[];
  incomplete: boolean;
  reason: "budget_exceeded" | "read_failed" | "range_unavailable" | "snapshot_mismatch" | null;
  selected: boolean;
  budget: 'packet' | 'lines' | 'characters' | null;
}

/** Plan overlapping reads per snapshot/path, preserving every original reference.
 * Disjoint ranges never pull in unrequested source between them. */
function planEvidencePackets(evidence: EvidenceRef[], snapshotId: string): EvidencePacket[] {
  const packets: EvidencePacket[] = [];
  for (const row of canonicalEvidence(evidence.map(row => ({ ...row, snapshot_id: row.snapshot_id ?? snapshotId })))) {
    const start = Math.max(1, row.start_line ?? 1);
    const reference = { evidence_id: row.stable_id, label: row.label, start_line: start, end_line: row.end_line };
    const previous = packets.at(-1);
    if (previous && previous.snapshot_id === row.snapshot_id && previous.path === row.path
      && start <= (previous.requested_end_line ?? Infinity)) {
      previous.references.push(reference);
      previous.requested_end_line = previous.requested_end_line === null || row.end_line === null
        ? null : Math.max(previous.requested_end_line, row.end_line);
    } else {
      packets.push({ references: [reference], path: row.path, snapshot_id: row.snapshot_id!,
        requested_start_line: start, requested_end_line: row.end_line,
        actual_start_line: null, actual_end_line: null, excerpt: [], incomplete: false, reason: null,
        selected: false, budget: null });
    }
  }
  return packets;
}

/** A reference may only prove text inside its own original range, even when its
 * physical packet includes neighboring references. */
export function referenceExcerpts(packet: EvidencePacket, evidenceId: string): string[] {
  if (packet.incomplete || packet.actual_start_line === null || packet.actual_end_line === null) return [];
  return packet.references.filter(ref => ref.evidence_id === evidenceId).flatMap(ref =>
    ref.start_line >= packet.actual_start_line! && (ref.end_line ?? packet.actual_end_line!) <= packet.actual_end_line!
      ? [packet.excerpt.slice(ref.start_line - packet.actual_start_line!, (ref.end_line ?? packet.actual_end_line!) - packet.actual_start_line! + 1).join('\n')] : []);
}

/** Source text, never graph labels, establishes coverage. Budgets apply to the whole packet set. */
export async function loadEvidencePackets(input: {
  evidence: EvidenceRef[];
  projectId: string;
  snapshotId: string;
  store: ProductStore;
  signal?: AbortSignal;
  maxLines?: number;
  maxCharacters?: number;
}): Promise<{ packets: EvidencePacket[]; incomplete: boolean; coverage: EvidenceCoverage }> {
  let linesLeft = Math.max(0, Math.min(1200, input.maxLines ?? 1200));
  let charsLeft = Math.max(0, Math.min(60_000, input.maxCharacters ?? 60_000));
  const packets = planEvidencePackets(input.evidence, input.snapshotId);
  for (const [index, packet] of packets.entries()) {
    input.signal?.throwIfAborted();
    const start = packet.requested_start_line;
    const endLine = packet.requested_end_line;
    packet.selected = index < MAX_REVIEW_PACKETS;
    if (packet.snapshot_id !== input.snapshotId) {
      packet.incomplete = true; packet.reason = "snapshot_mismatch"; continue;
    }
    if (!packet.selected) {
      packet.incomplete = true; packet.reason = 'budget_exceeded'; packet.budget = 'packet'; continue;
    }
    let offset = start;
    while (endLine === null || offset <= endLine) {
      input.signal?.throwIfAborted();
      if (linesLeft <= 0 || charsLeft <= 0) { packet.reason = "budget_exceeded"; packet.budget = linesLeft <= 0 ? 'lines' : 'characters'; break; }
      const end = Math.min(endLine ?? Number.MAX_SAFE_INTEGER, offset + Math.min(400, linesLeft) - 1);
      const requestedCount = end - offset + 1;
      try {
        const page = await input.store.readSourceLines(input.projectId, input.snapshotId, packet.path, offset, end);
        input.signal?.throwIfAborted();
        for (const line of page.lines.slice(0, end - offset + 1)) {
          if (line.length + 1 > charsLeft) { packet.reason = "budget_exceeded"; packet.budget = 'characters'; break; }
          packet.excerpt.push(line); charsLeft -= line.length + 1; linesLeft--;
        }
        offset = start + packet.excerpt.length;
        if (packet.reason) break;
        if (page.lines.length < requestedCount && !page.truncated) {
          if (!packet.excerpt.length || (endLine !== null && offset <= endLine)) packet.reason = "range_unavailable";
          break;
        }
        if (!page.lines.length) { packet.reason = "range_unavailable"; break; }
      } catch {
        input.signal?.throwIfAborted();
        packet.reason = "read_failed"; break;
      }
    }
    packet.actual_start_line = packet.excerpt.length ? start : null;
    packet.actual_end_line = packet.excerpt.length ? start + packet.excerpt.length - 1 : null;
    // An open-ended read can reach EOF before a finite reference in the same
    // packet. EOF does not establish that missing finite range.
    if (!packet.reason && packet.references.some(ref => ref.start_line > (packet.actual_end_line ?? 0)
      || ref.end_line !== null && ref.end_line > (packet.actual_end_line ?? 0))) packet.reason = 'range_unavailable';
    packet.incomplete = packet.reason !== null;
  }
  const incomplete = packets.some(packet => packet.incomplete);
  return { packets, incomplete, coverage: { complete: !incomplete,
    packets: packets.map(({ excerpt, ...packet }) => ({ ...packet, read: excerpt.length > 0 })),
    reasons: [...new Set(packets.flatMap(packet => packet.reason ? [packet.reason] : []))] } };
}
