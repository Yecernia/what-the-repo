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

export function stageMemoryMb(stage: AnalysisExecutionStage, info: { bytes: number; sourceBytes: number; staticBytes?: number } | null,
  cpuMemoryExpansion = 80, budgetMb = Number.POSITIVE_INFINITY, checkpointMemoryExpansion = 6): number {
  const bytes = (info?.bytes ?? 0) + (stage === 'semantic' ? 0 : info?.staticBytes ?? 0), source = info?.sourceBytes ?? 0;
  // Source/compiler working sets and already serialized graphs have different expansion.
  // Semantic execution omits the static cache; publication includes it exactly once.
  const working = stage === 'fetch' ? 1024 : stage === 'cpu' ? 768 + Math.max(source * cpuMemoryExpansion, bytes * checkpointMemoryExpansion) / 1048576
    : 512 + bytes / 1048576 * checkpointMemoryExpansion;
  // A conservative expansion estimate is not proof that execution cannot fit.
  // Let the isolated process try within the available budget; its RSS guard
  // and V8 heap ceiling remain in force.
  return Math.min(budgetMb, Math.ceil(Math.max(working, stage === 'overlay' ? 2048 : 0) / 64) * 64);
}

/** V8 heap ceiling inside an unchanged reservation. The process-tree RSS guard
 * still enforces the whole reservation; large stages keep 1 GiB for non-heap
 * memory (observed about 0.5 GiB) instead of an idle fixed 20%. */
export function stageHeapCapMb(memoryMb: number): number {
  return Math.max(256, Math.floor(memoryMb * 0.8), memoryMb - 1024);
}

export function isolatedStageExecutor(store: ProductStore, config: ServerConfig,
  execute: typeof executeStageProcess = executeStageProcess): AnalysisStageExecutor {
  const scheduler = new ResourceScheduler(permitStoreFor(store));
  return { async run(job, signal) {
    const project = await store.loadProject(job.project_id);
    if (!project) throw new Error('project_not_found');
    let stage: AnalysisExecutionStage | null = job.execution_role === 'overlay' ? 'overlay'
      : checkpointExecutionStage((await store.analysisCheckpointInfo(job.project_id))?.stage);
    const raisedAllowances = new Map<AnalysisExecutionStage, number>();
    while (stage) {
      signal.throwIfAborted();
      const info = await store.analysisCheckpointInfo(job.project_id);
      const budget = config.analysisMemoryMb ?? 6144;
      const memory = raisedAllowances.get(stage)
        ?? stageMemoryMb(stage, info, config.analysisCpuMemoryExpansion, budget, config.analysisCheckpointMemoryExpansion);
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
      let memoryFailure: unknown;
      try {
        if (waiting) await reportWait('completed');
        stage = await execute(job, stage, config, memory, permit.signal);
      } catch (error) {
        permit.signal.throwIfAborted();
        if (!(error instanceof Error) || error.message !== 'analysis_stage_memory_limit_exceeded') throw error;
        memoryFailure = error;
      } finally {
        endRun();
        defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisStageActive, -1, labels);
        defaultRuntimeMetrics.addGauge(METRIC_NAMES.analysisMemoryReserved, -memory);
        await permit.release();
      }
      const current = await store.loadJob(job.job_id);
      if (!current || current.status !== 'running' || current.attempt !== job.attempt || current.lease_owner !== job.lease_owner) return;
      signal.throwIfAborted();
      if (memoryFailure && stage) {
        // The child has exited and every old grant has been released. Never
        // wait for extra memory while retaining a CPU slot or an old allowance.
        const saved = await store.analysisCheckpointInfo(job.project_id);
        const next: AnalysisExecutionStage | null = stage === 'fetch' && saved?.stage === 'source' ? 'cpu'
          : stage === 'cpu' && saved?.stage === 'semantic' ? 'semantic'
          : stage === 'semantic' && saved?.stage === 'assembly' ? 'publish' : null;
        if (next) {
          defaultRuntimeMetrics.increment(METRIC_NAMES.analysisMemoryRecovery, 1, { stage, action: 'checkpoint' });
          stage = next;
        } else if (!raisedAllowances.has(stage) && memory < budget) {
          // One bounded correction per stage, not an unchanged OOM retry loop.
          // Other jobs retain their normal estimates and owner quotas.
          raisedAllowances.set(stage, Math.min(budget, Math.ceil(memory * 1.5 / 64) * 64));
          defaultRuntimeMetrics.increment(METRIC_NAMES.analysisMemoryRecovery, 1, { stage, action: 'raise' });
        } else throw memoryFailure;
      }
    }
  } };
}

/** Retain only a bounded detection window; never expose child diagnostics. */
export function stageMemoryFailureDetector(): (chunk: Uint8Array | string) => boolean {
  let tail = '';
  let exhausted = false;
  return chunk => {
    const text = tail + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    exhausted ||= /FATAL ERROR:[^\r\n]*(?:heap out of memory|heap limit)/i.test(text);
    tail = exhausted ? '' : text.slice(-512);
    return exhausted;
  };
}

