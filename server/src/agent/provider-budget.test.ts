import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalProviderUsageBudget,
  PostgresProviderUsageBudget,
  ProviderBudgetExceededError,
  DEFAULT_BUDGET_POLICIES,
  beijingBudgetDay,
  type BudgetPolicies,
  type ProviderBudgetDbPool,
  type ProviderBudgetInput,
} from './provider-budget.js';
const report = {
  usageKnown: true,
  inputTokens: 12,
  outputTokens: 8,
  cachedTokens: 2,
  cacheWriteTokens: 0,
  costUsd: 0.004,
  status: 'completed' as const,
};
const input: ProviderBudgetInput = {
  ownerId: 'system:repository-analysis',
  provider: 'test',
  model: 'test',
  estimatedCostUsd: 0.01,
  attribution: {
    business: 'analysis',
    payer: 'platform',
    agentRole: 'component-explanation',
    taskId: 'analysis-1',
    configVersion: 2,
    connectionId: 'test',
  },
};
const limits = (policies: Partial<BudgetPolicies> = {}) => ({
  maxCallsPerMinute: 1000,
  deploymentMaxCallsPerMinute: 1000,
  minimumReservationUsd: 0.01,
  policies: { ...DEFAULT_BUDGET_POLICIES, ...policies },
});
test('concurrent callers reserve a shared analysis budget exactly once each', async () => {
  const budget = new LocalProviderUsageBudget(limits({ analysis_daily: 0.05 }));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      budget.acquire({ ...input, ownerId: 'owner' + i }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
  assert.equal(budget.events.length, 5);
  for (const result of results)
    if (result.status === 'rejected')
      assert.equal(result.reason.code, 'site_analysis_budget_exhausted');
});
test('null is unlimited, zero is disabled, legacy identity $1 never applies', async () => {
  const budget = new LocalProviderUsageBudget({
    ...limits({ analysis_daily: null }),
    maxCostUsdPerDay: 1,
    deploymentMaxCostUsdPerDay: 1,
  });
  await budget.acquire({ ...input, estimatedCostUsd: 200 });
  const zero = new LocalProviderUsageBudget(limits({ analysis_daily: 0 }));
  await assert.rejects(() => zero.acquire(input), {
    code: 'site_budget_disabled',
  });
});
test('BYOK never debits platform business budgets or the obsolete mixed call counters', async () => {
  const budget = new LocalProviderUsageBudget({
    ...limits({
      analysis_daily: 0,
      chat_daily: 0,
      evolution_task: 0,
      evolution_daily: 0,
    }),
    maxCallsPerMinute: 1,
  });
  const user = {
    ...input,
    attribution: {
      ...input.attribution!,
      business: 'chat' as const,
      payer: 'user' as const,
    },
  };
  const permit = await budget.acquire(user);
  await permit.release({ ...report, costUsd: 100 });
  assert.equal(budget.events[0]?.report?.costUsd, 100);
  await budget.acquire(user);
  assert.equal(budget.events.length, 2);
});
test('unlimited evolution daily/task budget does not bypass the other finite budget', async () => {
  const evolution = {
    ...input,
    attribution: { ...input.attribution!, business: 'evolution' as const },
  };
  for (const policies of [
    { evolution_daily: null, evolution_task: 0.015 },
    { evolution_daily: 0.015, evolution_task: null },
  ]) {
    const budget = new LocalProviderUsageBudget(limits(policies));
    await budget.acquire(evolution);
    await assert.rejects(
      () => budget.acquire(evolution),
      (e) => e instanceof ProviderBudgetExceededError,
    );
  }
  const budget = new LocalProviderUsageBudget(
    limits({ analysis_daily: 0, chat_daily: 1 }),
  );
  await budget.acquire({
    ...input,
    attribution: { ...input.attribution!, business: 'chat' },
  });
});
test('unknown usage including cancellation remains reserved; duplicate settlement cannot refund it', async () => {
  for (const settlement of [
    undefined,
    { ...report, usageKnown: false, costUsd: 0, status: 'cancelled' as const },
  ]) {
    const budget = new LocalProviderUsageBudget(
      limits({ analysis_daily: 0.015 }),
    );
    const permit = await budget.acquire(input);
    await permit.release(settlement);
    await permit.release({ ...report, costUsd: 0 });
    await assert.rejects(
      () => budget.acquire({ ...input, ownerId: 'another' }),
      { code: 'site_analysis_budget_exhausted' },
    );
  }
});
test('known failure/zero usage releases excess reservation, exactly once', async () => {
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const budget = new LocalProviderUsageBudget(
      limits({ analysis_daily: 0.015 }),
    );
    const permit = await budget.acquire(input);
    await permit.release({ ...report, costUsd: 0, status });
    await permit.release({ ...report, costUsd: 0.015 });
    await budget.acquire(input);
  }
});
test('Beijing natural day reset admits new calls and keeps previous day settlement isolated', async () => {
  let now = Date.parse('2026-09-13T15:59:59Z');
  const budget = new LocalProviderUsageBudget(
    limits({ analysis_daily: 0.01 }),
    () => now,
  );
  const permit = await budget.acquire(input);
  assert.equal(beijingBudgetDay(now).resetAt, '2026-09-13T16:00:00.000Z');
  await assert.rejects(() => budget.acquire(input));
  now += 1000;
  await budget.acquire(input);
  await permit.release({ ...report, costUsd: 2 });
  await assert.rejects(() => budget.acquire(input), {
    code: 'site_analysis_budget_exhausted',
  });
});
test('PostgreSQL uses atomic reservation, Beijing boundaries, full attribution and idempotent retryable settlement', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let failSettlement = true;
  const pool: ProviderBudgetDbPool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.startsWith('UPDATE') && failSettlement) {
            failSettlement = false;
            throw new Error('connection failed');
          }
          return { rows: sql.includes('pg_try_advisory_xact_lock') ? [{ acquired: true } as never] : [] };
        },
        release() {},
      };
    },
  };
  const budget = new PostgresProviderUsageBudget(pool, limits());
  const permit = await budget.acquire(input);
  await assert.rejects(() => permit.release(report));
  await permit.release(report);
  assert.ok(queries.some((q) => q.params[0] === 'provider-budget-global'));
  assert.ok(
    queries.some((q) => q.sql.includes("AT TIME ZONE 'Asia/Shanghai'")),
  );
  const insert = queries.find((q) => q.sql.startsWith('INSERT'));
  assert.ok(insert?.params.includes('analysis'));
  assert.ok(insert?.params.includes('component-explanation'));
  assert.ok(insert?.params.includes(2));
  assert.equal(
    queries.filter(
      (q) => q.sql.startsWith('UPDATE') && q.sql.includes("status='reserved'"),
    ).length,
    2,
  );
});
test('legacy mixed frequency limits are disabled by default', async () => {
  const budget = new LocalProviderUsageBudget({
    ...limits(),
    maxCallsPerMinute: 1,
    deploymentMaxCallsPerMinute: 2,
  });
  await budget.acquire(input);
  await budget.acquire(input);
  await budget.acquire({ ...input, ownerId: 'other' });
  await budget.acquire({ ...input, ownerId: 'third' });
  assert.equal(budget.events.length, 4);
});

test('unknown model pricing cannot masquerade as free under a finite platform budget', async () => {
  const budget = new LocalProviderUsageBudget(limits());
  await assert.rejects(
    () => budget.acquire({ ...input, pricingKnown: false }),
    { code: 'site_model_pricing_unknown' },
  );
  await budget.acquire({
    ...input,
    pricingKnown: false,
    attribution: { ...input.attribution!, payer: 'user' },
  });
  await new LocalProviderUsageBudget(limits({ analysis_daily: null })).acquire({
    ...input,
    pricingKnown: false,
  });
});
