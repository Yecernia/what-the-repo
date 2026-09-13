import { randomUUID } from "node:crypto";
import { nowIso } from "./conversation.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AnalysisJob {
  job_id: string;
  config_version?: number;
  project_id: string;
  idempotency_key: string;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  available_at: string;
  completed_at: string | null;
  error: string | null;
  error_code?: string | null;
  repository_update_id?: string | null;
  execution_role?: "standalone" | "leader" | "waiter" | "overlay";
  language_overlay_key?: string | null;
}

export function newAnalysisJob(projectId: string, idempotencyKey: string, maxAttempts = 3): AnalysisJob {
  const timestamp = nowIso();
  return {
    job_id: randomUUID().replaceAll("-", ""),
    project_id: projectId,
    idempotency_key: idempotencyKey,
    status: "queued",
    attempt: 0,
    max_attempts: maxAttempts,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    available_at: timestamp,
    completed_at: null,
    error: null,
    error_code: null,
    repository_update_id: null,
    execution_role: "standalone",
    language_overlay_key: null,
  };
}
