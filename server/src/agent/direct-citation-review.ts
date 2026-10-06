import { Type, type Static } from 'typebox';
import type { EvidencePacket } from './evidence-packets.js';

export const CITATION_PROOF_SCOPE = Type.Union([
  Type.Literal('public_type_contract'), Type.Literal('internal_implementation'),
  Type.Literal('javascript_runtime'), Type.Literal('declaration'), Type.Literal('call_site'),
]);
const PROOF = Type.Object({
  evidence_id: Type.String({ minLength: 1, maxLength: 256 }),
  excerpt: Type.String({ minLength: 1, maxLength: 2000 }),
  claim_scope: CITATION_PROOF_SCOPE, evidence_scope: CITATION_PROOF_SCOPE,
}, { additionalProperties: false });
export const DIRECT_REVIEW_RESULT = Type.Object({
  sections: Type.Array(Type.Object({
    section_id: Type.Integer({ minimum: 0 }),
    outcome: Type.Union([Type.Literal('supported'), Type.Literal('contradicted'),
      Type.Literal('insufficient_evidence'), Type.Literal('no_repository_claim'), Type.Literal('unverified')]),
    basis: Type.String({ minLength: 1, maxLength: 600 }),
    evidence_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 }),
    issues: Type.Array(Type.Object({
      claim: Type.String({ minLength: 1, maxLength: 1000 }),
      actual_assertion: Type.String({ minLength: 1, maxLength: 500 }),
      conditions: Type.String({ minLength: 1, maxLength: 500 }),
      reason: Type.String({ minLength: 1, maxLength: 600 }),
      kind: Type.Union([Type.Literal('insufficient_evidence'), Type.Literal('contradicted')]),
      counterevidence: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
      contradiction_proof: Type.Optional(PROOF),
    }, { additionalProperties: false }), { maxItems: 12 }),
  }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });
export type DirectReviewValue = Static<typeof DIRECT_REVIEW_RESULT>;
export interface ReviewSection { section_id: number; start: number; end: number }

/** Original paragraph/list-item boundaries. Text appears only in final_answer, never copied into this index. */
export function answerReviewSections(answer: string): ReviewSection[] {
  const sections: ReviewSection[] = [];
  let start = 0; let offset = 0; let fenced: string | null = null; let afterBlank = false; let inList = false;
  for (const line of answer.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const trimmed = line.trim();
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    const startsItem = /^\s{0,3}(?:[-+*]\s|\d+[.)]\s|#{1,6}\s)/u.test(line);
    const continuesList = inList && /^\s+/u.test(line) && !startsItem;
    if (!fenced && trimmed && ((afterBlank && !continuesList) || startsItem) && answer.slice(start, offset).trim()) {
      sections.push({ section_id: sections.length, start, end: offset }); start = offset;
      inList = false;
    }
    if (!fenced && /^\s{0,3}(?:[-+*]\s|\d+[.)]\s)/u.test(line)) inList = true;
    if (marker) {
      if (!fenced) fenced = marker[0]!;
      else if (marker[0] === fenced) fenced = null;
    }
    afterBlank = !fenced && !trimmed;
    offset += line.length;
  }
  if (start < answer.length) sections.push({ section_id: sections.length, start, end: answer.length });
  return sections;
}

export function directReviewGroups(sections: ReviewSection[], length: number): number[][] {
  const count = Math.min(4, sections.length, Math.max(1, Math.ceil(length / 6000)));
  return Array.from({ length: count }, (_, group) => sections.slice(Math.floor(group * sections.length / count),
    Math.floor((group + 1) * sections.length / count)).map(section => section.section_id));
}
export function hasSameScopeProof(proof: DirectReviewValue['sections'][number]['issues'][number]['contradiction_proof'], packets: EvidencePacket[]): boolean {
  return Boolean(proof && proof.claim_scope === proof.evidence_scope && packets.some(packet => packet.evidence_id === proof.evidence_id
    && !packet.incomplete && packet.excerpt.length && packet.excerpt.join('\n').includes(proof.excerpt) && proof.excerpt.trim()));
}
/** Structure/provenance checks only. These cannot establish semantic entailment or actual claim completeness. */
export function validateDirectReview(value: DirectReviewValue, answer: string, sections: ReviewSection[], focus: number[], packets: EvidencePacket[], purpose: 'answer' | 'assessment' | 'question'): string[] {
  const errors = new Set<string>();
  if (value.sections.length !== focus.length || new Set(value.sections.map(row => row.section_id)).size !== focus.length
    || value.sections.some(row => !focus.includes(row.section_id))) errors.add('review_section_accounting');
  const allowed = new Set(packets.filter(packet => !packet.incomplete && packet.excerpt.length).map(packet => packet.evidence_id));
  for (const row of value.sections) {
    const section = sections[row.section_id];
    if (!row.basis.trim()) errors.add('review_basis_empty');
    if (new Set(row.evidence_ids).size !== row.evidence_ids.length || row.evidence_ids.some(id => !allowed.has(id))) errors.add('invalid_accepted_evidence_id');
    if (row.outcome === 'supported' && (row.issues.length || !row.evidence_ids.length)) errors.add('review_support_without_proof');
    if (row.outcome === 'no_repository_claim' && (row.issues.length || row.evidence_ids.length)) errors.add('review_nonclaim_conflict');
    if (row.outcome === 'contradicted' && !row.issues.some(issue => issue.kind === 'contradicted')) errors.add('review_negative_without_finding');
    if (row.outcome === 'insufficient_evidence' && !row.issues.some(issue => issue.kind === 'insufficient_evidence')) errors.add('review_gap_without_finding');
    if (row.outcome === 'insufficient_evidence' && row.issues.some(issue => issue.kind === 'contradicted')) errors.add('review_outcome_conflict');
    for (const issue of row.issues) {
      let at = answer.indexOf(issue.claim); let anchored = false;
      while (at >= 0 && section) { if (at < section.end && at + issue.claim.length > section.start) { anchored = true; break; } at = answer.indexOf(issue.claim, at + 1); }
      if (!issue.claim.trim() || !anchored) errors.add('claim_not_in_focus_section');
      if (![issue.actual_assertion, issue.conditions, issue.reason].every(text => text.trim())) errors.add('review_issue_empty');
      if (issue.kind === 'contradicted' && !issue.counterevidence?.trim()) errors.add('review_counterevidence_missing');
    }
  }
  if (purpose !== 'answer' && focus.length === sections.length && value.sections.length && value.sections.every(row => row.outcome === 'no_repository_claim')) errors.add('teaching_subject_not_reviewed');
  return [...errors];
}
