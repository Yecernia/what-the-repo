import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '../config.js';
import type { AnalysisJob } from '../domain/jobs.js';
import { recordAnalysisProgress, type AnalysisProgressEvent } from '../domain/conversation.js';
import { defaultRuntimeMetrics, METRIC_NAMES, type RuntimeMetricsSnapshot } from '../observability/metrics.js';
import type { ProductStore } from '../persistence/store.js';
import { permitStoreFor } from '../scheduling/permits.js';
import { ResourceScheduler, type ResourceDemands } from '../scheduling/resources.js';
import { checkpointExecutionStage, type AnalysisExecutionStage, type AnalysisStageExecutor } from './stage-protocol.js';

export function stageMemoryMb(stage: AnalysisExecutionStage, info: { bytes: number; sourceBytes: number; staticBytes?: number } | null): number {
  const bytes = (info?.bytes ?? 0) + (stage === 'semantic' ? 0 : info?.staticBytes ?? 0), source = info?.sourceBytes ?? 0;
  // Admission estimates are deliberately separate from the measured RSS guard.
  const working = stage === 'fetch' ? 1024 : stage === 'cpu' ? 768 + Math.max(source * 24, bytes * 10) / 1048576
    : 512 + bytes / 1048576 * (stage === 'publish' ? 10 : 6);
  return Math.ceil(Math.max(working, stage === 'overlay' ? 2048 : 0) / 64) * 64;
}

export function isolatedStageExecutor(store: ProductStore, config: ServerConfig): AnalysisStageExecutor {
  const scheduler = new ResourceScheduler(permitStoreFor(store));
  return { async run(job, signal) {
    const project = await store.loadProject(job.project_id);
    if (!project) throw new Error('project_not_found');
    let stage: AnalysisExecutionStage | null = job.execution_role === 'overlay' ? 'overlay'
      : checkpointExecutionStage((await store.analysisCheckpointInfo(job.project_id))?.stage);
    while (stage) {
      signal.throwIfAborted();
      const info = await store.analysisCheckpointInfo(job.project_id);
      const memory = stageMemoryMb(stage, info);
      const budget = config.analysisMemoryMb ?? 6144;
      if (memory > budget) throw new Error('analysis_stage_memory_budget_exceeded');
      const demands: ResourceDemands = { 'analysis:memory-mb': { units: memory, limit: budget } };
      if (stage === 'fetch') demands['analysis:fetch'] = { units: 1, limit: config.analysisFetchConcurrency ?? 2 };
      if (stage === 'cpu') demands['analysis:cpu'] = { units: 1, limit: config.analysisCpuConcurrency ?? 2 };
      if (stage === 'publish') demands['analysis:publish'] = { units: 1, limit: config.analysisPublishConcurrency ?? 1 };
      // Semantic jobs retain their resident-memory allowance, not CPU/fetch/publication slots.
      let waiting = false;
      const instance = `${job.job_id}/${job.attempt}/resources/${stage}`;
      const reportWait = async (status: AnalysisProgressEvent['status']) => {
        const projects = job.repository_update_id ? await store.listRepositoryUpdateProjects(job.repository_update_id) : [project];
        for (const row of projects) await store.updateProject(row.project_id, row.owner_id, value => {
          recordAnalysisProgress(value.analysis, 'waiting_resources', status, undefined, { instance_id: instance });
        }, { jobId: job.job_id, workerId: job.lease_owner!, attempt: job.attempt, projectId: job.project_id });
      };
      const labels = { stage };
      const endWait = defaultRuntimeMetrics.time(METRIC_NAMES.analysisStageWait, labels);
      const permit = await scheduler.acquire({ owner: project.owner_id, task: job.job_id, demands, signal,
        onWaiting: async () => { waiting = true; await reportWait('running'); } });
      endWait();
      const endRun = defaultRuntimeMetrics.time(METRIC_NAMES.analysisStageDuration, labels);
      defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisStageActive, 1, labels);
      defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisMemoryReserved, memory);
      try {
        if (waiting) await reportWait('completed');
        stage = await executeStageProcess(job, stage, config, memory, permit.signal);
      } finally {
        endRun();
        defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisStageActive, -1, labels);
        defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisMemoryReserved, -memory);
        await permit.release();
      }
      const current = await store.loadJob(job.job_id);
      if (!current || current.status !== 'running' || current.attempt !== job.attempt || current.lease_owner !== job.lease_owner) return;
    }
  } };
}

