import type { SnapshotEvidence } from '../domain/snapshot.js';

export interface TeachingTargetResult {
  target_id: string;
  outcome: 'proven' | 'contradicted' | 'unproven' | 'not_addressed';
  reason: string;
  answer_spans: string[];
  evidence_ids: string[];
  /** Explicit source references; the semantic owner, never label union, establishes the whole target. */
  prior_answer_message_ids?: string[];
}

export interface TeachingQuestionRequirement {
  prompt_span: string;
  target_ids: string[];
  outcome: 'satisfied' | 'missing' | 'contradicted' | 'not_selected';
  answer_spans: string[];
  prior_answer_message_ids: string[];
  evidence_ids: string[];
  reason: string;
}

/** Answer completeness follows the saved prompt, independently of broad route labels. */
export interface TeachingQuestionResult {
  complete: boolean;
  requirements: TeachingQuestionRequirement[];
}

/** Current evidence and cumulative feedback scope are deliberately separate. */
export interface TeachingFeedbackScope {
  prior_proven_target_ids: string[];
  current_proven_target_ids: string[];
  question_covered_target_ids: string[];
  question_remaining_target_ids: string[];
  step_remaining_target_ids: string[];
  /** Any requested reinforcement must concern a genuinely remaining target. */
  follow_up_target_ids: string[];
  question_complete?: boolean;
  question_requirements?: TeachingQuestionRequirement[];
}

export interface TeachingAnswerAttempt {
  message_id: string;
  /** Only the original, unabridged parts actually sent for assessment. */
  answer_parts: string[];
  /** The complete original message remains in project.messages. */
  original_message_id: string;
}

export interface TeachingTargetAssessmentRecord {
  question_message_id: string;
  question_prompt_sha256: string;
  question_prompt?: string;
  snapshot_id: string;
  route_revision: number;
  step_id: string;
  question_id: string;
  message_id: string;
  sequence: number;
  answer_parts: string[];
  original_message_id: string;
  source_message_sha256: string;
  target_ids: string[];
  results: TeachingTargetResult[];
  question_result?: TeachingQuestionResult;
}

export interface TeachingQuestion {
  commit_eligibility?: { deterministic: boolean; review: 'disabled' | 'passed' };
  question_id: string;
  snapshot_id: string;
  route_revision: number;
  step_id: string;
  prompt: string;
  target_items: string[];
  target_ids?: string[];
  answer_attempts?: TeachingAnswerAttempt[];
  evidence: SnapshotEvidence[];
  answers: string[];
  answer_message_ids: string[];
  created_message_id: string;
  assessment_sequence: number;
}

export interface TeachingAssessment {
  question_id: string;
  snapshot_id: string;
  route_revision: number;
  step_id: string;
  sequence: number;
  verdict: string;
  step_completed: boolean;
}
