import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export async function applyMigrations(pool: Pool, migrationsRoot: string): Promise<string[]> {
  const names = (await readdir(migrationsRoot))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .sort();
  const applied: string[] = [];
  for (const name of names) {
    const version = name.replace(/\.sql$/, "");
    const exists = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    if (exists.rows[0]?.exists) {
      const row = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (row.rowCount) continue;
    }
    await pool.query(await readFile(join(migrationsRoot, name), "utf8"));
    applied.push(version);
  }
  return applied;
}
