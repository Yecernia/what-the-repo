import type { EvidenceSnapshot, SnapshotEvidence } from '../domain/snapshot.js';
import type { ProductStore } from '../persistence/store.js';
import type { ConversationReply } from './conversation-reply.js';
import { validateAnswerCitations } from './citations.js';
import { loadEvidencePackets } from './evidence-packets.js';
import { assignBlockEvidenceIds, distinctEvidence, type ReplyEvidenceBlock } from './reply-evidence.js';

/** Submission preflight and final commit use the same deterministic rules.
 * A budget limits reading, never the list of references being accounted for. */
export async function prepareReplyEvidence(input: {
  reply: ConversationReply;
  text: string;
  getSnapshot: () => Promise<EvidenceSnapshot | null>;
  snapshotId: string | null;
  exposed: Map<string, SnapshotEvidence>;
  projectId: string;
  store: ProductStore;
  signal?: AbortSignal;
}) {
  const validation = await validateAnswerCitations({ text: input.text, snapshot: null, getSnapshot: input.getSnapshot,
    snapshotId: input.snapshotId, exposed: input.exposed, projectId: input.projectId, store: input.store });
  const blocks: ReplyEvidenceBlock[] = [];
  for (const block of input.reply.evidenceBlocks ?? []) {
    const bound = block.evidence.filter(row => row.snapshot_id === input.snapshotId);
    const isolated = block.kind !== 'explanation' || input.reply.evidenceBlocks?.some(part => part.kind === 'assessment');
    const checked = await validateAnswerCitations({ text: block.text, snapshot: null, getSnapshot: input.getSnapshot,
      snapshotId: input.snapshotId, exposed: new Map([...(isolated ? [] : input.exposed), ...bound.map(row => [row.stable_id, row] as const)]),
      isolateBareReferences: Boolean(isolated), projectId: input.projectId, store: input.store,
      fallbackEvidence: block.kind === 'explanation' && !input.reply.evidenceBlocks?.some(part => part.kind === 'assessment') });
    if (block.kind !== 'explanation' && checked.evidence.some(reference => !bound.some(source => source.path === reference.path
      && (source.start_line ?? 1) <= (reference.start_line ?? 1)
      && (source.end_line ?? Infinity) >= (reference.end_line ?? Infinity)))) checked.errors.push('teaching_reference_outside_bound_evidence');
    if (!checked.errors.length && (checked.unresolved.length || checked.coverage.resolved !== checked.coverage.parsed))
      checked.errors.push('citation_reference_unresolved');
    blocks.push({ kind: block.kind, text: checked.text, evidence: distinctEvidence([...bound, ...checked.evidence]),
      ...(block.kind === 'assessment' && block.assessment_context ? { assessment_context: structuredClone(block.assessment_context) } : {}),
      citation_coverage: checked.coverage, validation_errors: checked.errors, commit_eligible: checked.errors.length === 0 });
  }
  if (!blocks.length) blocks.push({ kind: 'explanation', text: validation.text, evidence: validation.evidence,
    citation_coverage: validation.coverage, validation_errors: validation.errors,
    commit_eligible: !validation.errors.length && !validation.unresolved.length });
  assignBlockEvidenceIds(blocks);
  for (const block of blocks) {
    if (!block.evidence.length) { block.commit_eligible &&= block.kind === 'explanation'; continue; }
    const packet = await loadEvidencePackets({ evidence: block.evidence, projectId: input.projectId,
      snapshotId: input.snapshotId ?? '', store: input.store, signal: input.signal });
    block.packet_coverage = { ...packet.coverage, citations: block.citation_coverage };
    block.commit_eligible &&= packet.coverage.complete;
    if (!packet.coverage.complete) block.validation_errors!.push('evidence_packet_incomplete');
  }
  return { validation, blocks, errors: [...new Set([...validation.errors, ...blocks.flatMap(block => block.validation_errors ?? [])])] };
}
