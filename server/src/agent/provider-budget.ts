import { randomUUID } from 'node:crypto';
import { KeyedMutex } from './mutex.js';
import { connectWithAbort, delay } from '../scheduling/permits.js';
export type UsageBusiness =
  | 'analysis'
  | 'chat'
  | 'evolution'
  | 'historical_unclassified';
export interface UsageAttribution {
  business: UsageBusiness;
  payer: 'platform' | 'user' | 'historical_unclassified';
  agentRole?: string;
  connectionId?: string;
  configVersion?: number;
  taskId?: string;
}
export interface ProviderUsageReport {
  usageKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  status: 'completed' | 'failed' | 'cancelled';
}
export interface ProviderBudgetPermit {
  eventId?: string;
  release(report?: ProviderUsageReport): Promise<void>;
}
export interface ProviderBudgetInput {
  ownerId: string;
  provider: string;
  model: string;
  estimatedCostUsd?: number;
  pricingKnown?: boolean;
  signal?: AbortSignal;
  attribution?: UsageAttribution;
}
export interface ProviderUsageBudget {
  acquire(input: ProviderBudgetInput): Promise<ProviderBudgetPermit>;
}
export interface ProviderBudgetDbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  release(): void;
}
export interface ProviderBudgetDbPool {
  connect(): Promise<ProviderBudgetDbClient>;
}

async function connectBudget(pool: ProviderBudgetDbPool, signal?: AbortSignal): Promise<ProviderBudgetDbClient> {
  for (;;) {
    const client = await connectWithAbort<ProviderBudgetDbClient>(pool, signal);
    try {
      await client.query('BEGIN');
      const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', ['provider-budget-global']);
      if (result.rows[0]?.acquired) return client;
      await client.query('ROLLBACK');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); client.release(); throw error; }
    client.release();
    await delay(25, signal);
  }
}
export type BudgetKey =
  | 'analysis_daily'
  | 'chat_daily'
  | 'evolution_task'
  | 'evolution_daily';
export type BudgetPolicies = Record<BudgetKey, number | null>;
export const DEFAULT_BUDGET_POLICIES: BudgetPolicies = {
  analysis_daily: 5,
  chat_daily: 5,
  evolution_task: 1,
  evolution_daily: 5,
};
export const BUDGET_KEYS = Object.keys(DEFAULT_BUDGET_POLICIES) as BudgetKey[];
export function validateBudgetPolicies(value: unknown): BudgetPolicies {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_budget_policy');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== BUDGET_KEYS.length)
    throw new Error('invalid_budget_policy');
  for (const key of BUDGET_KEYS)
    if (
      row[key] !== null &&
      (typeof row[key] !== 'number' ||
        !Number.isFinite(row[key]) ||
        row[key] < 0 ||
        row[key] > 1_000_000)
    )
      throw new Error('invalid_budget_policy');
  return row as BudgetPolicies;
}
export function beijingBudgetDay(now = Date.now()) {
  const start =
    Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  return {
    start,
    resetAt: new Date(start + 86400_000).toISOString(),
    timezone: 'Asia/Shanghai',
  };
}
export type ProviderBudgetScope = 'owner' | 'deployment' | BudgetKey;
export type ProviderBudgetKind =
  | 'calls_per_minute'
  | 'cost_per_day'
  | 'cost_per_task';
export class ProviderBudgetExceededError extends Error {
  readonly code: string;
  readonly statusCode = 429;
  readonly resetAt?: string;
  constructor(
    readonly kind: ProviderBudgetKind,
    readonly limit: number,
    readonly scope: ProviderBudgetScope = 'owner',
  ) {
    const code =
      kind === 'calls_per_minute'
        ? 'site_rate_limited'
        : limit === 0
          ? 'site_budget_disabled'
          : scope === 'analysis_daily'
            ? 'site_analysis_budget_exhausted'
            : scope === 'chat_daily'
              ? 'site_chat_budget_exhausted'
              : scope === 'evolution_task'
                ? 'site_evolution_task_budget_exhausted'
                : scope === 'evolution_daily'
                  ? 'site_evolution_budget_exhausted'
                  : 'provider_budget_exceeded';
    super(code);
    this.code = code;
    if (kind === 'cost_per_day' && limit > 0)
      this.resetAt = beijingBudgetDay().resetAt;
  }
}
export interface ProviderBudgetLimits {
  /** Legacy frequency rules are opt-in; product capacity is owned by admission. */
  enforceLegacyCallRates?: boolean;
  maxCallsPerMinute: number;
  minimumReservationUsd: number;
  deploymentMaxCallsPerMinute?: number;
  /** Deprecated money limits are intentionally ignored. There is no implicit personal or mixed global money limit. */
  maxCostUsdPerDay?: number | null;
  deploymentMaxCostUsdPerDay?: number | null;
  policies?: BudgetPolicies;
  loadPolicies?: () => Promise<BudgetPolicies>;
}
const amount = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
const attribution = (input: ProviderBudgetInput): UsageAttribution =>
  input.attribution ?? {
    business: 'historical_unclassified',
    payer: 'historical_unclassified',
  };
