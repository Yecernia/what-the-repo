import type { ServerConfig } from '../config.js';
import type { AnalysisJob } from '../domain/jobs.js';
import type { AnalysisExecutionStage } from './stage-protocol.js';
import { createProductStore } from '../persistence/factory.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { createProviderGateFactory } from '../agent/provider-gate.js';
import { createProviderUsageBudget, DEFAULT_BUDGET_POLICIES } from '../agent/provider-budget.js';
import { configureProductSkillRegistry } from '../agent/skill-registry.js';
import { adminDocuments } from '../admin/runtime-config.js';
import { AnalysisCoordinator } from './coordinator.js';
import { defaultRuntimeMetrics } from '../observability/metrics.js';

if (!process.send) throw new Error('analysis_stage_requires_parent');
const controller = new AbortController();
process.on('disconnect', () => { controller.abort(new Error('analysis_parent_lost')); setTimeout(() => process.exit(1), 1000).unref(); });
process.on('SIGTERM', () => controller.abort(new Error('analysis_worker_stopping')));
let started = false;
process.on('message', async (message: { type: string; config?: ServerConfig; job?: AnalysisJob; stage?: AnalysisExecutionStage }) => {
  if (message.type === 'abort') { controller.abort(new Error('analysis_worker_stopping')); return; }
  if (started || message.type !== 'run' || !message.config || !message.job || !message.stage) return;
  started = true;
  const { config, job, stage } = message;
  const store = createProductStore(config, 'analysis-stage');
  let next: AnalysisExecutionStage | null = null;
  let failed = false;
  const send = (value: unknown) => { if (process.connected) process.send?.(value as never, () => undefined); };
  const report = () => send({ type: 'rss', rss: process.memoryUsage().rss });
  const sample = setInterval(report, 250);
  const metricsSample = setInterval(() => send({ type: 'metrics', metrics: defaultRuntimeMetrics.snapshot() }), 1000);
  try {
    await store.init();
    configureProductSkillRegistry(config.skillVersionsRoot);
    const gate = createProviderGateFactory({ pool: store instanceof PostgresStore ? store.pool : undefined,
      maxConcurrent: config.chatModelConcurrency ?? 8, analysisConcurrent: config.analysisModelConcurrency ?? 8,
      ownerConcurrent: config.chatOwnerConcurrency ?? 2,
      upstreamCapacities: config.upstreamCapacities });
    const budget = createProviderUsageBudget({ pool: store instanceof PostgresStore ? store.pool : undefined,
      maxCallsPerMinute: config.quotaProviderCallsPerMinute ?? 60,
      deploymentMaxCallsPerMinute: config.quotaProviderDeploymentCallsPerMinute ?? 240,
      loadPolicies: () => adminDocuments(store).read('budgets', DEFAULT_BUDGET_POLICIES),
      minimumReservationUsd: config.quotaProviderReservationUsd ?? 0.01 });
    const current = await store.loadJob(job.job_id);
    if (!current || current.status !== 'running' || current.lease_owner !== job.lease_owner || current.attempt !== job.attempt)
      throw new Error('analysis_lease_lost');
    const project = await store.loadProject(job.project_id);
    // Every role override gets the same real owner's scheduling identity.
    const ownerGate: typeof gate = (provider, business, identity) => gate(provider, business,
      { ...identity, ownerId: project?.owner_id ?? job.project_id, taskId: job.job_id });
    const coordinator = new AnalysisCoordinator(store, config, ownerGate, defaultRuntimeMetrics, budget);
    next = await coordinator.runAssignedStage(job, stage, controller.signal);
    controller.signal.throwIfAborted();
    report();
  } catch { failed = true; }
  finally {
    clearInterval(sample); clearInterval(metricsSample);
    send({ type: 'metrics', metrics: defaultRuntimeMetrics.snapshot() });
    await store.close();
  }
  process.send?.(failed ? { type: 'failure', code: 'analysis_stage_execution_failed' } : { type: 'result', next }, () => process.exit(failed ? 1 : 0));
});
