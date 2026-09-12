/**
 * Small, deterministic metrics for evidence-bound Agent runs.
 *
 * The input is deliberately a redacted trace summary. It may contain IDs and
 * counters, but never needs raw model thinking or source excerpts.
 */

export const EVIDENCE_QUALITY_SCHEMA_VERSION = "evidence-quality-v1" as const;

export interface EvidenceQualityEvent {
  type?: string;
  elapsed_ms?: number | null;
  tool_call_id?: string | null;
  evidence_ids?: string[];
}

export interface EvidenceQualityUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
}

export interface EvidenceQualityConclusion {
  id: string;
  evidence_ids: string[];
}

export interface EvidenceQualityInput {
  events?: readonly EvidenceQualityEvent[];
  observed_evidence_ids?: readonly string[];
  valid_evidence_ids?: readonly string[];
  referenced_evidence_ids?: readonly string[];
  validation_errors?: readonly string[];
  usage?: EvidenceQualityUsage | null;
  first_valid_evidence_ms?: number | null;
  model_calls?: number;
  expected_conclusions?: readonly EvidenceQualityConclusion[];
}

export interface EvidenceQualityThresholds {
  min_citation_correctness: number;
  max_repeated_evidence_ratio: number;
  min_key_conclusion_coverage: number;
}

export interface EvidenceQualityMetrics {
  schema_version: typeof EVIDENCE_QUALITY_SCHEMA_VERSION;
  first_valid_evidence_ms: number | null;
  tool_call_count: number;
  tool_round_trips: number;
  model_call_count: number;
  model_round_trips: number;
  observed_evidence_count: number;
  unique_evidence_count: number;
  repeated_evidence_ratio: number;
  total_tokens: number;
  citation_correctness: number | null;
  key_conclusion_coverage: number | null;
  evolution_eligible: boolean;
  quality_gate_reasons: string[];
}

