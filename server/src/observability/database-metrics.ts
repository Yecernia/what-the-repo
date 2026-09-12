import type { QueryResult, QueryResultRow } from "pg";
import { POSTGRES_APPLICATION_PREFIX } from "../persistence/postgres-store.js";
import { METRIC_NAMES, type RuntimeMetrics } from "./metrics.js";

interface DatabaseMetricsPool {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

interface DatabaseSnapshotRow extends QueryResultRow {
  max_connections: number | string;
  superuser_reserved_connections: number | string;
  connections_by_application: Record<string, number | string> | string;
}

const KNOWN_DATABASE_ROLES = ["api", "analysis-worker", "scheduler", "evolution-worker", "migration"];

function count(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function roleFromApplicationName(value: string): string | null {
  if (!value.startsWith(POSTGRES_APPLICATION_PREFIX)) return null;
  const role = value.slice(POSTGRES_APPLICATION_PREFIX.length).trim();
  return role || null;
}

export class DatabaseMetricsCollector {
  private readonly knownRoles = new Set(KNOWN_DATABASE_ROLES);

  constructor(private readonly options: {
    pool: DatabaseMetricsPool;
    metrics: RuntimeMetrics;
    localRole: string;
    configuredPoolMax: number;
    deploymentReserve: number;
  }) {}

  async refresh(): Promise<void> {
    this.recordLocalPool();
    try {
      const result = await this.options.pool.query<DatabaseSnapshotRow>(
        `SELECT
           current_setting('max_connections')::integer AS max_connections,
           current_setting('superuser_reserved_connections')::integer AS superuser_reserved_connections,
           COALESCE((
             SELECT jsonb_object_agg(application_name, connections)
             FROM (
               SELECT application_name, COUNT(*)::integer AS connections
               FROM pg_stat_activity
               WHERE datname = current_database()
                 AND application_name LIKE 'what-the-repo:%'
               GROUP BY application_name
             ) AS application_connections
           ), '{}'::jsonb) AS connections_by_application`,
      );
      const snapshot = result.rows[0];
      if (!snapshot) throw new Error("database_metrics_snapshot_missing");
      this.recordConnectionLimits(snapshot);
      this.recordDeploymentConnections(snapshot.connections_by_application);
    } catch {
      this.options.metrics.increment(METRIC_NAMES.databaseMetricErrors, 1, { source: "postgres" });
    }
  }

  private recordLocalPool(): void {
    const { pool, metrics, localRole } = this.options;
    const total = count(pool.totalCount);
    const idle = Math.min(total, count(pool.idleCount));
    const values = {
      configured: count(this.options.configuredPoolMax),
      total,
      idle,
      active: Math.max(0, total - idle),
      waiting: count(pool.waitingCount),
    };
    for (const [state, value] of Object.entries(values)) {
      metrics.setGauge(METRIC_NAMES.databasePoolConnections, value, { role: localRole, state });
    }
  }

  private recordConnectionLimits(snapshot: DatabaseSnapshotRow): void {
    const max = count(snapshot.max_connections);
    const postgresReserved = Math.min(max, count(snapshot.superuser_reserved_connections));
    const deploymentReserve = Math.min(
      Math.max(0, max - postgresReserved),
      count(this.options.deploymentReserve),
    );
    const limits = {
      max,
      postgres_reserved: postgresReserved,
      deployment_reserve: deploymentReserve,
      usable_budget: Math.max(0, max - postgresReserved - deploymentReserve),
    };
    for (const [kind, value] of Object.entries(limits)) {
      this.options.metrics.setGauge(METRIC_NAMES.databaseConnectionLimit, value, { kind });
    }
  }

  private recordDeploymentConnections(raw: DatabaseSnapshotRow["connections_by_application"]): void {
    const parsed = typeof raw === "string" ? JSON.parse(raw) as Record<string, number | string> : raw;
    const current = new Map<string, number>();
    for (const [applicationName, connections] of Object.entries(parsed)) {
      const role = roleFromApplicationName(applicationName);
      if (!role) continue;
      this.knownRoles.add(role);
      current.set(role, (current.get(role) ?? 0) + count(connections));
    }
    let total = 0;
    for (const role of this.knownRoles) {
      const connections = current.get(role) ?? 0;
      total += connections;
      this.options.metrics.setGauge(METRIC_NAMES.databaseConnections, connections, { role });
    }
    this.options.metrics.setGauge(METRIC_NAMES.databaseConnections, total, { role: "all" });
  }
}
