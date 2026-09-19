import { collectRuntimeObservations } from './admin/observations.js';
import { collectStorageInventory } from './admin/storage.js';
import { collectAudience } from './admin/audience.js';
import { adminDocuments } from './admin/runtime-config.js';
import { DEFAULT_BUDGET_POLICIES } from './agent/provider-budget.js';
import { assertApiSessionSecret, loadConfig } from "./config.js";
import { PiMemoryStore } from "./agent/memory-store.js";
import { PiSessionStore } from "./agent/session-store.js";
import { buildApp } from "./api/app.js";
import { createProductStore } from "./persistence/factory.js";
import { PostgresStore } from "./persistence/postgres-store.js";
import { PostgresMemoryStore } from "./persistence/postgres-memory-store.js";
import { PostgresPiSessionBackend } from "./persistence/postgres-session-backend.js";
import { AnalysisCoordinator } from "./analysis/coordinator.js";
import { isolatedStageExecutor } from './analysis/stage-executor.js';
import { assertAnalysisContainerBudget } from './analysis/container-budget.js';
import { configureProductSkillRegistry } from "./agent/skill-registry.js";
import { runRetentionSweep } from "./services/lifecycle-service.js";
import { RetentionScheduler } from "./services/retention-scheduler.js";
import { createTaskQueue } from "./queue/task-queue.js";
import { createProviderGateFactory } from "./agent/provider-gate.js";
import { createProviderUsageBudget } from "./agent/provider-budget.js";
import { defaultRuntimeMetrics } from "./observability/metrics.js";
import { DatabaseMetricsCollector } from "./observability/database-metrics.js";

const config = loadConfig();
if (config.databaseUrl && !config.redisUrl) await assertAnalysisContainerBudget(config.analysisMemoryMb ?? 6144);
assertApiSessionSecret(config);
configureProductSkillRegistry(config.skillVersionsRoot);
const store = createProductStore(config, "api");
await store.init();
const stopObservations = collectRuntimeObservations(store, 'api', defaultRuntimeMetrics);
const stopStorageInventory = collectStorageInventory(store, config);
const stopAudience = collectAudience(adminDocuments(store).pool);
const databaseMetrics = store instanceof PostgresStore
  ? new DatabaseMetricsCollector({
      pool: store.pool,
      metrics: defaultRuntimeMetrics,
      localRole: "api",
      configuredPoolMax: config.databasePoolMax ?? 10,
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
const providerGateFactory = createProviderGateFactory({
  pool: store instanceof PostgresStore ? store.pool : null,
  maxConcurrent: config.chatModelConcurrency ?? 8,
  ownerConcurrent: config.chatOwnerConcurrency ?? 2,
  analysisConcurrent: config.analysisModelConcurrency ?? 8,
  upstreamCapacities: config.upstreamCapacities,
});
const providerBudget = createProviderUsageBudget({
  loadPolicies: () => adminDocuments(store).read("budgets", DEFAULT_BUDGET_POLICIES),
  pool: store instanceof PostgresStore ? store.pool : null,
  maxCallsPerMinute: config.quotaProviderCallsPerMinute ?? 60,
  minimumReservationUsd: config.quotaProviderReservationUsd ?? 0.01,
  deploymentMaxCallsPerMinute: config.quotaProviderDeploymentCallsPerMinute ?? 240,
});
const taskQueue = createTaskQueue({
  redisUrl: config.redisUrl,
  prefix: config.redisPrefix,
  concurrency: 1,
  metrics: defaultRuntimeMetrics,
});
const queueMetricsTimer = setInterval(() => { void taskQueue.refreshMetrics?.(); }, 15_000);
queueMetricsTimer.unref();
void taskQueue.refreshMetrics?.();
const analysis = new AnalysisCoordinator(store, config, providerGateFactory, defaultRuntimeMetrics, providerBudget,
  store instanceof PostgresStore ? isolatedStageExecutor(store, config) : undefined);
// Redis mode delegates analysis to the dedicated worker process. A direct
// local start without Redis keeps polling as a development/test fallback.
if (!config.redisUrl) await analysis.start();
const app = buildApp({
  config,
  store,
  sessions,
  memories,
  analysis,
  taskQueue,
  providerGateFactory,
  providerBudget,
  metrics: defaultRuntimeMetrics,
  metricsRefresh: databaseMetrics ? async () => { await databaseMetrics.refresh(); } : undefined,
});

// Compose runs retention in the singleton scheduler service. Direct local
// startup keeps the sweep as a compatibility fallback unless disabled.
const retentionScheduler = config.retentionEnabled
  ? new RetentionScheduler(async () => { await runRetentionSweep({ store, sessions, memories }); })
  : null;
if (retentionScheduler) {
  await retentionScheduler.runNow().catch(() => undefined);
  retentionScheduler.start();
}

await app.listen({ host: config.host, port: config.port });
process.stdout.write(`what-the-repo server listening on http://${config.host}:${config.port}\n`);

const shutdown = async (): Promise<void> => {
  stopObservations();
  await stopAudience();
  await stopStorageInventory();
  clearInterval(queueMetricsTimer);
  await retentionScheduler?.stop();
  await analysis.stop();
  await taskQueue.close();
  await app.close();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
