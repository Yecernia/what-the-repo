import type { Pool } from "pg";
import type { PiMemoryRepository } from "../agent/memory-store.js";
import type { PiMemoryRecord } from "../agent/types.js";

function record(value: unknown): PiMemoryRecord {
  return (typeof value === "string" ? JSON.parse(value) : value) as PiMemoryRecord;
}

export class PostgresMemoryStore implements PiMemoryRepository {
  constructor(private readonly pool: Pool) {}

  async list(ownerId: string): Promise<PiMemoryRecord[]> {
    const result = await this.pool.query<{ payload: PiMemoryRecord }>(
      "SELECT payload FROM pi_memories WHERE owner_id = $1 ORDER BY updated_at",
      [ownerId],
    );
    return result.rows.map((row) => record(row.payload));
  }

  async upsert(value: PiMemoryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO pi_memories(
         memory_id, owner_id, scope, memory_key, payload, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT(owner_id, memory_key) DO UPDATE SET
         memory_id = EXCLUDED.memory_id,
         scope = EXCLUDED.scope,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        value.memoryId,
        value.ownerId,
        value.scope,
        value.key,
        JSON.stringify(value),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  async clear(ownerId: string): Promise<void> {
    await this.pool.query("DELETE FROM pi_memories WHERE owner_id = $1", [ownerId]);
  }
}
