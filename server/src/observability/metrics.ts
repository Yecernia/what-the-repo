import { performance } from "node:perf_hooks";

export type MetricLabelValue = string | number | boolean | null | undefined;
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

export const METRIC_NAMES = {
  httpRequests: "what_the_repo_http_requests_total",
  httpDuration: "what_the_repo_http_request_duration_ms",
  analysisActive: "what_the_repo_analysis_runs_active",
  analysisJobs: "what_the_repo_analysis_jobs_total",
  analysisDuration: "what_the_repo_analysis_job_duration_ms",
  providerCalls: "what_the_repo_provider_calls_total",
  providerActive: "what_the_repo_provider_calls_active",
  providerDuration: "what_the_repo_provider_call_duration_ms",
  providerGateWaits: "what_the_repo_provider_gate_waits_total",
  providerGateWaitDuration: "what_the_repo_provider_gate_wait_duration_ms",
  providerBudgetRejects: "what_the_repo_provider_budget_rejects_total",
  providerBudgetRecordErrors: "what_the_repo_provider_budget_record_errors_total",
  providerTokens: "what_the_repo_provider_tokens_total",
  providerCost: "what_the_repo_provider_cost_usd_total",
  queueDeliveries: "what_the_repo_queue_deliveries_total",
  queueEnqueues: "what_the_repo_queue_enqueues_total",
  queueWaiting: "what_the_repo_queue_jobs_waiting",
  queueActive: "what_the_repo_queue_jobs_active",
  queueDelayed: "what_the_repo_queue_jobs_delayed",
  queueFailed: "what_the_repo_queue_jobs_failed",
  queueOldestAge: "what_the_repo_queue_oldest_wait_ms",
  queueMetricErrors: "what_the_repo_queue_metric_errors_total",
  databaseConnections: "what_the_repo_database_connections",
  databaseConnectionLimit: "what_the_repo_database_connection_limit",
  databasePoolConnections: "what_the_repo_database_pool_connections",
  databaseMetricErrors: "what_the_repo_database_metric_errors_total",
  retentionLeader: "what_the_repo_retention_scheduler_leader",
  retentionSweeps: "what_the_repo_retention_sweeps_total",
  retentionDuration: "what_the_repo_retention_sweep_duration_ms",
} as const;

const DEFAULT_HISTOGRAM_BUCKETS = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
];

interface LabelSet {
  key: string;
  values: Record<string, string>;
}

interface CounterSeries extends LabelSet {
  name: string;
  value: number;
}

interface GaugeSeries extends LabelSet {
  observedAt: string;
  name: string;
  value: number;
}

interface HistogramSeries extends LabelSet {
  name: string;
  count: number;
  sum: number;
  buckets: number[];
}

export interface RuntimeMetricsSnapshot {
  generated_at: string;
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  gauges: Array<{ name: string; labels: Record<string, string>; value: number; observed_at: string }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    buckets: Array<{ le: number | "+Inf"; value: number }>;
  }>;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeLabels(labels: MetricLabels): LabelSet {
  const values: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const raw = labels[key];
    if (raw === null || raw === undefined) continue;
    const value = String(raw);
    if (!value) continue;
    values[key] = value.slice(0, 120);
  }
  return { key: JSON.stringify(values), values };
}

