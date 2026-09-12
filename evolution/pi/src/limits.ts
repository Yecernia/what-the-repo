export const MAX_PI_TRACE_EVENTS = 2_048;
export const MAX_PI_TRACE_EVENT_BYTES = 4 * 1024;
export const MAX_PI_EVENT_LOG_BYTES = 8 * 1024 * 1024;

export const MAX_CHECK_RESULT_TEXT_BYTES = 16 * 1024;
export const MAX_LEDGER_CHECK_RESULTS = 136;
export const MAX_LEDGER_CHECK_OUTPUT_BYTES = 512 * 1024;

export const MAX_CANDIDATE_SUMMARY_BYTES = 16 * 1024;
export const MAX_CANDIDATE_LIST_ITEMS = 32;
export const MAX_CANDIDATE_ITEM_BYTES = 4 * 1024;
export const MAX_CANDIDATE_EXPLANATION_BYTES = 128 * 1024;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateCandidateExplanation(
  summary: string,
  risks: string[],
  unresolvedIssues: string[],
  label: string,
): void {
  if (utf8Bytes(summary) > MAX_CANDIDATE_SUMMARY_BYTES) {
    throw new Error(`${label}.summary exceeds its byte budget`);
  }
  for (const [name, values] of [
    ["risks", risks],
    ["unresolvedIssues", unresolvedIssues],
  ] as const) {
    if (values.length > MAX_CANDIDATE_LIST_ITEMS) {
      throw new Error(`${label}.${name} exceeds its item budget`);
    }
    if (values.some((value) => utf8Bytes(value) > MAX_CANDIDATE_ITEM_BYTES)) {
      throw new Error(`${label}.${name} contains an item over its byte budget`);
    }
  }
  const total = utf8Bytes(summary) + [...risks, ...unresolvedIssues]
    .reduce((bytes, value) => bytes + utf8Bytes(value), 0);
  if (total > MAX_CANDIDATE_EXPLANATION_BYTES) {
    throw new Error(`${label} exceeds its total explanation budget`);
  }
}
