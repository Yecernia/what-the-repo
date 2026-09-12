import { createHash } from "node:crypto";

export type SemanticBatchPhase =
  | "architecture_components"
  | "architecture_repair"
  | "architecture_layers"
  | "value_discovery"
  | "language_overlay";

export type SemanticBatchStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** Persisted unit of semantic work. The output is a replayable JSON value. */
export interface SemanticBatch {
  batch_id: string;
  job_id: string;
  snapshot_id: string;
  phase: SemanticBatchPhase;
  ordinal: number;
  input_digest: string;
  output_digest: string | null;
  status: SemanticBatchStatus;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  checkpoint: Record<string, unknown>;
  output: unknown | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SemanticBatchDescriptor {
  batch_id: string;
  job_id: string;
  snapshot_id: string;
  phase: SemanticBatchPhase;
  ordinal: number;
  input: unknown;
  checkpoint?: Record<string, unknown>;
}

export interface SemanticBatchRecorder {
  load(jobId: string, batchId: string): Promise<SemanticBatch | null>;
  start(batch: SemanticBatch): Promise<void>;
  complete(batchId: string, output: unknown, outputDigest: string): Promise<void>;
  fail(batchId: string, error: string, status?: "failed" | "cancelled", output?: unknown): Promise<void>;
}

function stable(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

export function digestSemanticBatch(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function createSemanticBatch(
  descriptor: SemanticBatchDescriptor,
  attempt: number,
  leaseOwner: string | null,
  leaseExpiresAt: string | null,
  timestamp: string,
): SemanticBatch {
  return {
    batch_id: descriptor.batch_id,
    job_id: descriptor.job_id,
    snapshot_id: descriptor.snapshot_id,
    phase: descriptor.phase,
    ordinal: descriptor.ordinal,
    input_digest: digestSemanticBatch(descriptor.input),
    output_digest: null,
    status: "running",
    attempt,
    lease_owner: leaseOwner,
    lease_expires_at: leaseExpiresAt,
    checkpoint: descriptor.checkpoint ?? {},
    output: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
  };
}
