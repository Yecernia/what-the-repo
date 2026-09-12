import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalProviderUsageBudget,
  PostgresProviderUsageBudget,
  ProviderBudgetExceededError,
} from "./provider-budget.js";

const report = {
  usageKnown: true,
  inputTokens: 12,
  outputTokens: 8,
  cachedTokens: 2,
  cacheWriteTokens: 0,
  costUsd: 0.004,
  status: "completed" as const,
};

test("local provider budget limits calls per owner and keeps owners isolated", async () => {
  const budget = new LocalProviderUsageBudget({
    maxCallsPerMinute: 1,
    maxCostUsdPerDay: 1,
    minimumReservationUsd: 0.01,
  });
  const first = await budget.acquire({ ownerId: "owner-a", provider: "deepseek", model: "chat" });
  await assert.rejects(
    () => budget.acquire({ ownerId: "owner-a", provider: "deepseek", model: "chat" }),
    (error: unknown) => error instanceof ProviderBudgetExceededError && error.kind === "calls_per_minute",
  );
  const other = await budget.acquire({ ownerId: "owner-b", provider: "deepseek", model: "chat" });
  await first.release(report);
  await other.release(report);
});

test("local provider budget reserves an estimated daily cost before the call", async () => {
  const budget = new LocalProviderUsageBudget({
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 0.02,
    minimumReservationUsd: 0.01,
  });
  const first = await budget.acquire({
    ownerId: "owner-cost",
    provider: "deepseek",
    model: "chat",
    estimatedCostUsd: 0.01,
  });
  await assert.rejects(
    () => budget.acquire({
      ownerId: "owner-cost",
      provider: "deepseek",
      model: "chat",
      estimatedCostUsd: 0.011,
    }),
    (error: unknown) => error instanceof ProviderBudgetExceededError && error.kind === "cost_per_day",
  );
  await first.release(report);
});

test("local provider budget caps total calls across different owners", async () => {
  const budget = new LocalProviderUsageBudget({
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 10,
    minimumReservationUsd: 0.01,
    deploymentMaxCallsPerMinute: 1,
    deploymentMaxCostUsdPerDay: 10,
  });
  const first = await budget.acquire({ ownerId: "owner-global-a", provider: "deepseek", model: "chat" });
  await assert.rejects(
    () => budget.acquire({ ownerId: "owner-global-b", provider: "deepseek", model: "chat" }),
    (error: unknown) => error instanceof ProviderBudgetExceededError
      && error.scope === "deployment"
      && error.kind === "calls_per_minute",
  );
  await first.release(report);
});

test("local provider budget caps total reserved cost across different owners", async () => {
  const budget = new LocalProviderUsageBudget({
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 10,
    minimumReservationUsd: 0.01,
    deploymentMaxCallsPerMinute: 10,
    deploymentMaxCostUsdPerDay: 0.015,
  });
  const first = await budget.acquire({ ownerId: "owner-global-cost-a", provider: "deepseek", model: "chat" });
  await assert.rejects(
    () => budget.acquire({ ownerId: "owner-global-cost-b", provider: "deepseek", model: "chat" }),
    (error: unknown) => error instanceof ProviderBudgetExceededError
      && error.scope === "deployment"
      && error.kind === "cost_per_day",
  );
  await first.release(report);
});

test("local provider budget releases a reservation once, even when release is repeated", async () => {
  const budget = new LocalProviderUsageBudget({
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 0.02,
    minimumReservationUsd: 0.01,
  });
  const permit = await budget.acquire({
    ownerId: "owner-release",
    provider: "deepseek",
    model: "chat",
    estimatedCostUsd: 0.01,
  });
  await permit.release(report);
  await permit.release({ ...report, costUsd: 0.019 });
  const next = await budget.acquire({
    ownerId: "owner-release",
    provider: "deepseek",
    model: "chat",
    estimatedCostUsd: 0.015,
  });
  await next.release(report);
});

test("unknown cancellation usage retains owner and deployment reservations, including a missing report", async () => {
  for (const settlement of [undefined, { ...report, usageKnown: false, costUsd: 0, status: "cancelled" as const }]) {
    const budget = new LocalProviderUsageBudget({ maxCallsPerMinute: 10, maxCostUsdPerDay: 0.015,
      minimumReservationUsd: 0.01, deploymentMaxCostUsdPerDay: 0.015 });
    const input = { ownerId: "owner", provider: "test", model: "test" };
    const permit = await budget.acquire(input);
    await permit.release(settlement);
    // Repeated release cannot turn an unknown bill into a free call.
    await permit.release({ ...report, costUsd: 0 });
    await assert.rejects(() => budget.acquire(input), (error: unknown) =>
      error instanceof ProviderBudgetExceededError && error.kind === "cost_per_day" && error.scope === "owner");
    await assert.rejects(() => budget.acquire({ ...input, ownerId: "other" }), (error: unknown) =>
      error instanceof ProviderBudgetExceededError && error.kind === "cost_per_day" && error.scope === "deployment");
  }
});

test("reported usage settles a failed call and known zero releases the reservation", async () => {
  for (const costUsd of [0, 0.004]) {
    const budget = new LocalProviderUsageBudget({ maxCallsPerMinute: 10, maxCostUsdPerDay: 0.015, minimumReservationUsd: 0.01 });
    const input = { ownerId: "owner", provider: "test", model: "test" };
    const permit = await budget.acquire(input);
    await permit.release({ ...report, status: "failed", costUsd });
    const next = await budget.acquire(input);
    await next.release(report);
  }
});

test("PostgreSQL provider budget records a reservation and final usage without holding a connection", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async connect() {
      return {
        async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
          queries.push({ sql, params });
          if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" } as unknown as T] };
          if (sql.includes("SUM(GREATEST")) return { rows: [{ total: "0" } as unknown as T] };
          return { rows: [] as T[] };
        },
        release() {},
      };
    },
  };
  const budget = new PostgresProviderUsageBudget(pool, {
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 1,
    minimumReservationUsd: 0.01,
  });
  const permit = await budget.acquire({ ownerId: "owner-pg", provider: "deepseek", model: "chat" });
  await permit.release(report);
  assert.equal(queries.filter((row) => row.sql.includes("pg_advisory_xact_lock")).length, 2);
  assert.ok(queries.some((row) => row.params[0] === "provider-budget-global"));
  assert.ok(queries.some((row) => row.sql.includes("INSERT INTO provider_usage_events")));
  assert.ok(queries.some((row) => row.sql.includes("UPDATE provider_usage_events")));
});

test("PostgreSQL provider budget rejects a deployment-wide call limit", async () => {
  const pool = {
    async connect() {
      return {
        async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
          if (sql.includes("COUNT(*)") && params.length === 0) {
            return { rows: [{ count: "1" } as unknown as T] };
          }
          if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" } as unknown as T] };
          if (sql.includes("SUM(GREATEST")) return { rows: [{ total: "0" } as unknown as T] };
          return { rows: [] as T[] };
        },
        release() {},
      };
    },
  };
  const budget = new PostgresProviderUsageBudget(pool, {
    maxCallsPerMinute: 10,
    maxCostUsdPerDay: 10,
    minimumReservationUsd: 0.01,
    deploymentMaxCallsPerMinute: 1,
    deploymentMaxCostUsdPerDay: 10,
  });
  await assert.rejects(
    () => budget.acquire({ ownerId: "owner-global-pg", provider: "deepseek", model: "chat" }),
    (error: unknown) => error instanceof ProviderBudgetExceededError
      && error.scope === "deployment"
      && error.kind === "calls_per_minute",
  );
});
