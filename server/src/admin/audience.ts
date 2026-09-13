import type { Pool } from 'pg';

/** Counts stored, non-deleted identities; system and internal test identities are excluded. */
export async function audienceCounts(pool: Pool) {
  return (
    await pool.query(`SELECT
    count(*) FILTER (WHERE owner_id LIKE 'github:%')::int AS github,
    count(*) FILTER (WHERE owner_id LIKE 'guest:%')::int AS guest,
    clock_timestamp() AS observed_at
    FROM app_users WHERE deleted_at IS NULL`)
  ).rows[0];
}

/** One aggregate per UTC minute across replicas. No per-person browsing history is stored. */
export async function sampleAudience(pool: Pool) {
  await pool.query(`INSERT INTO admin_audience_samples
    (minute,observed_at,github,guest,online_github,online_guest)
    SELECT date_trunc('minute',statement_timestamp()),statement_timestamp(),
      (SELECT count(*) FROM app_users WHERE owner_id LIKE 'github:%' AND deleted_at IS NULL),
      (SELECT count(*) FROM app_users WHERE owner_id LIKE 'guest:%' AND deleted_at IS NULL),
      (SELECT count(*) FROM online_presence p JOIN app_users u USING(owner_id)
        WHERE p.kind='github' AND u.deleted_at IS NULL AND p.seen_at>statement_timestamp()-interval '90 seconds'),
      (SELECT count(*) FROM online_presence p JOIN app_users u USING(owner_id)
        WHERE p.kind='guest' AND u.deleted_at IS NULL AND p.seen_at>statement_timestamp()-interval '90 seconds')
    ON CONFLICT(minute) DO NOTHING`);
  // Retain aggregate metrics only. This never deletes users, projects or snapshots.
  await pool.query(
    `DELETE FROM admin_audience_samples WHERE minute<statement_timestamp()-interval '7 days'`,
  );
}

export function collectAudience(pool: Pool | undefined) {
  if (!pool) return async () => undefined;
  let pending: Promise<void> | undefined;
  const sample = () => {
    if (!pending)
      pending = sampleAudience(pool)
        .catch(() => {
          // Preserve gaps on failure rather than writing zero counts.
        })
        .finally(() => {
          pending = undefined;
        });
  };
  sample();
  const timer = setInterval(sample, 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
