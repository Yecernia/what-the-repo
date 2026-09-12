import type { Pool, PoolClient } from "pg";

/** Tables and columns are code-owned constants; all repository data is a parameter. */
export async function insertSnapshotRows<T extends object>(
  db: Pick<Pool | PoolClient, "query">,
  table: string,
  columns: string[],
  rows: readonly T[],
  convert?: (row: T) => object,
): Promise<void> {
  // A fixed query avoids tens of thousands of placeholders per batch. JSONB
  // preserves nested payloads/arrays; the existing table supplies SQL types.
  const names = columns.join(", ");
  const sql = `INSERT INTO ${table}(${names}) SELECT ${names}
    FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`;
  let batch: string[] = [], bytes = 2;
  const flush = async () => {
    if (!batch.length) return;
    await db.query(sql, [`[${batch.join(",")}]`]);
    batch = []; bytes = 2;
  };
  for (const item of rows) {
    const row = (convert ? convert(item) : item) as Record<string, unknown>;
    const encoded = JSON.stringify(Object.fromEntries(columns.map(name => [name, row[name] ?? null])));
    const size = Buffer.byteLength(encoded) + 1;
    if (batch.length && (batch.length >= 2_000 || bytes + size > 4 * 1024 * 1024)) await flush();
    batch.push(encoded); bytes += size;
  }
  await flush();
}