export function executeStageProcess(job: AnalysisJob, stage: AnalysisExecutionStage, config: ServerConfig,
  memoryMb: number, signal: AbortSignal): Promise<AnalysisExecutionStage | null> {
  signal.throwIfAborted();
  const entry = new URL(import.meta.url.endsWith('.ts') ? './stage-main.ts' : './stage-main.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(entry.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []),
      `--max-old-space-size=${Math.max(256, Math.floor(memoryMb * 0.65))}`, fileURLToPath(entry)], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      // Inherit tsx's loader in development, but never the parent's test runner flags.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, WHAT_THE_REPO_LOAD_LOCAL_ENV: '0' },
    });
    let result: AnalysisExecutionStage | null | undefined;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let sampling = false;
    let previousMetrics: RuntimeMetricsSnapshot | undefined;
    const sample = setInterval(() => {
      if (sampling || !child.pid || process.platform !== 'linux') return;
      sampling = true;
      void processTreeRss(child.pid).then(bytes => {
        if (!settled && bytes > memoryMb * 1048576) { failure = new Error('analysis_stage_memory_limit_exceeded'); stop(); }
      }).finally(() => { sampling = false; });
    }, 500);
    const stop = () => {
      child.send?.({ type: 'abort' }, () => undefined);
      killTimer ??= setTimeout(() => {
        if (!child.pid) return;
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      }, 5000);
      killTimer.unref();
    };
    const abort = () => { failure = signal.reason instanceof Error ? signal.reason : new Error('analysis_stage_aborted'); stop(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr?.on('data', () => { /* Never forward credentials or repository payloads from child diagnostics. */ });
    child.on('message', message => {
      const value = message as { type?: string; next?: AnalysisExecutionStage | null; rss?: number; code?: string; metrics?: RuntimeMetricsSnapshot };
      if (value.type === 'metrics' && value.metrics) {
        defaultRuntimeMetrics.mergeProcessSnapshot(value.metrics, previousMetrics);
        previousMetrics = value.metrics;
      }
      if (value.type === 'result' && (value.next === null || ['fetch', 'cpu', 'semantic', 'publish', 'overlay'].includes(value.next ?? ''))) result = value.next;
      if (value.type === 'rss' && Number(value.rss) > memoryMb * 1048576) {
        failure = new Error('analysis_stage_memory_limit_exceeded'); stop();
      }
      if (value.type === 'failure') failure = new Error(value.code === 'analysis_stage_memory_limit_exceeded' ? value.code : 'analysis_stage_execution_failed');
    });
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer); clearInterval(sample); signal.removeEventListener('abort', abort);
      for (const gauge of previousMetrics?.gauges ?? []) if (gauge.name === METRIC_NAMES.providerActive)
        defaultRuntimeMetrics.addGauge(gauge.name, -gauge.value, gauge.labels);
      // Native language tools inherit this dedicated process group.
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group empty */ } }
      if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new Error('analysis_stage_process_failed'));
      else resolve(result);
    };
    child.once('error', error => { failure = error; if (!child.pid) finish(null); else stop(); });
    child.once('exit', finish);
    child.send!({ type: 'run', job, stage, config: { ...config, databasePoolMax: 2 } }, error => {
      if (error) { failure = new Error('analysis_stage_dispatch_failed'); stop(); }
    });
    if (signal.aborted) abort();
  });
}

async function processTreeRss(pid: number, seen = new Set<number>()): Promise<number> {
  if (seen.has(pid)) return 0;
  seen.add(pid);
  const [status, children] = await Promise.all([
    readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
    readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''),
  ]);
  const own = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  const descendants = children.trim().split(/\s+/).map(Number).filter(id => id > 0 && Number.isSafeInteger(id));
  return own + (await Promise.all(descendants.map(id => processTreeRss(id, seen)))).reduce((sum, bytes) => sum + bytes, 0);
}
