import { randomUUID } from 'node:crypto';
import type { ProductStore } from '../persistence/store.js';
import type { RuntimeMetrics } from '../observability/metrics.js';
import { adminDocuments } from './runtime-config.js';

export function collectRuntimeObservations(
  store: ProductStore,
  role: string,
  metrics: RuntimeMetrics,
) {
  const pool = adminDocuments(store).pool;
  if (!pool) return () => undefined;
  const instanceId = role + ':' + randomUUID();
  let busy = false;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      await pool.query(
        `INSERT INTO runtime_observations(instance_id,role,payload,observed_at) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(instance_id) DO UPDATE SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at`,
        [instanceId, role, JSON.stringify(metrics.snapshot())],
      );
      await pool.query(
        `DELETE FROM runtime_observations WHERE observed_at<clock_timestamp()-interval '1 day'`,
      );
    } catch {
      /* A failed collector becomes stale. Never replace it with healthy zeroes. */
    } finally {
      busy = false;
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
