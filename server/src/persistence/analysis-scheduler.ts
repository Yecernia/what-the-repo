import type { Pool, PoolClient } from 'pg';
import { admitAnalysis, scheduleAnalysis, type AnalysisLimits, type ScheduledAnalysis } from '../scheduling/analysis.js';
import type { AnalysisJob } from '../domain/jobs.js';

export const ANALYSIS_SCHEDULER_LOCK = 'analysis-admission';
export async function lockAnalysisScheduler(db: PoolClient) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ANALYSIS_SCHEDULER_LOCK]);
}
export async function loadScheduledAnalysis(db: PoolClient): Promise<ScheduledAnalysis[]> {
  const result = await db.query(`SELECT j.*, p.owner_id, COALESCE(a.state,'waiting') AS participation_state,
    CASE WHEN u.update_id IS NULL THEN NULL ELSE jsonb_build_array(u.repository_identity,u.analyzer_bundle_version,u.analysis_config_digest)::text END AS execution_scope
    FROM analysis_jobs j JOIN projects p USING(project_id)
    LEFT JOIN analysis_participants a USING(job_id)
    LEFT JOIN repository_analysis_updates u ON u.update_id=j.repository_update_id WHERE j.status IN ('queued','running')`);
  return result.rows.map(row => ({ ...row,
    created_at: new Date(row.created_at).toISOString(), available_at: new Date(row.available_at).toISOString(),
    lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
  } as ScheduledAnalysis));
}
async function now(db: PoolClient) {
  return Number((await db.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
}
export async function admitAnalysisWithDb(db: PoolClient, job: AnalysisJob, limits: AnalysisLimits): Promise<'waiting' | 'running'> {
  await lockAnalysisScheduler(db);
  const existing = await db.query('SELECT job_id FROM analysis_jobs WHERE job_id=$1', [job.job_id]);
  if (existing.rowCount || !['queued','running'].includes(job.status)) return job.participation_state ?? 'waiting';
  const owner = await db.query<{ owner_id: string }>('SELECT owner_id FROM projects WHERE project_id=$1', [job.project_id]);
  if (!owner.rows[0]) throw new Error('project_not_found');
  return admitAnalysis(await loadScheduledAnalysis(db), { ...job, owner_id: owner.rows[0].owner_id }, limits, await now(db));
}

export async function claimFairAnalysis(pool: Pool, limits: AnalysisLimits, worker: string, leaseSeconds: number): Promise<Record<string, unknown> | null> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await lockAnalysisScheduler(db);
    const jobs = await loadScheduledAnalysis(db);
    const prior = new Map(jobs.map(job => [job.job_id, job.participation_state]));
    const owners = await db.query<{ owner_id: string; last_served: string }>('SELECT owner_id,last_served FROM analysis_scheduler_owners');
    const served = new Map(owners.rows.map(row => [row.owner_id, Number(row.last_served)]));
    const before = new Map(served);
    const candidate = scheduleAnalysis(jobs, served, limits, await now(db));
    let claimed: Record<string, unknown> | null = null;
    if (candidate) {
      const result = await db.query(`UPDATE analysis_jobs SET status='running',attempt=LEAST(attempt+1,max_attempts),lease_owner=$2,
        lease_expires_at=clock_timestamp()+($3*interval '1 second'),heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
        completed_at=NULL,error=NULL,error_code=CASE WHEN attempt>=max_attempts THEN 'lease_attempts_exhausted' ELSE NULL END
        WHERE job_id IN (SELECT job_id FROM analysis_jobs WHERE job_id=$1
          AND (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp()))
          FOR UPDATE SKIP LOCKED) RETURNING *`, [candidate.job_id, worker, leaseSeconds]);
      if (!result.rows[0]) { await db.query('ROLLBACK'); return null; }
      claimed = { ...result.rows[0], participation_state: candidate.participation_state };
    }
    for (const job of jobs) if (prior.get(job.job_id) !== job.participation_state) await db.query(
      `INSERT INTO analysis_participants(job_id,state) VALUES($1,$2) ON CONFLICT(job_id) DO UPDATE SET state=EXCLUDED.state`,
      [job.job_id, job.participation_state]);
    for (const [owner, turn] of served) if (before.get(owner) !== turn) await db.query(
      `INSERT INTO analysis_scheduler_owners(owner_id,last_served) VALUES($1,$2)
       ON CONFLICT(owner_id) DO UPDATE SET last_served=EXCLUDED.last_served`, [owner, turn]);
    await db.query('COMMIT');
    return claimed;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
