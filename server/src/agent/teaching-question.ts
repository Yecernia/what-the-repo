import type { SnapshotEvidence } from '../domain/snapshot.js';

export interface TeachingQuestion {
  question_id: string;
  snapshot_id: string;
  route_revision: number;
  step_id: string;
  prompt: string;
  target_items: string[];
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
