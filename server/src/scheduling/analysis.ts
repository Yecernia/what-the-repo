import type { AnalysisJob } from '../domain/jobs.js';
import { serviceError } from '../services/errors.js';

export interface AnalysisLimits { running: number; pending?: number; ownerRunning: number; ownerWaiting: number; waiting: number }
export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = { running: 32, pending: 32, ownerRunning: 2, ownerWaiting: 4, waiting: 32 };
export type ScheduledAnalysis = AnalysisJob & { owner_id: string; execution_scope?: string };
export function analysisGroup(job: AnalysisJob): string {
  return job.language_overlay_key ? `overlay:${job.language_overlay_key}`
    : job.repository_update_id ? `repository:${job.repository_update_id}` : `job:${job.job_id}`;
}
export function activeAnalysis(job: AnalysisJob) { return job.status === 'queued' || job.status === 'running'; }
export function analysisParticipationView(job: AnalysisJob, jobs: AnalysisJob[], now = Date.now()): AnalysisJob {
  if (!activeAnalysis(job)) return { ...job, scheduling_state: 'completed' };
  const running = jobs.some(row => analysisGroup(row) === analysisGroup(job) && physicalRunning(row, now));
  return { ...job, scheduling_state: running
    ? job.participation_state === 'running' ? 'running' : 'waiting_owner'
    : 'waiting_capacity' };
}
function physicalRunning(job: AnalysisJob, now: number) {
  return job.execution_role !== 'waiter' && job.status === 'running' && Date.parse(job.lease_expires_at ?? '') > now;
}
function runningGroups(jobs: ScheduledAnalysis[], now: number) {
  return new Set(jobs.filter(job => physicalRunning(job, now)).map(analysisGroup));
}
function ownerRunning(jobs: ScheduledAnalysis[], owner: string, running: Set<string>) {
  return new Set(jobs.filter(job => job.owner_id === owner && job.participation_state === 'running' && running.has(analysisGroup(job))).map(analysisGroup));
}

/** Only new requests are bounded here; retries of accepted durable work remain accepted. */
export function admitAnalysis(jobs: ScheduledAnalysis[], incoming: ScheduledAnalysis, limits: AnalysisLimits, now: number): 'waiting' | 'running' {
  if (!activeAnalysis(incoming)) return 'waiting';
  const active = jobs.filter(activeAnalysis);
  const group = analysisGroup(incoming);
  const running = runningGroups(active, now);
  const ownRunning = ownerRunning(active, incoming.owner_id, running);
  if (ownRunning.has(group)) return 'running';
  const joinsRunning = running.has(group) && ownRunning.size < limits.ownerRunning;
  const ownWaiting = new Set(active.filter(job => job.owner_id === incoming.owner_id && !ownRunning.has(analysisGroup(job))).map(analysisGroup));
  if (!joinsRunning && !ownWaiting.has(group) && ownWaiting.size >= limits.ownerWaiting)
    throw serviceError('analysis_owner_queue_full', '你的待分析任务已满，请等待已有任务完成后再试。', 429);
  const waiting = new Set(active.filter(job => job.execution_role !== 'waiter' && !running.has(analysisGroup(job))).map(analysisGroup));
  if (!active.some(job => analysisGroup(job) === group)
    && new Set(active.map(analysisGroup)).size >= (limits.pending ?? Infinity))
    throw serviceError('analysis_queue_full', '分析任务已满，请稍后重试。', 503);
  if (!active.some(job => analysisGroup(job) === group) && !running.has(group) && waiting.size >= limits.waiting)
    throw serviceError('analysis_queue_full', '分析队列已满，请稍后重试。', 503);
  return joinsRunning ? 'running' : 'waiting';
}

/** Round-robin by last execution opportunity, then each user's oldest eligible work. */
export function scheduleAnalysis(jobs: ScheduledAnalysis[], served: Map<string, number>, limits: AnalysisLimits, now: number, canClaim: (job: ScheduledAnalysis) => boolean = () => true): ScheduledAnalysis | null {
  const active = jobs.filter(activeAnalysis);
  const running = runningGroups(active, now);
  for (const job of active) if (!running.has(analysisGroup(job))) job.participation_state = 'waiting';
  let selected: ScheduledAnalysis | null = null;
  let turn = Math.max(0, ...served.values());
  for (;;) {
    const owners = [...new Set(active.map(job => job.owner_id))].sort((a,b) =>
      (served.get(a) ?? 0) - (served.get(b) ?? 0)
      || earliest(a).localeCompare(earliest(b)) || a.localeCompare(b));
    let granted = false;
    for (const owner of owners) {
      const ownRunning = ownerRunning(active, owner, running);
      // Multiple projects for the same user/task consume one personal task slot.
      for (const job of active) if (job.owner_id === owner && ownRunning.has(analysisGroup(job))) job.participation_state = 'running';
      if (ownRunning.size >= limits.ownerRunning) continue;
      const waiting = active.filter(job => job.owner_id === owner && job.participation_state !== 'running')
        .sort((a,b) => a.created_at.localeCompare(b.created_at) || a.job_id.localeCompare(b.job_id));
      for (const job of waiting) {
        const group = analysisGroup(job);
        const physical = active.find(row => analysisGroup(row) === group && row.execution_role !== 'waiter');
        const canStart = !selected && running.size < limits.running && physical
          && scopeReady(physical) && canClaim(physical)
          && Date.parse(physical.available_at) <= now
          && (physical.status === 'queued' || Date.parse(physical.lease_expires_at ?? '') <= now);
        if (!running.has(group) && !canStart) continue;
        if (!running.has(group)) { selected = physical!; running.add(group); }
        for (const row of active) if (row.owner_id === owner && analysisGroup(row) === group) row.participation_state = 'running';
        served.set(owner, ++turn);
        granted = true;
        break;
      }
      if (granted) break;
    }
    if (!granted) return selected;
  }
  // Different commits do not share results. Serialize their publication within
  // one repository/config lineage while unrelated repositories retain capacity.
  function scopeReady(candidate: ScheduledAnalysis): boolean {
    if (!candidate.execution_scope) return true;
    return !active.some(row => row.job_id !== candidate.job_id && row.execution_role !== 'waiter'
      && row.execution_scope === candidate.execution_scope && (physicalRunning(row, now)
        || row.created_at.localeCompare(candidate.created_at) < 0
        || (row.created_at === candidate.created_at && row.job_id.localeCompare(candidate.job_id) < 0)));
  }
  function earliest(owner: string) { return active.filter(job => job.owner_id === owner).map(job => job.created_at).sort()[0] ?? ''; }
}
