import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { join } from 'node:path';
import { applyMigrations } from '../persistence/migrations.js';
import { PostgresProviderUsageBudget, DEFAULT_BUDGET_POLICIES } from './provider-budget.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('PostgreSQL: independent pools wait atomically without pinning connections or refunding unknown usage', { skip: !url, timeout: 90_000 }, async () => {
  const target = new URL(url!);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const pools = [0, 1].map(() => new Pool({ connectionString: url, max: 1 }));
  const limits = { maxCallsPerMinute: 1000, minimumReservationUsd: 0,
    policies: { ...DEFAULT_BUDGET_POLICIES, analysis_daily: 0.025 } };
  const budgets = pools.map(pool => new PostgresProviderUsageBudget(pool, limits));
  const input = { ownerId: 'isolated-budget', provider: 'test', model: 'mock', estimatedCostUsd: 0.01,
    reservationWaitMs: 30_000, attribution: { business: 'analysis' as const, payer: 'platform' as const } };
  const report = { usageKnown: true, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
    costUsd: 0.001, status: 'completed' as const };
  try {
    await applyMigrations(pools[0], join(process.cwd(), 'migrations'));
    let peak = 0;
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const pool = pools[i % 2];
      const permit = await budgets[i % 2].acquire(input);
      const cost = Number((await pool.query('SELECT SUM(GREATEST(cost_usd,reserved_cost_usd)) AS total FROM provider_usage_events')).rows[0].total);
      peak = Math.max(peak, cost);
      assert.ok(cost <= 0.025 + 1e-10, `oversubscribed: ${cost}`);
      await permit.release(report);
    }));
    assert.ok(peak > 0);
    const summary = (await pools[0].query("SELECT count(*)::int AS count, sum(cost_usd)::float8 AS cost, count(*) FILTER (WHERE status='reserved')::int AS active FROM provider_usage_events")).rows[0];
    assert.deepEqual(summary, { count: 10, cost: 0.01, active: 0 });
    const held = await budgets[0].acquire(input);
    const cancel = new AbortController();
    const waiting = budgets[1].acquire({ ...input, signal: cancel.signal });
    // This SELECT uses the only connection; an admission wait must release it.
    await pools[1].query('SELECT 1');
    cancel.abort(new Error('cancel-pg-budget'));
    await assert.rejects(waiting, /cancel-pg-budget/);
    await held.release({ ...report, usageKnown: false, costUsd: 0 });
    await assert.rejects(budgets[1].acquire(input), { code: 'site_budget_insufficient' });
    assert.equal((await pools[0].query('SELECT count(*)::int AS count FROM provider_usage_events')).rows[0].count, 11);
    assert.equal(pools.every(pool => pool.waitingCount === 0), true);
  } finally { await Promise.all(pools.map(pool => pool.end())); }
});
