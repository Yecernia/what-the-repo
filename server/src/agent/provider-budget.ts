import { randomUUID } from "node:crypto";
import { KeyedMutex } from "./mutex.js";

export interface ProviderUsageReport {
  /** False means the numeric fields are placeholders, not a zero-cost bill. */
  usageKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  status: "completed" | "failed" | "cancelled";
}

export interface ProviderBudgetPermit {
  eventId?: string;
  release(report?: ProviderUsageReport): Promise<void>;
}

export interface ProviderUsageBudget {
  acquire(input: {
    ownerId: string;
    provider: string;
    model: string;
    estimatedCostUsd?: number;
    signal?: AbortSignal;
  }): Promise<ProviderBudgetPermit>;
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

export type ProviderBudgetScope = "owner" | "deployment";
export type ProviderBudgetKind = "calls_per_minute" | "cost_per_day";

export class ProviderBudgetExceededError extends Error {
  readonly code = "provider_budget_exceeded";
  readonly statusCode = 429;

  constructor(
    readonly kind: ProviderBudgetKind,
    readonly limit: number,
    readonly scope: ProviderBudgetScope = "owner",
  ) {
    super(`provider budget exceeded: ${scope}:${kind}`);
  }
}

export interface ProviderBudgetLimits {
  maxCallsPerMinute: number;
  maxCostUsdPerDay: number;
  minimumReservationUsd: number;
  deploymentMaxCallsPerMinute?: number;
  deploymentMaxCostUsdPerDay?: number;
}

function limits(input: ProviderBudgetLimits): Required<ProviderBudgetLimits> {
  return {
    maxCallsPerMinute: Math.max(1, Math.min(100_000, Math.floor(input.maxCallsPerMinute))),
    maxCostUsdPerDay: Math.max(0.000001, Math.min(1_000_000, input.maxCostUsdPerDay)),
    minimumReservationUsd: Math.max(0, Math.min(1_000, input.minimumReservationUsd)),
    deploymentMaxCallsPerMinute: Math.max(
      1,
      Math.min(100_000, Math.floor(input.deploymentMaxCallsPerMinute ?? 100_000)),
    ),
    deploymentMaxCostUsdPerDay: Math.max(
      0.000001,
      Math.min(1_000_000, input.deploymentMaxCostUsdPerDay ?? 1_000_000),
    ),
  };
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedReservation(input: number | undefined, minimum: number): number {
  return Math.max(minimum, finiteNonNegative(input));
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("provider_budget_aborted");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

interface LocalEvent {
  eventId: string;
  ownerId: string;
  provider: string;
  model: string;
  startedAt: number;
  reservedCostUsd: number;
  report?: ProviderUsageReport;
}

/** File Store/test implementation. It has the same admission semantics, but is not multi-process. */
export class LocalProviderUsageBudget implements ProviderUsageBudget {
  private readonly mutex = new KeyedMutex();
  private readonly events = new Map<string, LocalEvent[]>();
  private readonly configured: Required<ProviderBudgetLimits>;

  constructor(configured: ProviderBudgetLimits) {
    this.configured = limits(configured);
  }

  async acquire(input: {
    ownerId: string;
    provider: string;
    model: string;
    estimatedCostUsd?: number;
    signal?: AbortSignal;
  }): Promise<ProviderBudgetPermit> {
    assertNotAborted(input.signal);
    const ownerId = input.ownerId.trim();
    if (!ownerId) return new NoopProviderUsageBudget().acquire(input);
    const reservation = normalizedReservation(input.estimatedCostUsd, this.configured.minimumReservationUsd);
    const event = await this.mutex.runExclusive("provider-budget:deployment", async () =>
      this.mutex.runExclusive(`provider-budget:owner:${ownerId}`, async () => {
        assertNotAborted(input.signal);
        const now = Date.now();
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        const deploymentRows: LocalEvent[] = [];
        for (const [eventOwnerId, ownerEvents] of this.events) {
          const retained = ownerEvents.filter((row) => row.startedAt >= dayStart.getTime());
          if (retained.length) this.events.set(eventOwnerId, retained);
          else this.events.delete(eventOwnerId);
          deploymentRows.push(...retained);
        }
        const rows = this.events.get(ownerId) ?? [];
        const recentCalls = rows.filter((row) => row.startedAt >= now - 60_000).length;
        if (recentCalls >= this.configured.maxCallsPerMinute) {
          throw new ProviderBudgetExceededError("calls_per_minute", this.configured.maxCallsPerMinute);
        }
        const reservedToday = rows.reduce((total, row) => total + row.reservedCostUsd, 0);
        if (reservedToday + reservation > this.configured.maxCostUsdPerDay) {
          throw new ProviderBudgetExceededError("cost_per_day", this.configured.maxCostUsdPerDay);
        }
        const deploymentRecentCalls = deploymentRows.filter((row) => row.startedAt >= now - 60_000).length;
        if (deploymentRecentCalls >= this.configured.deploymentMaxCallsPerMinute) {
          throw new ProviderBudgetExceededError(
            "calls_per_minute",
            this.configured.deploymentMaxCallsPerMinute,
            "deployment",
          );
        }
        const deploymentReservedToday = deploymentRows.reduce(
          (total, row) => total + row.reservedCostUsd,
          0,
        );
        if (deploymentReservedToday + reservation > this.configured.deploymentMaxCostUsdPerDay) {
          throw new ProviderBudgetExceededError(
            "cost_per_day",
            this.configured.deploymentMaxCostUsdPerDay,
            "deployment",
          );
        }
        const created: LocalEvent = {
          eventId: randomUUID(),
          ownerId,
          provider: input.provider.slice(0, 120),
          model: input.model.slice(0, 240),
          startedAt: now,
          reservedCostUsd: reservation,
        };
        rows.push(created);
        this.events.set(ownerId, rows);
        return created;
      }),
    );
    let released = false;
    return {
      eventId: event.eventId,
      release: async (report) => {
        if (released) return;
        released = true;
        await this.mutex.runExclusive(`provider-budget:owner:${event.ownerId}`, async () => {
          if (!event.report) {
            event.report = report;
            if (report?.usageKnown) event.reservedCostUsd = finiteNonNegative(report.costUsd);
          }
        });
      },
    };
  }
}

/** PostgreSQL implementation. A short transaction reserves a call; the provider stream never holds a DB connection. */
export class PostgresProviderUsageBudget implements ProviderUsageBudget {
  private readonly configured: Required<ProviderBudgetLimits>;

  constructor(
    private readonly pool: ProviderBudgetDbPool,
    configured: ProviderBudgetLimits,
  ) {
    this.configured = limits(configured);
  }

  async acquire(input: {
    ownerId: string;
    provider: string;
    model: string;
    estimatedCostUsd?: number;
    signal?: AbortSignal;
  }): Promise<ProviderBudgetPermit> {
    assertNotAborted(input.signal);
    const ownerId = input.ownerId.trim();
    if (!ownerId) return new NoopProviderUsageBudget().acquire(input);
    const reservation = normalizedReservation(input.estimatedCostUsd, this.configured.minimumReservationUsd);
    const client = await this.pool.connect();
    const eventId = randomUUID();
    let committed = false;
    try {
      assertNotAborted(input.signal);
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["provider-budget-global"],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`provider-budget:${ownerId}`],
      );
      const calls = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM provider_usage_events
         WHERE owner_id = $1 AND started_at >= clock_timestamp() - interval '1 minute'`,
        [ownerId],
      );
      if (Number(calls.rows[0]?.count ?? 0) >= this.configured.maxCallsPerMinute) {
        await client.query("ROLLBACK");
        throw new ProviderBudgetExceededError("calls_per_minute", this.configured.maxCallsPerMinute);
      }
      const cost = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(GREATEST(reserved_cost_usd, cost_usd)), 0)::text AS total
         FROM provider_usage_events
         WHERE owner_id = $1 AND started_at >= date_trunc('day', clock_timestamp())`,
        [ownerId],
      );
      if (Number(cost.rows[0]?.total ?? 0) + reservation > this.configured.maxCostUsdPerDay) {
        await client.query("ROLLBACK");
        throw new ProviderBudgetExceededError("cost_per_day", this.configured.maxCostUsdPerDay);
      }
      const deploymentCalls = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM provider_usage_events
         WHERE started_at >= clock_timestamp() - interval '1 minute'`,
      );
      if (Number(deploymentCalls.rows[0]?.count ?? 0) >= this.configured.deploymentMaxCallsPerMinute) {
        await client.query("ROLLBACK");
        throw new ProviderBudgetExceededError(
          "calls_per_minute",
          this.configured.deploymentMaxCallsPerMinute,
          "deployment",
        );
      }
      const deploymentCost = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(GREATEST(reserved_cost_usd, cost_usd)), 0)::text AS total
         FROM provider_usage_events
         WHERE started_at >= date_trunc('day', clock_timestamp())`,
      );
      if (Number(deploymentCost.rows[0]?.total ?? 0) + reservation > this.configured.deploymentMaxCostUsdPerDay) {
        await client.query("ROLLBACK");
        throw new ProviderBudgetExceededError(
          "cost_per_day",
          this.configured.deploymentMaxCostUsdPerDay,
          "deployment",
        );
      }
      await client.query(
        `INSERT INTO provider_usage_events(
           event_id, owner_id, provider, model, started_at, status,
           reserved_cost_usd, cost_usd, input_tokens, output_tokens,
           cached_tokens, cache_write_tokens
         ) VALUES ($1, $2, $3, $4, clock_timestamp(), 'reserved', $5, 0, 0, 0, 0, 0)`,
        [eventId, ownerId, input.provider.slice(0, 120), input.model.slice(0, 240), reservation],
      );
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    let released = false;
    return {
      eventId,
      release: async (report) => {
        if (released) return;
        released = true;
        const update = await this.pool.connect();
        try {
          const row = report ?? {
            usageKnown: false,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            status: "failed" as const,
          };
          await update.query(
            `UPDATE provider_usage_events SET
               completed_at = clock_timestamp(), status = $2,
               reserved_cost_usd = CASE WHEN $8 THEN $3 ELSE reserved_cost_usd END,
               cost_usd = $3, usage_known = $8,
               input_tokens = $4, output_tokens = $5,
               cached_tokens = $6, cache_write_tokens = $7
             WHERE event_id = $1`,
            [eventId, row.status, finiteNonNegative(row.costUsd), Math.floor(finiteNonNegative(row.inputTokens)), Math.floor(finiteNonNegative(row.outputTokens)), Math.floor(finiteNonNegative(row.cachedTokens)), Math.floor(finiteNonNegative(row.cacheWriteTokens)), row.usageKnown],
          );
        } finally {
          update.release();
        }
      },
    };
  }
}

export class NoopProviderUsageBudget implements ProviderUsageBudget {
  async acquire(input: { signal?: AbortSignal }): Promise<ProviderBudgetPermit> {
    assertNotAborted(input.signal);
    return { release: async () => undefined };
  }
}

export function createProviderUsageBudget(input: {
  pool?: ProviderBudgetDbPool | null;
  maxCallsPerMinute: number;
  maxCostUsdPerDay: number;
  minimumReservationUsd: number;
  deploymentMaxCallsPerMinute?: number;
  deploymentMaxCostUsdPerDay?: number;
}): ProviderUsageBudget {
  const configured = {
    maxCallsPerMinute: input.maxCallsPerMinute,
    maxCostUsdPerDay: input.maxCostUsdPerDay,
    minimumReservationUsd: input.minimumReservationUsd,
    deploymentMaxCallsPerMinute: input.deploymentMaxCallsPerMinute,
    deploymentMaxCostUsdPerDay: input.deploymentMaxCostUsdPerDay,
  };
  return input.pool
    ? new PostgresProviderUsageBudget(input.pool, configured)
    : new LocalProviderUsageBudget(configured);
}
