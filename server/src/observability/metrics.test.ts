import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMetrics } from "./metrics.js";
import { METRIC_NAMES } from "./metrics.js";

test("runtime metrics aggregate labels and keep histogram buckets cumulative", () => {
  const metrics = new RuntimeMetrics([10, 100]);
  metrics.increment("demo_total", 2, { route: "/x", method: "GET" });
  metrics.increment("demo_total", 3, { method: "GET", route: "/x" });
  metrics.setGauge("demo_active", 2, { worker: "analysis" });
  metrics.addGauge("demo_active", -1, { worker: "analysis" });
  metrics.observe("demo_duration_ms", 7, { route: "/x" });
  metrics.observe("demo_duration_ms", 80, { route: "/x" });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.counters, [{
    name: "demo_total",
    labels: { method: "GET", route: "/x" },
    value: 5,
  }]);
  assert.deepEqual(snapshot.gauges, [{
    name: "demo_active",
    labels: { worker: "analysis" },
    value: 1,
  }]);
  assert.deepEqual(snapshot.histograms[0]?.buckets, [
    { le: 10, value: 1 },
    { le: 100, value: 2 },
    { le: "+Inf", value: 2 },
  ]);
  const prometheus = metrics.prometheus();
  assert.ok(prometheus.includes('demo_duration_ms_bucket{route="/x",le="10"} 1'));
  assert.ok(prometheus.includes('demo_duration_ms_count{route="/x"} 2'));
});

test("runtime metrics reject changing a metric name's kind", () => {
  const metrics = new RuntimeMetrics();
  metrics.increment("same_name");
  assert.throws(() => metrics.observe("same_name", 1), /metric_kind_conflict:same_name/);
});

test("provider metric names remain stable for future exporters", () => {
  assert.equal(METRIC_NAMES.providerTokens, "what_the_repo_provider_tokens_total");
  assert.equal(METRIC_NAMES.analysisActive, "what_the_repo_analysis_runs_active");
  assert.equal(METRIC_NAMES.queueOldestAge, "what_the_repo_queue_oldest_wait_ms");
  assert.equal(METRIC_NAMES.providerBudgetRejects, "what_the_repo_provider_budget_rejects_total");
  assert.equal(METRIC_NAMES.providerBudgetRecordErrors, "what_the_repo_provider_budget_record_errors_total");
  assert.equal(METRIC_NAMES.databaseConnections, "what_the_repo_database_connections");
  assert.equal(METRIC_NAMES.databaseConnectionLimit, "what_the_repo_database_connection_limit");
});
