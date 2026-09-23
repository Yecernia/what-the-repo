import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createProviderGateFactory, LocalProviderCallGate, PostgresProviderCallGate,
  type ProviderPermit } from '../agent/provider-gate.js';
import { applyMigrations } from '../persistence/migrations.js';
import { recoverExpiredProviderReservations } from './provider-budget-recovery.js';

test('local model permits do not claim a PostgreSQL budget lease', async () => {
  const permit = await new LocalProviderCallGate(1).acquire();
  try { assert.equal(permit.budgetLease, undefined); }
  finally { await permit.release(); }
  const localGate = createProviderGateFactory({ maxConcurrent: 1 })({
    provider: 'fixture', connectionId: 'fixture', baseUrl: 'https://example.com',
    apiKey: 'fixture', model: 'fixture', modelSelector: 'fixture', modelId: 'fixture',
    api: 'openai-completions', builtin: false,
  });
  const localResourcePermit = await localGate.acquire();
  try { assert.equal(localResourcePermit.budgetLease, undefined); }
  finally { await localResourcePermit.release(); }
});

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('PostgreSQL: recover only old reservations whose matching model lease is gone',
  { skip: !url, timeout: 60_000 }, async () => {
    const target = new URL(url!);
    assert.equal(target.hostname, '127.0.0.1');
    assert.match(target.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const pool = new Pool({ connectionString: url, max: 4 });
    const eventIds: string[] = [];
    let resourcePermit: ProviderPermit | undefined;
    let legacyPermit: ProviderPermit | undefined;
    const stalePermitId = randomUUID();
    try {
      await applyMigrations(pool, join(process.cwd(), 'migrations'));
      const gate = createProviderGateFactory({ pool, maxConcurrent: 4 })({
        provider: 'fixture', connectionId: 'fixture', baseUrl: 'https://example.com',
        apiKey: 'fixture', model: 'fixture', modelSelector: 'fixture', modelId: 'fixture',
        api: 'openai-completions', builtin: false,
      }, 'chat', { ownerId: randomUUID(), taskId: randomUUID() });
      resourcePermit = await gate.acquire();
      legacyPermit = await new PostgresProviderCallGate(pool, randomUUID(), 1).acquire();
      assert.equal(resourcePermit.budgetLease?.namespace, 'resource-admission-v1');
      assert.match(resourcePermit.budgetLease?.id ?? '', /^[0-9a-f-]{36}$/);
      assert.match(legacyPermit.budgetLease?.namespace ?? '', /^model:/);

      const lease = resourcePermit.budgetLease!;
      const legacyLease = legacyPermit.budgetLease!;
      const insert = async (
        ageSeconds: number, status: 'reserved' | 'completed', usageKnown: boolean | null,
        budgetLease?: { namespace: string; id: string },
      ) => {
        const id = randomUUID();
        eventIds.push(id);
        await pool.query(
          `INSERT INTO provider_usage_events
           (event_id,owner_id,provider,model,started_at,status,reserved_cost_usd,cost_usd,
            usage_known,lease_namespace,lease_id,business,payer)
           VALUES ($1,'recovery-fixture','fixture','fixture',
             statement_timestamp()-($2::int * interval '1 second'),$3,0.12,0,
             $4,$5,$6,'chat','platform')`,
          [id, ageSeconds, status, usageKnown, budgetLease?.namespace ?? null, budgetLease?.id ?? null],
        );
        return id;
      };
      const active = await insert(180, 'reserved', null, lease);
      const activeLegacy = await insert(180, 'reserved', null, legacyLease);
      const wrongNamespace = await insert(180, 'reserved', null,
        { namespace: 'different-namespace', id: lease.id });
      const unbound = await insert(180, 'reserved', null);
      const young = await insert(30, 'reserved', null, { namespace: lease.namespace, id: randomUUID() });
      const known = await insert(180, 'reserved', true, { namespace: lease.namespace, id: randomUUID() });
      const completed = await insert(180, 'completed', false, { namespace: lease.namespace, id: randomUUID() });
      const expired = await insert(180, 'reserved', null, { namespace: lease.namespace, id: stalePermitId });
      const missing = await insert(180, 'reserved', null, { namespace: lease.namespace, id: randomUUID() });
      await pool.query(
        `INSERT INTO runtime_permits(namespace,permit_id,payload) VALUES
         ($1,$2,jsonb_build_object('id',$2::text,'state','running','expires',
           (extract(epoch FROM statement_timestamp())*1000-60000)::bigint))`,
        [lease.namespace, stalePermitId],
      );
      const reservedTotal = async () => Number((await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(GREATEST(reserved_cost_usd,cost_usd)),0)::text AS total
         FROM provider_usage_events WHERE event_id=ANY($1::text[])`, [eventIds],
      )).rows[0]?.total ?? 0);
      const before = await reservedTotal();
      assert.equal(await recoverExpiredProviderReservations(pool, 2), 2);
      assert.equal(await recoverExpiredProviderReservations(pool, 2), 1);
      assert.equal(await recoverExpiredProviderReservations(pool, 2), 0);
      assert.equal(await reservedTotal(), before, 'unknown usage retains its full budget occupancy');
      const rows = (await pool.query<{
        event_id: string; status: string; usage_known: boolean | null;
        settlement_evidence: string | null; completed_at: Date | null; reserved_cost_usd: string;
      }>(`SELECT event_id,status,usage_known,settlement_evidence,completed_at,reserved_cost_usd
           FROM provider_usage_events WHERE event_id=ANY($1::text[])`, [eventIds])).rows;
      const byId = new Map(rows.map(row => [row.event_id, row]));
      for (const id of [wrongNamespace, expired, missing]) {
        const row = byId.get(id)!;
        assert.equal(row.status, 'failed');
        assert.equal(row.usage_known, false);
        assert.equal(row.settlement_evidence, 'lease_expired');
        assert.ok(row.completed_at);
        assert.equal(Number(row.reserved_cost_usd), 0.12);
      }
      for (const id of [active, activeLegacy, unbound, young, known])
        assert.equal(byId.get(id)?.status, 'reserved');
      assert.equal(byId.get(completed)?.status, 'completed');
    } finally {
      await resourcePermit?.release();
      await legacyPermit?.release();
      if (eventIds.length) await pool.query('DELETE FROM provider_usage_events WHERE event_id=ANY($1::text[])', [eventIds]);
      await pool.query('DELETE FROM runtime_permits WHERE permit_id=$1', [stalePermitId]);
      await pool.end();
    }
  });
