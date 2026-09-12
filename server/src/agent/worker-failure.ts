/** Stable local failures; never copy provider bodies, credentials or source into job errors. */
export const DEFAULT_WORKER_MAX_REQUESTS = 40;
export const WORKER_FAILURE_CODES = [
  "analysis_batch_call_limit_exceeded", "analysis_job_call_limit_exceeded", "analysis_time_limit_exceeded",
  "worker_internal_error", "provider_budget_exceeded",
  "language_overlay_structure_failed",
] as const;
export type WorkerFailureCode = typeof WORKER_FAILURE_CODES[number];

export class WorkerExecutionError extends Error {
  constructor(readonly code: WorkerFailureCode) { super(code); }
}

export function workerFailureCode(value: unknown): WorkerFailureCode | null {
  return value instanceof WorkerExecutionError ? value.code : null;
}

export function isWorkerFailureCode(value: string): value is WorkerFailureCode {
  return (WORKER_FAILURE_CODES as readonly string[]).includes(value);
}

/** Retry only identified transport/overload failures; never persist provider error text. */
export function providerFailureReason(
  transport: readonly { status: number | null; errorCode?: string }[] = [],
  errorMessage = "",
): "provider_transient_error" | "provider_request_failed" {
  const last = transport.at(-1);
  if (last?.status && last.status >= 400) {
    return [429, 500, 502, 503, 504].includes(last.status) ? "provider_transient_error" : "provider_request_failed";
  }
  const code = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/i;
  return code.test(last?.errorCode ?? "") || code.test(errorMessage)
    ? "provider_transient_error" : "provider_request_failed";
}
