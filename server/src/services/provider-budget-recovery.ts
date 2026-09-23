import type { Pool } from 'pg';

export const PROVIDER_RESERVATION_RECOVERY_AGE_MS = 90_000;
export const PROVIDER_RESERVATION_RECOVERY_BATCH_SIZE = 100;

/**
 * Mark reservations whose bound model permit can no longer be renewed.
 * Unknown usage keeps its original reserve in the budget ledger; this only
 * changes a permanently "busy" reservation into a settled unknown one.
 */
export async function recoverExpiredProviderReservations(
  pool: Pick<Pool, 'query'>,
  batchSize = PROVIDER_RESERVATION_RECOVERY_BATCH_SIZE,
): Promise<number> {
  const boundedBatchSize = Math.max(1, Math.min(500, Math.floor(batchSize)));
  const result = await pool.query(
    `WITH candidates AS MATERIALIZED (
       SELECT event.event_id
       FROM provider_usage_events AS event
       WHERE event.status='reserved'
         AND event.usage_known IS DISTINCT FROM true
         AND event.lease_namespace IS NOT NULL
         AND event.lease_id IS NOT NULL
         AND event.started_at <= statement_timestamp() - ($2::bigint * interval '1 millisecond')
         AND NOT EXISTS (
           SELECT 1 FROM runtime_permits AS permit
           WHERE permit.namespace=event.lease_namespace
             AND permit.permit_id=event.lease_id
             AND permit.payload->>'state'='running'
             AND (permit.payload->>'expires')::bigint > extract(epoch FROM statement_timestamp()) * 1000
         )
       ORDER BY event.started_at, event.event_id
       LIMIT $1
       FOR UPDATE OF event SKIP LOCKED
     )
     UPDATE provider_usage_events AS event
     SET status='failed', usage_known=false, settlement_evidence='lease_expired',
         completed_at=statement_timestamp()
     FROM candidates
     WHERE event.event_id=candidates.event_id AND event.status='reserved'
     RETURNING event.event_id`,
    [boundedBatchSize, PROVIDER_RESERVATION_RECOVERY_AGE_MS],
  );
  return result.rowCount ?? result.rows.length;
}
