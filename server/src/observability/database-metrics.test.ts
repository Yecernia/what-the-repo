import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { DatabaseMetricsCollector } from "./database-metrics.js";
import { METRIC_NAMES, RuntimeMetrics } from "./metrics.js";

class FakePool {
  readonly totalCount = 5;
  readonly idleCount = 2;
  readonly waitingCount = 1;

  async query<Row extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<Row>> {
    const rows = [{
      max_connections: 100,
      superuser_reserved_connections: 3,
      connections_by_application: {
        "what-the-repo:api": 3,
        "what-the-repo:analysis-worker": 4,
        "another-product": 99,
      },
    }];
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as unknown as QueryResult<Row>;
  }
}

function gauge(metrics: RuntimeMetrics, name: string, labels: Record<string, string>): number | undefined {
  return metrics.snapshot().gauges.find((item) => (
    item.name === name && Object.entries(labels).every(([key, value]) => item.labels[key] === value)
  ))?.value;
}

test("database metrics expose local pool pressure and deployment connection budget", async () => {
  const metrics = new RuntimeMetrics();
  const collector = new DatabaseMetricsCollector({
    pool: new FakePool(),
    metrics,
    localRole: "api",
    configuredPoolMax: 10,
    deploymentReserve: 10,
  });

  await collector.refresh();

  assert.equal(gauge(metrics, METRIC_NAMES.databasePoolConnections, { role: "api", state: "configured" }), 10);
  assert.equal(gauge(metrics, METRIC_NAMES.databasePoolConnections, { role: "api", state: "active" }), 3);
  assert.equal(gauge(metrics, METRIC_NAMES.databasePoolConnections, { role: "api", state: "waiting" }), 1);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnectionLimit, { kind: "max" }), 100);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnectionLimit, { kind: "postgres_reserved" }), 3);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnectionLimit, { kind: "deployment_reserve" }), 10);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnectionLimit, { kind: "usable_budget" }), 87);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnections, { role: "api" }), 3);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnections, { role: "analysis-worker" }), 4);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnections, { role: "scheduler" }), 0);
  assert.equal(gauge(metrics, METRIC_NAMES.databaseConnections, { role: "all" }), 7);
});

test("database metric query failures keep the endpoint available and increment an error counter", async () => {
  const metrics = new RuntimeMetrics();
  const pool = new FakePool();
  pool.query = async () => { throw new Error("database unavailable"); };
  const collector = new DatabaseMetricsCollector({
    pool,
    metrics,
    localRole: "api",
    configuredPoolMax: 10,
    deploymentReserve: 10,
  });

  await collector.refresh();

  assert.equal(metrics.snapshot().counters.find((item) => (
    item.name === METRIC_NAMES.databaseMetricErrors
  ))?.value, 1);
  assert.equal(gauge(metrics, METRIC_NAMES.databasePoolConnections, { role: "api", state: "total" }), 5);
});
