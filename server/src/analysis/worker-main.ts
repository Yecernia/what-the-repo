import { collectRuntimeObservations } from '../admin/observations.js';
import { adminDocuments } from '../admin/runtime-config.js';
import { DEFAULT_BUDGET_POLICIES } from '../agent/provider-budget.js';
import { loadConfig } from "../config.js";
import { createProductStore } from "../persistence/factory.js";
import { AnalysisCoordinator } from "./coordinator.js";
import { configureProductSkillRegistry } from "../agent/skill-registry.js";
import { createTaskQueue } from "../queue/task-queue.js";
import { PostgresStore } from "../persistence/postgres-store.js";
import { createProviderGateFactory } from "../agent/provider-gate.js";
import { createProviderUsageBudget } from "../agent/provider-budget.js";
import { defaultRuntimeMetrics } from "../observability/metrics.js";
import { DatabaseMetricsCollector } from "../observability/database-metrics.js";
import { startMetricsServer } from "../observability/metrics-server.js";

const config = loadConfig();
configureProductSkillRegistry(config.skillVersionsRoot ?? `${config.dataDir}/skill-versions`);
const store = createProductStore(config, "analysis-worker");
await store.init();
const stopObservations = collectRuntimeObservations(store, 'analysis-worker', defaultRuntimeMetrics);
const databaseMetrics = store instanceof PostgresStore
  ? new DatabaseMetricsCollector({
      pool: store.pool,
      metrics: defaultRuntimeMetrics,
      localRole: "analysis-worker",
      configuredPoolMax: config.databasePoolMax ?? 8,
      deploymentReserve: config.databaseConnectionReserve ?? 10,
    })
  : null;
const providerGateFactory = createProviderGateFactory({
  pool: store instanceof PostgresStore ? store.pool : null,
  maxConcurrent: config.providerConcurrency ?? 4,
  pollMs: config.providerGatePollMs ?? 100,
});
const providerBudget = createProviderUsageBudget({
  loadPolicies: () => adminDocuments(store).read("budgets", DEFAULT_BUDGET_POLICIES),
  pool: store instanceof PostgresStore ? store.pool : null,
  maxCallsPerMinute: config.quotaProviderCallsPerMinute ?? 60,
  minimumReservationUsd: config.quotaProviderReservationUsd ?? 0.01,
  deploymentMaxCallsPerMinute: config.quotaProviderDeploymentCallsPerMinute ?? 240,
});
const queue = createTaskQueue({
  redisUrl: config.redisUrl,
  prefix: config.redisPrefix,
  concurrency: config.analysisQueueConcurrency,
  metrics: defaultRuntimeMetrics,
});
const queueMetricsTimer = setInterval(() => { void queue.refreshMetrics?.(); }, 15_000);
queueMetricsTimer.unref();
void queue.refreshMetrics?.();
const coordinator = new AnalysisCoordinator(store, config, providerGateFactory, defaultRuntimeMetrics, providerBudget);
await coordinator.start({ poll: false });
await queue.startAnalysisConsumer(() => coordinator.runOnce());
const metricsServer = await startMetricsServer({
  host: config.metricsHost ?? "127.0.0.1",
  port: config.metricsPort ?? 9464,
  token: config.metricsToken,
  metrics: defaultRuntimeMetrics,
  refresh: databaseMetrics ? async () => { await databaseMetrics.refresh(); } : undefined,
});

// The queue is the normal wake-up path. This low-frequency recovery tick is
// deliberately slower than the API poller and repairs messages lost before
// Redis acknowledgement or after a worker restart.
const recoveryTimer = setInterval(() => { void coordinator.runOnce(); }, 15_000);
recoveryTimer.unref();
process.stdout.write(`what-the-repo analysis worker ready (${queue.kind})\n`);
if (metricsServer) {
  process.stdout.write(`what-the-repo analysis worker metrics listening on ${metricsServer.host}:${metricsServer.port}\n`);
}

const shutdown = async (): Promise<void> => {
  stopObservations();
  clearInterval(queueMetricsTimer);
  clearInterval(recoveryTimer);
  await coordinator.stop();
  await queue.close();
  await metricsServer?.close();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
