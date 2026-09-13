import { loadConfig } from "../config.js";
import { collectRuntimeObservations } from '../admin/observations.js';
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore } from "../agent/session-store.js";
import { PostgresMemoryStore } from "../persistence/postgres-memory-store.js";
import { PostgresPiSessionBackend } from "../persistence/postgres-session-backend.js";
import { PostgresStore } from "../persistence/postgres-store.js";
import { createProductStore } from "../persistence/factory.js";
import { DatabaseMetricsCollector } from "../observability/database-metrics.js";
import { defaultRuntimeMetrics, METRIC_NAMES } from "../observability/metrics.js";
import { startMetricsServer } from "../observability/metrics-server.js";
import { runRetentionSweep } from "./lifecycle-service.js";
import {
  PostgresRetentionLeadership,
  type RetentionLeadershipLease,
  waitForRetentionLeadership,
} from "./retention-leadership.js";
import { RetentionScheduler } from "./retention-scheduler.js";

const config = loadConfig();
const store = createProductStore(config, "scheduler");
await store.init();
const stopObservations=collectRuntimeObservations(store,'scheduler',defaultRuntimeMetrics);
const databaseMetrics = store instanceof PostgresStore
  ? new DatabaseMetricsCollector({
      pool: store.pool,
      metrics: defaultRuntimeMetrics,
      localRole: "scheduler",
      configuredPoolMax: config.databasePoolMax ?? 2,
      deploymentReserve: config.databaseConnectionReserve ?? 10,
    })
  : null;
const sessions = new PiSessionStore(
  store instanceof PostgresStore
    ? new PostgresPiSessionBackend(store.pool)
    : config.sessionDir,
);
const memories = store instanceof PostgresStore
  ? new PostgresMemoryStore(store.pool)
  : new PiMemoryStore(config.memoryDir);
let scheduler: RetentionScheduler | null = null;
let leadershipLease: RetentionLeadershipLease | null = null;
let shuttingDown = false;
const leadershipAbort = new AbortController();
defaultRuntimeMetrics.setGauge(METRIC_NAMES.retentionLeader, 0);
const metricsServer = await startMetricsServer({
  host: config.metricsHost ?? "127.0.0.1",
  port: config.metricsPort ?? 9464,
  token: config.metricsToken,
  metrics: defaultRuntimeMetrics,
  refresh: databaseMetrics ? async () => { await databaseMetrics.refresh(); } : undefined,
});
const shutdown = async (exitCode = 0): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopObservations();
  leadershipAbort.abort();
  defaultRuntimeMetrics.setGauge(METRIC_NAMES.retentionLeader, 0);
  await scheduler?.stop();
  await leadershipLease?.release().catch(() => undefined);
  await metricsServer?.close();
  await store.close();
  process.exit(exitCode);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  if (store instanceof PostgresStore) {
    leadershipLease = await waitForRetentionLeadership(
      new PostgresRetentionLeadership(store.pool),
      {
        signal: leadershipAbort.signal,
        onWaiting: () => {
          process.stdout.write("what-the-repo retention scheduler waiting for PostgreSQL leadership\n");
        },
      },
    );
    if (leadershipLease) {
      defaultRuntimeMetrics.setGauge(METRIC_NAMES.retentionLeader, 1);
      void leadershipLease.lost.then((error) => {
        defaultRuntimeMetrics.setGauge(METRIC_NAMES.retentionLeader, 0);
        process.stderr.write(`what-the-repo retention scheduler leadership lost: ${error.message}\n`);
        void shutdown(1);
      });
    }
  }

  if (!shuttingDown && (store instanceof PostgresStore ? leadershipLease : true)) {
    scheduler = new RetentionScheduler(async () => {
      const finish = defaultRuntimeMetrics.time(METRIC_NAMES.retentionDuration);
      try {
        await runRetentionSweep({ store, sessions, memories });
        defaultRuntimeMetrics.increment(METRIC_NAMES.retentionSweeps, 1, { outcome: "success" });
      } catch (error) {
        defaultRuntimeMetrics.increment(METRIC_NAMES.retentionSweeps, 1, { outcome: "error" });
        throw error;
      } finally {
        finish();
      }
    });
    await scheduler.runNow();
    scheduler.start({ keepProcessAlive: true });
    process.stdout.write("what-the-repo retention scheduler ready as leader\n");
    if (metricsServer) {
      process.stdout.write(`what-the-repo retention scheduler metrics listening on ${metricsServer.host}:${metricsServer.port}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`what-the-repo retention scheduler failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
}
