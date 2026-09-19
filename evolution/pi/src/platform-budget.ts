import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Pool } from 'pg';
import {randomUUID} from 'node:crypto';
import type { ProductionEvolutionRuntime } from './composition.js';

interface Permit {
  signal?: AbortSignal;
  release(report?: {
    usageKnown: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    status: 'completed' | 'failed' | 'cancelled';
  }): Promise<void>;
}
export type GlobalReservation = (input: {
  model: Record<string, unknown>;
  estimatedCostUsd: number;
  signal?: AbortSignal;
}) => Promise<Permit>;

/** Reuse the API/analysis ledger implementation; the worker image ships this small compiled module. */
export async function createPlatformBudget(
  root: string,
  databaseUrl: string | null,
) {
  if (!databaseUrl && process.env.NODE_ENV === 'production')
    throw new Error('evolution_platform_budget_database_required');
  if (!databaseUrl) return undefined;
  const { PostgresProviderUsageBudget } = await import(
    pathToFileURL(join(root, 'server', 'dist', 'agent', 'provider-budget.js'))
      .href
  );
  const { createProviderGateFactory } = await import(pathToFileURL(join(root, 'server/dist/agent/provider-gate.js')).href);
  const { concurrencyConfig } = await import(pathToFileURL(join(root, 'server/dist/scheduling/config.js')).href);
  const capacity = concurrencyConfig(process.env);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'what-the-repo:evolution-budget',
  });
  pool.on('error',()=>{console.error('evolution_budget_database_unavailable');});
  const gates = createProviderGateFactory({ pool, maxConcurrent: capacity.chatModelConcurrency,
    upstreamCapacities: capacity.upstreamCapacities });
  const budget = new PostgresProviderUsageBudget(pool, {
    maxCallsPerMinute: Number(
      process.env.WHAT_THE_REPO_QUOTA_PROVIDER_CALLS_PER_MINUTE ?? 60,
    ),
    deploymentMaxCallsPerMinute: Number(
      process.env.WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_CALLS_PER_MINUTE ??
        240,
    ),
    minimumReservationUsd: 0.01,
  });
  const instanceId='evolution:'+randomUUID();let sampling:Promise<void>|undefined;
  const sample=()=>{if(sampling)return;sampling=(async()=>{
    const tasks=(await pool.query('SELECT status,COUNT(*)::int AS count FROM evolution_tasks GROUP BY status')).rows;
    await pool.query(`INSERT INTO runtime_observations(instance_id,role,payload,observed_at) VALUES($1,'evolution',$2,clock_timestamp()) ON CONFLICT(instance_id) DO UPDATE SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at`,[instanceId,JSON.stringify({tasks,collector:'evolution-worker'})]);
  })().catch(()=>undefined).finally(()=>{sampling=undefined;});};
  sample();const observationTimer=setInterval(sample,15000);observationTimer.unref();
  return {
    pool,
    close: async () => {clearInterval(observationTimer);await sampling;await pool.end();},
    forTask:
      (
        taskId: string,
        configVersion: number,
        connectionId: string,
        providerConfig: { baseUrl: string; apiKey?: string; modelId: string },
      ): GlobalReservation =>
      async (input) => {
        const execution = await gates(providerConfig, 'evolution', { ownerId: 'system:evolution', taskId }).acquire(input.signal);
        try {
        const reservation = await budget.acquire({
          ownerId: 'system:runtime',
          provider: String(input.model.provider),
          model: String(input.model.id),
          estimatedCostUsd: input.estimatedCostUsd,
          pricingKnown: input.estimatedCostUsd > 0,
          attribution: {
            business: 'evolution',
            payer: 'platform',
            agentRole: 'evolution',
            taskId,
            connectionId,
            configVersion,
          },
        });
        return { signal: execution.signal, release: async (report) => {
          try { await reservation.release(report); } finally { await execution.release(); }
        } };
        } catch (error) { await execution.release(); throw error; }
      },
  };
}