export function executeStageProcess(job: AnalysisJob, stage: AnalysisExecutionStage, config: ServerConfig,
  memoryMb: number, signal: AbortSignal): Promise<AnalysisExecutionStage | null> {
  signal.throwIfAborted();
  const entry = new URL(import.meta.url.endsWith('.ts') ? './stage-main.ts' : './stage-main.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const heapCapMb = stageHeapCapMb(memoryMb);
    const child = spawn(process.execPath, [...(entry.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []),
      // RSS already bounds the whole process tree. Avoid imposing an unnecessarily
      // small JS heap in addition to that bound when most memory is JS graph data.
      `--max-old-space-size=${heapCapMb}`, fileURLToPath(entry)], {
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
    let memoryTrigger: 'process_tree_rss' | 'child_rss' | 'v8_heap' | 'child_report' | null = null;
    let lastTreeRss = 0, peakTreeRss = 0, lastChildRss = 0, peakChildRss = 0;
    let lastHeapUsed = 0, peakHeapUsed = 0, sampledHeapLimit = 0;
    const sample = setInterval(() => {
      if (sampling || !child.pid || process.platform !== 'linux') return;
      sampling = true;
      void processTreeRss(child.pid).then(bytes => {
        if (settled || bytes <= 0) return;
        lastTreeRss = bytes; peakTreeRss = Math.max(peakTreeRss, bytes);
        if (bytes > memoryMb * 1048576) {
          memoryTrigger ??= 'process_tree_rss';
          failure = new Error('analysis_stage_memory_limit_exceeded'); stop();
        }
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
    const memoryFailure = stageMemoryFailureDetector();
    child.stderr?.on('data', (chunk: Buffer) => {
      if (memoryFailure(chunk)) {
        memoryTrigger ??= 'v8_heap';
        failure ??= new Error('analysis_stage_memory_limit_exceeded');
      }
    });
    child.on('message', message => {
      const value = message as { type?: string; next?: AnalysisExecutionStage | null; rss?: number;
        heapUsed?: number; heapLimit?: number; code?: string; metrics?: RuntimeMetricsSnapshot };
      if (value.type === 'metrics' && value.metrics) {
        defaultRuntimeMetrics.mergeProcessSnapshot(value.metrics, previousMetrics);
        previousMetrics = value.metrics;
      }
      if (value.type === 'result' && (value.next === null || ['fetch', 'cpu', 'semantic', 'publish', 'overlay'].includes(value.next ?? ''))) result = value.next;
      if (value.type === 'rss') {
        const rss = Number(value.rss), heapUsed = Number(value.heapUsed), heapLimit = Number(value.heapLimit);
        if (Number.isFinite(rss) && rss > 0) { lastChildRss = rss; peakChildRss = Math.max(peakChildRss, rss); }
        if (Number.isFinite(heapUsed) && heapUsed > 0) { lastHeapUsed = heapUsed; peakHeapUsed = Math.max(peakHeapUsed, heapUsed); }
        if (Number.isFinite(heapLimit) && heapLimit > 0) sampledHeapLimit = heapLimit;
        if (rss > memoryMb * 1048576) {
          memoryTrigger ??= 'child_rss';
          failure = new Error('analysis_stage_memory_limit_exceeded'); stop();
        }
      }
      if (value.type === 'failure') {
        if (value.code === 'analysis_stage_memory_limit_exceeded') memoryTrigger ??= 'child_report';
        failure ??= new Error(value.code === 'analysis_stage_memory_limit_exceeded' ? value.code : 'analysis_stage_execution_failed');
      }
    });
    let settled = false;
    const stopDescendants = () => {
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group empty */ } }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer); clearInterval(sample); signal.removeEventListener('abort', abort);
      for (const gauge of previousMetrics?.gauges ?? []) if (gauge.name === METRIC_NAMES.providerActive)
        defaultRuntimeMetrics.addGauge(gauge.name, -gauge.value, gauge.labels);
      // Native language tools inherit this dedicated process group.
      stopDescendants();
      if (failure?.message === 'analysis_stage_memory_limit_exceeded') {
        // Internal worker log only; no child diagnostics or repository data are
        // returned to the project API. One bounded record per failed attempt.
        console.warn(JSON.stringify({ event: 'analysis_stage_oom', job_id: job.job_id, stage,
          trigger: memoryTrigger ?? 'unknown', allowance_mb: memoryMb, requested_heap_cap_mb: heapCapMb,
          sampled_heap_limit_bytes: sampledHeapLimit, child_rss_last_bytes: lastChildRss,
          child_rss_peak_bytes: peakChildRss, tree_rss_last_bytes: lastTreeRss,
          tree_rss_peak_bytes: peakTreeRss, heap_used_last_bytes: lastHeapUsed,
          heap_used_peak_bytes: peakHeapUsed }));
      }
      if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new Error('analysis_stage_process_failed'));
      else resolve(result);
    };
    child.once('error', error => { failure = error; if (!child.pid) finish(null); else stop(); });
    // A surviving native tool must not keep the diagnostic pipe open forever.
    child.once('exit', stopDescendants);
    // stderr can still contain the fatal V8 marker when exit fires; close waits
    // for the diagnostic pipe, so a known OOM never becomes a transient retry.
    child.once('close', finish);
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