function escapePrometheus(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelsText(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  return "{" + entries.map(([key, value]) => `${key}="${escapePrometheus(value)}"`).join(",") + "}";
}

/**
 * Small process-local metrics registry. It deliberately has no exporter or
 * network dependency: a deployment can expose the stable snapshot through
 * Fastify now and attach a real collector later without changing call sites.
 */
export class RuntimeMetrics {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly gauges = new Map<string, GaugeSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();
  private readonly kinds = new Map<string, "counter" | "gauge" | "histogram">();
  private readonly histogramBuckets: readonly number[];

  constructor(histogramBuckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS) {
    // This process owns the counter: before its first model call it is known idle.
    this.setGauge(METRIC_NAMES.providerActive, 0);
    this.histogramBuckets = [...histogramBuckets]
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
  }

  increment(name: string, value = 1, labels: MetricLabels = {}): void {
    const amount = finite(value);
    if (!amount) return;
    const normalized = normalizeLabels(labels);
    this.assertKind(name, "counter");
    const key = name + normalized.key;
    const existing = this.counters.get(key);
    if (existing) existing.value += amount;
    else this.counters.set(key, { name, key: normalized.key, values: normalized.values, value: amount });
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const normalized = normalizeLabels(labels);
    this.assertKind(name, "gauge");
    const key = name + normalized.key;
    this.gauges.set(key, {
      observedAt: new Date().toISOString(),
      name,
      key: normalized.key,
      values: normalized.values,
      value: finite(value),
    });
  }

  addGauge(name: string, delta: number, labels: MetricLabels = {}): void {
    const normalized = normalizeLabels(labels);
    const key = name + normalized.key;
    const current = this.gauges.get(key)?.value ?? 0;
    this.setGauge(name, current + finite(delta), labels);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const observed = Math.max(0, finite(value));
    const normalized = normalizeLabels(labels);
    this.assertKind(name, "histogram");
    const key = name + normalized.key;
    const existing = this.histograms.get(key);
    if (existing) {
      existing.count += 1;
      existing.sum += observed;
      for (let index = 0; index < this.histogramBuckets.length; index += 1) {
        if (observed <= this.histogramBuckets[index]) existing.buckets[index] += 1;
      }
      return;
    }
    const buckets = this.histogramBuckets.map((bucket) => observed <= bucket ? 1 : 0);
    this.histograms.set(key, {
      name,
      key: normalized.key,
      values: normalized.values,
      count: 1,
      sum: observed,
      buckets,
    });
  }

  time(name: string, labels: MetricLabels = {}): () => number {
    const started = performance.now();
    return () => {
      const elapsed = Math.max(0, performance.now() - started);
      this.observe(name, elapsed, labels);
      return elapsed;
    };
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      generated_at: new Date().toISOString(),
      counters: [...this.counters.values()]
        .sort(seriesSort)
        .map(({ name, values, value }) => ({ name, labels: { ...values }, value })),
      gauges: [...this.gauges.values()]
        .sort(seriesSort)
        .map(({ name, values, value, observedAt }) => ({ name, labels: { ...values }, value, observed_at: observedAt })),
      histograms: [...this.histograms.values()]
        .sort(seriesSort)
        .map(({ name, values, count, sum, buckets }) => ({
          name,
          labels: { ...values },
          count,
          sum,
          buckets: [
            ...this.histogramBuckets.map((le, index) => ({ le, value: buckets[index] })),
            { le: "+Inf" as const, value: count },
          ],
        })),
    };
  }

  prometheus(): string {
    const lines: string[] = [];
    const emittedTypes = new Set<string>();
    const emitType = (name: string, type: "counter" | "gauge" | "histogram"): void => {
      if (emittedTypes.has(name)) return;
      emittedTypes.add(name);
      lines.push(`# TYPE ${name} ${type}`);
    };
    for (const series of [...this.counters.values()].sort(seriesSort)) {
      emitType(series.name, "counter");
      lines.push(`${series.name}${labelsText(series.values)} ${series.value}`);
    }
    for (const series of [...this.gauges.values()].sort(seriesSort)) {
      emitType(series.name, "gauge");
      lines.push(`${series.name}${labelsText(series.values)} ${series.value}`);
    }
    for (const series of [...this.histograms.values()].sort(seriesSort)) {
      emitType(series.name, "histogram");
      const labels = labelsText(series.values);
      for (let index = 0; index < this.histogramBuckets.length; index += 1) {
        const bucketLabels = labelsForBucket(series.values, this.histogramBuckets[index]);
        lines.push(`${series.name}_bucket${bucketLabels} ${series.buckets[index]}`);
      }
      lines.push(`${series.name}_bucket${labelsForBucket(series.values, "+Inf")} ${series.count}`);
      lines.push(`${series.name}_sum${labels} ${series.sum}`);
      lines.push(`${series.name}_count${labels} ${series.count}`);
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.kinds.clear();
  }

  private assertKind(name: string, kind: "counter" | "gauge" | "histogram"): void {
    const existing = this.kinds.get(name);
    if (existing && existing !== kind) throw new Error(`metric_kind_conflict:${name}`);
    this.kinds.set(name, kind);
  }
}

function labelsForBucket(labels: Record<string, string>, le: number | "+Inf"): string {
  return labelsText({ ...labels, le: String(le) });
}

function seriesSort(left: { name: string; key: string }, right: { name: string; key: string }): number {
  return left.name.localeCompare(right.name) || left.key.localeCompare(right.key);
}

export const defaultRuntimeMetrics = new RuntimeMetrics();
