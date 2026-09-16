/** Synthetic task/runtime reports for the opt-in loopback admin preview only. */
import type { PostgresStore } from '../persistence/postgres-store.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { DEVELOPMENT_DATABASE } from './admin-dev-data.js';

export const RUNTIME_SCENARIOS = ['reporting', 'interrupted', 'replicas'] as const;
export type RuntimeScenario = (typeof RUNTIME_SCENARIOS)[number];
export const runtimeScenarioLabels: Record<RuntimeScenario, string> = {
  reporting: '正常上报 + 重启旧记录（不触发整类服务告警）',
  interrupted: '分析服务上报中断（应提示检查）',
  replicas: '两个分析实例同时上报（不能只保留最新一个）',
};
export async function refreshDevelopmentRuntime(store: PostgresStore, scenario: RuntimeScenario) {
  if ((await store.pool.query('SELECT current_database() AS name')).rows[0]?.name !== DEVELOPMENT_DATABASE)
    throw new Error('Runtime fixtures require the isolated preview database');
  const now = Date.now(), timestamp = new Date(now).toISOString();
  for (const [index, status] of [[1, 'running'], [3, 'queued']] as const) {
    const batch = 'dev-repository-batch-' + index;
    const row = (await store.pool.query('SELECT leader_project_id FROM repository_analysis_updates WHERE update_id=$1', [batch])).rows[0];
    if (!row) continue; // A preview repository may have been deliberately removed by a tester.
    const id = 'dev-monitor-job-' + index;
    const previous = await store.loadJob(id);
    const job = previous ?? { ...newAnalysisJob(row.leader_project_id, id), job_id: id,
      created_at: new Date(now - 240000).toISOString() };
    await store.saveJob({ ...job, project_id: row.leader_project_id, repository_update_id: batch, execution_role: 'leader', status,
      attempt: status === 'running' ? 1 : 0, lease_owner: status === 'running' ? 'isolated-synthetic-worker' : null,
      lease_expires_at: status === 'running' ? new Date(now + 120000).toISOString() : null,
      heartbeat_at: status === 'running' ? timestamp : null, updated_at: status === 'running' ? timestamp : job.updated_at,
      completed_at: null, error: null, error_code: null });
    // Reproduce the bug deliberately: the batch stays queued while its job is running.
    await store.pool.query("UPDATE repository_analysis_updates SET status='queued',completed_at=NULL WHERE update_id=$1", [batch]);
    await store.pool.query("UPDATE projects SET payload=jsonb_set(payload,'{analysis,stage}',to_jsonb($2::text)),updated_at=$3 WHERE project_id=$1", [row.leader_project_id, status === 'running' ? 'interpreting' : 'idle', timestamp]);
  }
  const reports: Array<{ id: string; role: string; ago: number; active?: number }> = [
    { id: 'analysis-current', role: 'analysis-worker', ago: scenario === 'interrupted' ? 120000 : 2000, active: 1 },
    { id: 'scheduler-current', role: 'scheduler', ago: 4000 },
    { id: 'evolution-current', role: 'evolution', ago: 3000 },
    ...Array.from({ length: 7 }, (_, i) => ({ id: 'analysis-old-' + i, role: 'analysis-worker', ago: (i + 1) * 3600000, active: 0 })),
  ];
  if (scenario === 'replicas') reports.push({ id: 'analysis-second', role: 'analysis-worker', ago: 6000, active: 0 });
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM runtime_observations WHERE instance_id LIKE 'dev-monitor:%'");
    for (const report of reports) {
      const payload = { synthetic: true, note: '本机模拟报告，不是线上服务状态', generated_at: timestamp,
        gauges: report.active === undefined ? [] : [{ name: 'what_the_repo_analysis_runs_active', value: report.active }, { name: 'what_the_repo_provider_calls_active', value: 0 }],
      };
      await client.query('INSERT INTO runtime_observations(instance_id,role,payload,observed_at) VALUES($1,$2,$3,$4)',
        ['dev-monitor:' + report.id, report.role, payload, new Date(now - report.ago).toISOString()]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
