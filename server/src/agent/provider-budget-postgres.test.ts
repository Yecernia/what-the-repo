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
  const report = { usageKnown: true, settlementEvidence: 'provider_reported' as const,
    inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
    costUsd: 0.001, status: 'completed' as const };
  let previousPolicy: { value: unknown; updated_at: Date } | null | undefined;
  try {
    await applyMigrations(pools[0], join(process.cwd(), 'migrations'));
    const saved = await pools[0].query<{ value: unknown; updated_at: Date }>(
      "SELECT value,updated_at FROM admin_documents WHERE key='budgets'");
    previousPolicy = saved.rows[0] ?? null;
    await pools[0].query(
      "INSERT INTO admin_documents(key,value) VALUES('budgets',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()",
      [JSON.stringify(limits.policies)],
    );
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
    const summary = (await pools[0].query("SELECT count(*)::int AS count, sum(cost_usd)::float8 AS cost, count(*) FILTER (WHERE status='reserved')::int AS active, count(*) FILTER (WHERE settlement_evidence='provider_reported')::int AS reported FROM provider_usage_events")).rows[0];
    assert.deepEqual(summary, { count: 10, cost: 0.01, active: 0, reported: 10 });
    const held = await budgets[0].acquire(input);
    const cancel = new AbortController();
    const waiting = budgets[1].acquire({ ...input, signal: cancel.signal });
    // This SELECT uses the only connection; an admission wait must release it.
    await pools[1].query('SELECT 1');
    cancel.abort(new Error('cancel-pg-budget'));
    await assert.rejects(waiting, /cancel-pg-budget/);
    await pools[0].query("UPDATE provider_usage_events SET status='failed',usage_known=false,settlement_evidence='lease_expired' WHERE event_id=$1", [held.eventId]);
    await held.release({ ...report, usageKnown: false, costUsd: 0, settlementEvidence: 'unknown' });
    await assert.rejects(budgets[1].acquire(input), { code: 'site_budget_insufficient' });
    const expired = (await pools[0].query('SELECT status,settlement_evidence,reserved_cost_usd FROM provider_usage_events WHERE event_id=$1', [held.eventId])).rows[0];
    assert.equal(expired.status, 'failed');
    assert.equal(expired.settlement_evidence, 'lease_expired');
    assert.equal(Number(expired.reserved_cost_usd), 0.01);
    await held.release(report);
    const arrived = (await pools[0].query('SELECT status,usage_known,settlement_evidence,cost_usd FROM provider_usage_events WHERE event_id=$1', [held.eventId])).rows[0];
    assert.deepEqual([arrived.status, arrived.usage_known, arrived.settlement_evidence, Number(arrived.cost_usd)],
      ['completed', true, 'provider_reported', 0.001]);
    await held.release({ ...report, usageKnown: false, costUsd: 0, settlementEvidence: 'unknown' });
    const stillArrived = (await pools[0].query('SELECT usage_known,settlement_evidence,cost_usd FROM provider_usage_events WHERE event_id=$1', [held.eventId])).rows[0];
    assert.deepEqual([stillArrived.usage_known, stillArrived.settlement_evidence, Number(stillArrived.cost_usd)],
      [true, 'provider_reported', 0.001]);
    const heldZero = await budgets[0].acquire(input);
    await pools[0].query("UPDATE provider_usage_events SET status='failed',usage_known=false,settlement_evidence='lease_expired' WHERE event_id=$1", [heldZero.eventId]);
    await heldZero.release({ ...report, usageKnown: true, costUsd: 0, status: 'failed', settlementEvidence: 'explicit_rejection' });
    const zero = (await pools[0].query('SELECT status,usage_known,settlement_evidence,reserved_cost_usd FROM provider_usage_events WHERE event_id=$1', [heldZero.eventId])).rows[0];
    assert.deepEqual([zero.status, zero.usage_known, zero.settlement_evidence, Number(zero.reserved_cost_usd)],
      ['failed', true, 'explicit_rejection', 0]);
    await heldZero.release(report);
    const stillZero = (await pools[0].query('SELECT usage_known,settlement_evidence,cost_usd FROM provider_usage_events WHERE event_id=$1', [heldZero.eventId])).rows[0];
    assert.deepEqual([stillZero.usage_known, stillZero.settlement_evidence, Number(stillZero.cost_usd)],
      [true, 'explicit_rejection', 0]);
    assert.equal((await pools[0].query('SELECT count(*)::int AS count FROM provider_usage_events')).rows[0].count, 12);
    assert.equal(pools.every(pool => pool.waitingCount === 0), true);
  } finally {
    try {
      if (previousPolicy === null) await pools[0].query("DELETE FROM admin_documents WHERE key='budgets'");
      else if (previousPolicy) await pools[0].query(
        "UPDATE admin_documents SET value=$1,updated_at=$2 WHERE key='budgets'",
        [JSON.stringify(previousPolicy.value), previousPolicy.updated_at],
      );
    } finally { await Promise.all(pools.map(pool => pool.end())); }
  }
});