/** Never replay an interrupted publish. Existing review locks and ledger recovery remain authoritative. */
export async function consumeAdminEvolutionCommand(
  pool: Pool,
  runtime: ProductionEvolutionRuntime,
) {
  const row = (
    await pool.query(
      `UPDATE admin_evolution_commands SET status='running' WHERE id=(SELECT id FROM admin_evolution_commands WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    )
  ).rows[0];
  if (!row) return;
  let status = 'completed',
    result = 'completed';
  try {
    const candidate = await runtime.store.loadCandidate(row.task_id);
    if (candidate.candidateVersion !== row.candidate_version)
      throw new Error('candidate_changed');
    if (row.action === 'rollback')
      await runtime.runner.rollback(row.task_id, candidate.rollbackTarget);
    else {
      if (!runtime.feedbackWorker) throw new Error('worker_unavailable');
      await runtime.feedbackWorker.review({
        taskId: row.task_id,
        decision: row.action,
        reviewerId: row.actor,
        ...(row.action === 'reject' ? { reason: row.reason } : {}),
      });
    }
  } catch {
    status = 'failed';
    result = 'review_failed_check_existing_ledger';
  }
  await pool.query(
    `UPDATE admin_evolution_commands SET status=$2,result=$3,completed_at=clock_timestamp() WHERE id=$1`,
    [row.id, status, result],
  );
  await pool.query(
    'INSERT INTO admin_audit(actor,action,target,outcome) VALUES($1,$2,$3,$4)',
    [row.actor, 'evolution.' + row.action, row.task_id, status],
  );
}

/** Preserve the synchronous stream interface while acquiring the database permit before transport. */
export function globalBudgetRuntime(
  source: unknown,
  reserve: GlobalReservation,
  estimate: (model: unknown, context: unknown, options: unknown) => number,
): unknown {
  if (!source || typeof source !== 'object') return source;
  const wrapped = new Set([
    'stream',
    'streamSimple',
    'complete',
    'completeSimple',
  ]);
  return new Proxy(source, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (!wrapped.has(String(property))) return method.bind(target);
      return (...args: unknown[]) => {
        let permit: Permit | undefined,
          settled = false;
        const finish = async (value?: unknown) => {
          if (settled) return;
          settled = true;
          const row = value as
            | {
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  cost?: { total?: number };
                };
                stopReason?: string;
              }
            | undefined;
          const usage = row?.usage;
          const known =
            !!usage &&
            typeof usage.cost?.total === 'number' &&
            Number.isFinite(usage.cost.total) &&
            (usage.cost.total > 0 || estimate(args[0], args[1], args[2]) > 0) &&
            ['input', 'output', 'cacheRead', 'cacheWrite'].every(
              (k) => typeof usage[k as keyof typeof usage] === 'number',
            );
          await permit?.release({
            usageKnown: known,
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            cachedTokens: usage?.cacheRead ?? 0,
            cacheWriteTokens: usage?.cacheWrite ?? 0,
            costUsd: known ? usage!.cost!.total! : 0,
            status:
              row?.stopReason === 'aborted'
                ? 'cancelled'
                : row?.stopReason === 'error' || !row
                  ? 'failed'
                  : 'completed',
          });
        };
        const dispatched = (async () => {
          permit = await reserve({
            model: args[0] as Record<string, unknown>,
            estimatedCostUsd: estimate(args[0], args[1], args[2]),
            signal: (args[2] as { signal?: AbortSignal } | undefined)?.signal,
          });
          try {
            permit.signal?.throwIfAborted();
            if (permit.signal) {
              const options = (args[2] ?? {}) as { signal?: AbortSignal };
              args[2] = { ...options, signal: options.signal ? AbortSignal.any([options.signal, permit.signal]) : permit.signal };
            }
            return Reflect.apply(method, target, args);
          } catch (error) {
            await finish();
            throw error;
          }
        })();
        // Catch here without swallowing the error exposed by result/iterator.
        void dispatched.catch(() => undefined);
        if (String(property).startsWith('complete'))
          return dispatched.then(
            async (value) => {
              await finish(value);
              return value;
            },
            async (error) => {
              await finish();
              throw error;
            },
          );
        return {
          async result() {
            try {
              const stream = (await dispatched) as {
                result(): Promise<unknown>;
                [Symbol.asyncIterator](): AsyncIterator<{
                  type: string;
                  message?: unknown;
                  error?: unknown;
                }>;
              };
              const result = await stream.result();
              await finish(result);
              return result;
            } catch (error) {
              await finish();
              throw error;
            }
          },
          async *[Symbol.asyncIterator]() {
            try {
              const stream = (await dispatched) as AsyncIterable<{
                type: string;
                message?: unknown;
                error?: unknown;
              }>;
              for await (const event of stream) {
                if (event.type === 'done' || event.type === 'error')
                  await finish(event.message ?? event.error);
                yield event;
              }
            } finally {
              await finish();
            }
          },
        };
      };
    },
  });
}