export function applicableBudgets(a: UsageAttribution): BudgetKey[] {
  if (a.payer !== 'platform') return [];
  if (a.business === 'analysis') return ['analysis_daily'];
  if (a.business === 'chat') return ['chat_daily'];
  if (a.business === 'evolution') return ['evolution_task', 'evolution_daily'];
  throw new Error('model_usage_attribution_required');
}
function assertBudget(
  key: BudgetKey,
  limit: number | null,
  total: number,
  reservation: number,
) {
  if (limit !== null && (limit === 0 || total + reservation > limit + 1e-10))
    throw new ProviderBudgetExceededError(
      key === 'evolution_task' ? 'cost_per_task' : 'cost_per_day',
      limit,
      key,
    );
}
function assertPricing(
  input: ProviderBudgetInput,
  policies: BudgetPolicies,
  a: UsageAttribution,
) {
  for(const key of applicableBudgets(a))if(policies[key]===0)assertBudget(key,0,0,0);
  if (
    input.pricingKnown === false &&
    applicableBudgets(a).some((key) => policies[key] !== null)
  )
    throw Object.assign(new Error('site_model_pricing_unknown'), {
      code: 'site_model_pricing_unknown',
      statusCode: 503,
    });
}
export interface LocalUsageEvent {
  eventId: string;
  ownerId: string;
  provider: string;
  model: string;
  startedAt: number;
  reservedCostUsd: number;
  attribution: UsageAttribution;
  report?: ProviderUsageReport;
  settled: boolean;
}
/** Single-process development implementation. Production reserves in PostgreSQL. */
export class LocalProviderUsageBudget implements ProviderUsageBudget {
  private readonly mutex = new KeyedMutex();
  readonly events: LocalUsageEvent[] = [];
  constructor(
    private readonly configured: ProviderBudgetLimits,
    private readonly now = Date.now,
  ) {}
  async acquire(input: ProviderBudgetInput): Promise<ProviderBudgetPermit> {
    input.signal?.throwIfAborted();
    const event = await this.mutex.runExclusive('budget', async () => {
      input.signal?.throwIfAborted();
      const now = this.now(),
        day = beijingBudgetDay(now),
        a = attribution(input);
      const recent = this.events.filter((e) => e.startedAt > now - 60_000);
      if (
        this.configured.enforceLegacyCallRates === true && recent.filter((e) => e.ownerId === input.ownerId).length >=
        this.configured.maxCallsPerMinute
      )
        throw new ProviderBudgetExceededError(
          'calls_per_minute',
          this.configured.maxCallsPerMinute,
        );
      if (this.configured.enforceLegacyCallRates === true && recent.length >= (this.configured.deploymentMaxCallsPerMinute ?? 240))
        throw new ProviderBudgetExceededError(
          'calls_per_minute',
          this.configured.deploymentMaxCallsPerMinute ?? 240,
          'deployment',
        );
      const reservation = Math.max(
        amount(input.estimatedCostUsd),
        this.configured.minimumReservationUsd,
      );
      const policies =
        (await this.configured.loadPolicies?.()) ??
        this.configured.policies ??
        DEFAULT_BUDGET_POLICIES;
      assertPricing(input, policies, a);
      for (const key of applicableBudgets(a)) {
        if (key === 'evolution_task' && !a.taskId)
          throw new Error('model_usage_task_required');
        const rows = this.events.filter(
          (e) =>
            e.attribution.payer === 'platform' &&
            e.attribution.business === a.business &&
            (key === 'evolution_task'
              ? e.attribution.taskId === a.taskId
              : e.startedAt >= day.start),
        );
        assertBudget(
          key,
          policies[key],
          rows.reduce((sum, e) => sum + e.reservedCostUsd, 0),
          reservation,
        );
      }
      const created: LocalUsageEvent = {
        eventId: randomUUID(),
        ownerId: input.ownerId,
        provider: input.provider,
        model: input.model,
        startedAt: now,
        reservedCostUsd: reservation,
        attribution: a,
        settled: false,
      };
      this.events.push(created);
      return created;
    });
    return {
      eventId: event.eventId,
      release: async (report) =>
        this.mutex.runExclusive('budget', async () => {
          if (event.settled) return;
          event.settled = true;
          event.report = report;
          if (report?.usageKnown)
            event.reservedCostUsd = amount(report.costUsd);
        }),
    };
  }
}
export class PostgresProviderUsageBudget implements ProviderUsageBudget {
  constructor(
    private readonly pool: ProviderBudgetDbPool,
    private readonly configured: ProviderBudgetLimits,
  ) {}
  async acquire(input: ProviderBudgetInput): Promise<ProviderBudgetPermit> {
    input.signal?.throwIfAborted();
    const client = await connectBudget(this.pool, input.signal),
      eventId = randomUUID(),
      a = attribution(input);
    try {
      input.signal?.throwIfAborted();
      const calls = this.configured.enforceLegacyCallRates === true ? await client.query<{ owner: string; deployment: string }>(
        `SELECT COUNT(*) FILTER(WHERE owner_id=$1)::text AS owner,COUNT(*)::text AS deployment FROM provider_usage_events WHERE started_at>=clock_timestamp()-interval '1 minute'`,
        [input.ownerId],
      ) : { rows: [] };
      if (
        this.configured.enforceLegacyCallRates === true && Number(calls.rows[0]?.owner ?? 0) >= this.configured.maxCallsPerMinute
      )
        throw new ProviderBudgetExceededError(
          'calls_per_minute',
          this.configured.maxCallsPerMinute,
        );
      if (
        this.configured.enforceLegacyCallRates === true && Number(calls.rows[0]?.deployment ?? 0) >=
        (this.configured.deploymentMaxCallsPerMinute ?? 240)
      )
        throw new ProviderBudgetExceededError(
          'calls_per_minute',
          this.configured.deploymentMaxCallsPerMinute ?? 240,
          'deployment',
        );
      const configured = await client.query<{ value: BudgetPolicies }>(
        'SELECT value FROM admin_documents WHERE key=$1',
        ['budgets'],
      );
      const policies =
        configured.rows[0]?.value ??
        this.configured.policies ??
        DEFAULT_BUDGET_POLICIES;
      assertPricing(input, policies, a);
      const reservation = Math.max(
        amount(input.estimatedCostUsd),
        this.configured.minimumReservationUsd,
      );
      for (const key of applicableBudgets(a)) {
        if (key === 'evolution_task' && !a.taskId)
          throw new Error('model_usage_task_required');
        if (policies[key] === null) continue;
        const cost = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(GREATEST(reserved_cost_usd,cost_usd)),0)::text AS total FROM provider_usage_events WHERE payer='platform' AND business=$1 AND ${key === 'evolution_task' ? 'task_id=$2' : "started_at >= (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')"}`,
          key === 'evolution_task' ? [a.business, a.taskId] : [a.business],
        );
        assertBudget(
          key,
          policies[key],
          Number(cost.rows[0]?.total ?? 0),
          reservation,
        );
      }
      await client.query(
        `INSERT INTO provider_usage_events(event_id,owner_id,provider,model,started_at,status,reserved_cost_usd,cost_usd,input_tokens,output_tokens,cached_tokens,cache_write_tokens,business,payer,agent_role,connection_id,config_version,task_id) VALUES($1,$2,$3,$4,clock_timestamp(),'reserved',$5,0,0,0,0,0,$6,$7,$8,$9,$10,$11)`,
        [
          eventId,
          input.ownerId,
          input.provider,
          input.model,
          reservation,
          a.business,
          a.payer,
          a.agentRole ?? null,
          a.connectionId ?? null,
          a.configVersion ?? null,
          a.taskId ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return {
      eventId,
      release: async (report) => {
        const update = await this.pool.connect();
        try {
          // Persisted predicate permits settlement retry after a connection failure and prevents duplicate callbacks.
          await update.query(
            `UPDATE provider_usage_events SET completed_at=clock_timestamp(),status=$2,reserved_cost_usd=CASE WHEN $8 THEN $3 ELSE reserved_cost_usd END,cost_usd=$3,usage_known=$8,input_tokens=$4,output_tokens=$5,cached_tokens=$6,cache_write_tokens=$7 WHERE event_id=$1 AND status='reserved'`,
            [
              eventId,
              report?.status ?? 'failed',
              amount(report?.costUsd),
              Math.floor(amount(report?.inputTokens)),
              Math.floor(amount(report?.outputTokens)),
              Math.floor(amount(report?.cachedTokens)),
              Math.floor(amount(report?.cacheWriteTokens)),
              report?.usageKnown ?? false,
            ],
          );
        } finally {
          update.release();
        }
      },
    };
  }
}
export class NoopProviderUsageBudget implements ProviderUsageBudget {
  async acquire(input: {
    signal?: AbortSignal;
  }): Promise<ProviderBudgetPermit> {
    input.signal?.throwIfAborted();
    return { release: async () => undefined };
  }
}
export function createProviderUsageBudget(
  input: ProviderBudgetLimits & { pool?: ProviderBudgetDbPool | null },
): ProviderUsageBudget {
  return input.pool
    ? new PostgresProviderUsageBudget(input.pool, input)
    : new LocalProviderUsageBudget(input);
}
