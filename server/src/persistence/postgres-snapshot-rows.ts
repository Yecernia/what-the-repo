import type { Pool, PoolClient } from 'pg';

export interface SnapshotRowWriteMetrics {
  rows: number; batches: number; encoded_bytes: number; encode_ms: number; sql_ms: number; gate_ms: number;
}
export const newSnapshotRowWriteMetrics = (): SnapshotRowWriteMetrics => ({
  rows: 0, batches: 0, encoded_bytes: 0, encode_ms: 0, sql_ms: 0, gate_ms: 0,
});

/** Tables/columns are code-owned; repository values only cross as parameters. */
export async function insertSnapshotRows<T extends object>(
  db: Pick<Pool | PoolClient, 'query'>, table: string, columns: string[], rows: Iterable<T>,
  convert?: (row: T) => object, beforeBatch?: () => Promise<void>, metrics?: SnapshotRowWriteMetrics,
): Promise<void> {
  const names = columns.join(', ');
  // Retain the measured production import path. Alternative JSON transport
  // showed no consistent improvement with the actual directory indexes.
  const sql = `INSERT INTO ${table}(${names}) SELECT ${names}
    FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`;
  let batch: string[] = [], bytes = 2, encodingAt = performance.now();
  const flush = async () => {
    if (!batch.length) return;
    const body = `[${batch.join(',')}]`;
    if (metrics) { metrics.encode_ms += performance.now() - encodingAt; metrics.encoded_bytes += Buffer.byteLength(body); }
    const gateAt = performance.now(); await beforeBatch?.();
    if (metrics) metrics.gate_ms += performance.now() - gateAt;
    const sqlAt = performance.now();
    try {
      const result = await db.query(sql, [body]);
      if (metrics) { metrics.rows += result.rowCount ?? batch.length; metrics.batches++; }
    } finally { if (metrics) metrics.sql_ms += performance.now() - sqlAt; }
    batch = []; bytes = 2; encodingAt = performance.now();
  };
  for (const item of rows) {
    const row = (convert ? convert(item) : item) as Record<string, unknown>;
    const encoded = JSON.stringify(Object.fromEntries(columns.map(name => [name, row[name] ?? null])));
    const size = Buffer.byteLength(encoded) + 1;
    if (batch.length && (batch.length >= 2000 || bytes + size > 4 * 1024 * 1024)) await flush();
    batch.push(encoded); bytes += size;
  }
  await flush();
}
