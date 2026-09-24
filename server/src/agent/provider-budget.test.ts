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
      assert.equal(result.reason.code, 'site_budget_busy');
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
    attribution: { ...input.attribution!, business: 'evolution' as const, taskId: 'evolution-1' },
  };
  const next = { ...evolution, attribution: { ...evolution.attribution, taskId: 'evolution-2' } };
  // The per-task cap refuses a task whose estimate does not fit; the daily cap stops the next task.
  for (const [policies, second] of [
    [{ evolution_daily: null, evolution_task: 0.015 }, { ...next, estimatedCostUsd: 0.02 }],
    [{ evolution_daily: 0.015, evolution_task: null }, next],
  ] as const) {
    const budget = new LocalProviderUsageBudget(limits(policies));
    await budget.acquire(evolution);
    await assert.rejects(
      () => budget.acquire(second),
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
      { code: 'site_budget_insufficient' },
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
    code: 'site_budget_busy',
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
  const permit = await budget.acquire({ ...input, budgetLease: { namespace: 'model-test', id: 'lease-test' } });
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
  assert.ok(insert?.sql.includes('lease_namespace,lease_id'));
  assert.deepEqual(insert?.params.slice(-2), ['model-test', 'lease-test']);
  assert.equal(
    queries.filter(
      (q) => q.sql.startsWith('UPDATE') && q.sql.includes("status='reserved'"),
    ).length,
    2,
  );
  assert.ok(queries.filter((q) => q.sql.startsWith('UPDATE')).every((q) =>
    q.sql.includes('settlement_evidence=$9') && q.params[8] === 'unknown'));
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

test('temporary reservations wait for settlement without duplicate events or false daily exhaustion', async () => {
  const budget = new LocalProviderUsageBudget(limits({ analysis_daily: 0.015 }));
  const first = await budget.acquire(input);
  const waiting = budget.acquire({ ...input, reservationWaitMs: 1000 });
  await first.release(report);
  const second = await waiting;
  assert.equal(budget.events.length, 2);
  await second.release(report);
  await assert.rejects(budget.acquire(input), { code: 'site_budget_insufficient' });
});

test('waiting is bounded, abortable, and never refunds unknown settled usage', async () => {
  const budget = new LocalProviderUsageBudget(limits({ analysis_daily: 0.01 }));
  const first = await budget.acquire(input);
  await assert.rejects(budget.acquire({ ...input, reservationWaitMs: 20 }), { code: 'site_budget_busy' });
  const cancel = new AbortController();
  const waiting = budget.acquire({ ...input, reservationWaitMs: 1000, signal: cancel.signal });
  cancel.abort(new Error('cancel-budget-wait'));
  await assert.rejects(waiting, /cancel-budget-wait/);
  assert.equal(budget.events.length, 1);
  await first.release({ ...report, usageKnown: false, costUsd: 0 });
  await assert.rejects(budget.acquire({ ...input, reservationWaitMs: 1000 }), { code: 'site_analysis_budget_exhausted' });
});

test('a permanently insufficient second policy takes precedence over a temporarily held first policy', async () => {
  const budget = new LocalProviderUsageBudget(limits({ evolution_task: 0.02, evolution_daily: 0.03 }));
  const evolution = { ...input, attribution: { ...input.attribution!, business: 'evolution' as const, taskId: 'first' } };
  await budget.acquire({ ...evolution, estimatedCostUsd: 0.015 });
  const spent = await budget.acquire({ ...evolution, estimatedCostUsd: 0.014, attribution: { ...evolution.attribution, taskId: 'other' } });
  await spent.release({ ...report, costUsd: 0.014 });
  // Active task allowance fits by itself, but settled daily usage cannot cover another request.
  await assert.rejects(budget.acquire({ ...evolution, estimatedCostUsd: 0.02, reservationWaitMs: 1000,
    attribution: { ...evolution.attribution, taskId: 'third' } }), { code: 'site_budget_insufficient' });
});
test('a started task finishes past the daily budget while new tasks are refused', async () => {
  const budget = new LocalProviderUsageBudget(limits({ chat_daily: 0.05 }));
  const turn = { ...input, estimatedCostUsd: 0.03,
    attribution: { ...input.attribution!, business: 'chat' as const, taskId: 'turn-1' } };
  const first = await budget.acquire(turn);
  await first.release({ ...report, costUsd: 0.04 });
  // The same chat turn keeps calling tools and the model after the day is spent.
  await budget.acquire(turn);
  await budget.acquire(turn);
  await assert.rejects(budget.acquire({ ...turn, reservationWaitMs: 0, attribution: { ...turn.attribution, taskId: 'turn-2' } }),
    (error) => error instanceof ProviderBudgetExceededError && error.scope === 'chat_daily');
  // Zero means "no new paid work": a started task still finishes.
  const stopped = new LocalProviderUsageBudget(limits({ chat_daily: 0.05 }));
  await stopped.acquire(turn);
  (stopped as unknown as { configured: { policies: BudgetPolicies } }).configured.policies.chat_daily = 0;
  await stopped.acquire(turn);
  await assert.rejects(stopped.acquire({ ...turn, attribution: { ...turn.attribution, taskId: 'turn-3' } }),
    { code: 'site_budget_disabled' });
  // User-paid calls never count as an admitted platform task.
  const byok = new LocalProviderUsageBudget(limits({ chat_daily: 0 }));
  await byok.acquire({ ...turn, attribution: { ...turn.attribution, payer: 'user' } });
  await assert.rejects(byok.acquire(turn), { code: 'site_budget_disabled' });
});
test('a repository update cap admits the update by its estimate and then lets it finish', async () => {
  const budget = new LocalProviderUsageBudget(limits({ analysis_daily: null, repository_update: 1 }));
  const capped = { ...input, estimatedCostUsd: 0.4,
    attribution: { business: 'analysis' as const, payer: 'platform' as const, taskId: 'update-job', repositoryUpdate: true } };
  const first = await budget.acquire(capped);
  await first.release({ usageKnown: true, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0.9, status: 'completed' });
  // Stopping a started update would waste what it already spent: it runs past the cap.
  await budget.acquire(capped);
  await budget.acquire(capped);
  // Another update is admitted only when its estimate fits the cap.
  await budget.acquire({ ...capped, attribution: { ...capped.attribution, taskId: 'other-job' } });
  await assert.rejects(budget.acquire({ ...capped, estimatedCostUsd: 1.5, attribution: { ...capped.attribution, taskId: 'large-job' } }),
    { code: 'site_repository_update_budget_exhausted' });
  await budget.acquire({ ...capped, estimatedCostUsd: 1.5, attribution: { ...capped.attribution, repositoryUpdate: false } });
  // Saved budgets from before the key existed still work: the default leaves updates uncapped.
  const legacy = new LocalProviderUsageBudget({ ...limits({ analysis_daily: null }),
    policies: { analysis_daily: null, chat_daily: 5, evolution_task: 1, evolution_daily: 5 } as never });
  await legacy.acquire({ ...capped, estimatedCostUsd: 50 });
  const disabled = new LocalProviderUsageBudget(limits({ analysis_daily: null, repository_update: 0 }));
  await assert.rejects(disabled.acquire(capped), { code: 'site_budget_disabled' });
});