export const DEFAULT_EVIDENCE_QUALITY_THRESHOLDS: EvidenceQualityThresholds = {
  min_citation_correctness: 0.95,
  max_repeated_evidence_ratio: 0.5,
  min_key_conclusion_coverage: 0.8,
};

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function integerAtLeastZero(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function clean(values: readonly string[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(clean(values))];
}

function usageValue(usage: EvidenceQualityUsage | null | undefined, ...keys: string[]): number {
  for (const key of keys) {
    const value = finiteNonNegative(usage?.[key as keyof EvidenceQualityUsage]);
    if (value !== null) return value;
  }
  return 0;
}

function totalTokens(usage: EvidenceQualityUsage | null | undefined): number {
  const explicit = finiteNonNegative(usage?.total_tokens);
  if (explicit !== null) return explicit;
  const input = usageValue(usage, "inputTokens", "prompt_tokens");
  const output = usageValue(usage, "outputTokens", "completion_tokens");
  if (input || output) return input + output;
  // Some imported traces contain only cache counters. They are a conservative
  // fallback, while normal Pi traces use input + output above.
  return usageValue(usage, "cachedTokens", "cached_tokens")
    + usageValue(usage, "cacheWriteTokens", "cache_write_tokens");
}

function countToolRoundTrips(events: readonly EvidenceQualityEvent[]): {
  calls: number;
  roundTrips: number;
} {
  const calls = events.filter((event) => event.type === "tool_call_requested");
  const results = events.filter((event) => event.type === "tool_result_received");
  const requestIds = new Set(calls.map((event) => event.tool_call_id).filter((value): value is string => Boolean(value)));
  const resultIds = results.map((event) => event.tool_call_id).filter((value): value is string => Boolean(value));
  const roundTrips = requestIds.size || resultIds.length
    ? resultIds.filter((id) => requestIds.has(id)).length
    : Math.min(calls.length, results.length);
  return { calls: calls.length, roundTrips };
}

function firstEvidenceTime(
  input: EvidenceQualityInput,
  validEvidenceIds: Set<string>,
  observedEvidenceIds: readonly string[],
): number | null {
  const explicit = finiteNonNegative(input.first_valid_evidence_ms);
  if (explicit !== null) return explicit;
  if (validEvidenceIds.size === 0) return null;
  const events = input.events ?? [];
  const withEvidence = events
    .filter((event) => {
      const ids = unique(event.evidence_ids ?? []);
      return ids.length > 0 && ids.some((id) => validEvidenceIds.has(id));
    })
    .map((event) => finiteNonNegative(event.elapsed_ms))
    .filter((value): value is number => value !== null);
  if (withEvidence.length) return Math.min(...withEvidence);
  if (!observedEvidenceIds.length) return null;
  const firstToolResult = events
    .filter((event) => event.type === "tool_result_received")
    .map((event) => finiteNonNegative(event.elapsed_ms))
    .filter((value): value is number => value !== null);
  return firstToolResult.length ? Math.min(...firstToolResult) : null;
}

function citationCorrectness(input: EvidenceQualityInput, validEvidenceIds: Set<string>): number | null {
  const referenced = input.referenced_evidence_ids;
  const errors = input.validation_errors ?? [];
  if (referenced !== undefined) {
    if (!referenced.length && !errors.length) return null;
    const valid = referenced.filter((id) => validEvidenceIds.has(id)).length;
    const denominator = referenced.length + errors.length;
    return denominator ? valid / denominator : 0;
  }
  if (!errors.length) return null;
  const denominator = validEvidenceIds.size + errors.length;
  return denominator ? validEvidenceIds.size / denominator : 0;
}

function conclusionCoverage(
  input: EvidenceQualityInput,
  validEvidenceIds: Set<string>,
): number | null {
  const expected = input.expected_conclusions ?? [];
  if (!expected.length) return null;
  const covered = expected.filter((conclusion) =>
    conclusion.evidence_ids.some((evidenceId) => validEvidenceIds.has(evidenceId)),
  ).length;
  return covered / expected.length;
}

export function evaluateEvidenceQualityGate(
  metrics: Pick<
    EvidenceQualityMetrics,
    "first_valid_evidence_ms" | "citation_correctness" | "key_conclusion_coverage" | "repeated_evidence_ratio"
  >,
  thresholds: EvidenceQualityThresholds = DEFAULT_EVIDENCE_QUALITY_THRESHOLDS,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.first_valid_evidence_ms === null) reasons.push("first_valid_evidence_missing");
  if (metrics.citation_correctness !== null && metrics.citation_correctness < thresholds.min_citation_correctness) {
    reasons.push("citation_correctness_below_threshold");
  }
  if (metrics.citation_correctness === null) reasons.push("citation_correctness_not_scored");
  if (metrics.repeated_evidence_ratio > thresholds.max_repeated_evidence_ratio) {
    reasons.push("repeated_evidence_ratio_above_threshold");
  }
  if (metrics.key_conclusion_coverage !== null && metrics.key_conclusion_coverage < thresholds.min_key_conclusion_coverage) {
    reasons.push("key_conclusion_coverage_below_threshold");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function measureEvidenceQuality(
  input: EvidenceQualityInput,
  thresholds: EvidenceQualityThresholds = DEFAULT_EVIDENCE_QUALITY_THRESHOLDS,
): EvidenceQualityMetrics {
  const events = input.events ?? [];
  const eventEvidenceIds = events.flatMap((event) => event.evidence_ids ?? []);
  // Preserve the observed sequence because repeated IDs are a quality signal.
  // Only the valid set is deduplicated for membership checks.
  const observedEvidenceIds = clean(input.observed_evidence_ids ?? (eventEvidenceIds.length ? eventEvidenceIds : input.valid_evidence_ids ?? []));
  const validEvidenceIds = unique(input.valid_evidence_ids ?? observedEvidenceIds);
  const validSet = new Set(validEvidenceIds);
  const tool = countToolRoundTrips(events);
  const modelCalls = integerAtLeastZero(input.model_calls) ?? events.filter((event) => event.type === "model_started").length;
  const modelRoundTrips = modelCalls;
  const repeatedEvidenceRatio = observedEvidenceIds.length
    ? (observedEvidenceIds.length - new Set(observedEvidenceIds).size) / observedEvidenceIds.length
    : 0;
  const base = {
    schema_version: EVIDENCE_QUALITY_SCHEMA_VERSION,
    first_valid_evidence_ms: firstEvidenceTime(input, validSet, observedEvidenceIds),
    tool_call_count: tool.calls,
    tool_round_trips: tool.roundTrips,
    model_call_count: modelCalls,
    model_round_trips: modelRoundTrips,
    observed_evidence_count: observedEvidenceIds.length,
    unique_evidence_count: new Set(observedEvidenceIds).size,
    repeated_evidence_ratio: repeatedEvidenceRatio,
    total_tokens: totalTokens(input.usage),
    citation_correctness: citationCorrectness(input, validSet),
    key_conclusion_coverage: conclusionCoverage(input, validSet),
  } satisfies Omit<EvidenceQualityMetrics, "evolution_eligible" | "quality_gate_reasons">;
  const gate = evaluateEvidenceQualityGate(base, thresholds);
  return { ...base, evolution_eligible: gate.eligible, quality_gate_reasons: gate.reasons };
}
