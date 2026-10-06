import type { EvidenceRef } from '../domain/conversation.js';
import type { CitationReviewResult } from './citation-review.js';
import type { AssessmentReviewContext } from './assessment-review-context.js';
import { canonicalEvidence, evidenceIdentity, type CitationCoverage, type EvidenceCoverage } from './evidence-packets.js';

export interface ReplyEvidenceBlock {
  kind: 'assessment' | 'explanation' | 'question';
  text: string;
  evidence: EvidenceRef[];
  assessment_context?: AssessmentReviewContext;
  citation_coverage?: CitationCoverage;
  packet_coverage?: EvidenceCoverage;
  validation_errors?: string[];
  commit_eligible?: boolean;
  review?: Pick<CitationReviewResult, 'status' | 'supported' | 'summary' | 'issues'>
    & Partial<Pick<CitationReviewResult, 'coverage' | 'answerCoverage' | 'semanticReview' | 'completed' | 'evidenceIncomplete'>>;
}

/** Range is part of identity: an explicit narrow anchor never replaces a bound
 * assessment packet, even when the underlying symbol ID is the same. */
const evidenceKey = evidenceIdentity;

export function distinctEvidence(rows: EvidenceRef[]): EvidenceRef[] {
  return canonicalEvidence(rows);
}

/** Allocate collision-free packet IDs before review, and keep those same IDs in
 * saved block provenance and accepted message evidence. Never merge ranges. */
export function assignBlockEvidenceIds(blocks: ReplyEvidenceBlock[]): void {
  const byRange = new Map<string, EvidenceRef>();
  const used = new Set<string>();
  for (const row of canonicalEvidence(blocks.flatMap(block => block.evidence))) {
    const key = evidenceKey(row);
    if (!byRange.has(key)) {
      let id = row.stable_id;
      for (let suffix = 1; used.has(id); suffix++) id = `${row.stable_id.slice(0, 200)}:lines:${row.start_line ?? 0}:${row.end_line ?? 0}:${suffix}`;
      used.add(id);
      byRange.set(key, { ...row, stable_id: id });
    }
  }
  for (const block of blocks) {
    block.evidence = canonicalEvidence(block.evidence).map(row => byRange.get(evidenceKey(row))!);
    for (const reference of block.citation_coverage?.references ?? []) {
      reference.evidence = reference.evidence.map(row => byRange.get(evidenceKey(row)) ?? row);
      if (reference.covered_by) reference.covered_by = reference.covered_by.map(row => byRange.get(evidenceKey(row)) ?? row);
    }
  }
}

export function combineBlockReviews(reviews: CitationReviewResult[]): CitationReviewResult {
  const relevant = reviews.filter(review => review.status !== 'not_applicable');
  const status = reviews.some(review => review.status === 'unverified' || review.evidenceIncomplete || review.coverage?.complete === false) ? 'unverified'
    : relevant.length ? 'reviewed' : 'not_applicable';
  const coverages = reviews.flatMap(review => review.coverage ? [review.coverage] : []);
  const citations = coverages.flatMap(coverage => coverage.citations ? [coverage.citations] : []);
  return {
    status, completed: reviews.every(review => review.completed),
    supported: status === 'reviewed' && relevant.length > 0 && relevant.every(review => review.supported && review.completed),
    summary: [...new Set(reviews.map(review => review.summary).filter(Boolean))].join('\n'),
    issues: reviews.flatMap(review => review.issues),
    evidenceIncomplete: reviews.some(review => review.evidenceIncomplete || review.coverage?.complete === false),
    acceptedEvidenceIds: [...new Set(reviews.flatMap(review => review.status === 'reviewed' && review.supported ? review.acceptedEvidenceIds : []))],
    unsupportedClaims: reviews.flatMap(review => review.unsupportedClaims),
    stopReason: reviews.find(review => !review.completed)?.stopReason ?? 'completed',
    validationErrors: reviews.flatMap(review => review.validationErrors ?? []),
    ...(coverages.length ? { coverage: {
      complete: coverages.every(coverage => coverage.complete), packets: coverages.flatMap(coverage => coverage.packets),
      reasons: [...new Set(coverages.flatMap(coverage => coverage.reasons))],
      ...(citations.length ? { citations: { parsed: citations.reduce((sum, coverage) => sum + coverage.parsed, 0),
        resolved: citations.reduce((sum, coverage) => sum + coverage.resolved, 0), references: citations.flatMap(coverage => coverage.references) } } : {}),
    } } : {}),
    usage: reviews.reduce((sum, review) => ({
      inputTokens: sum.inputTokens + review.usage.inputTokens, outputTokens: sum.outputTokens + review.usage.outputTokens,
      cachedTokens: sum.cachedTokens + review.usage.cachedTokens, cacheWriteTokens: sum.cacheWriteTokens + review.usage.cacheWriteTokens,
      costUsd: sum.costUsd + review.usage.costUsd,
    }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 }),
  };
}
