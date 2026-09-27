import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { KeyedMutex } from '../agent/mutex.js';

export interface MemoryWork {
  projectId: string; ownerId: string; requested: number; completed: number;
  processed: Record<string, string>; availableAt: number; leaseId: string | null;
  leaseUntil: number; attempts: number; lastError: string | null;
}
const locks = new KeyedMutex();
const leaseMs = 180_000;
export class MemoryWorkQueue {
  constructor(private readonly root: string, private readonly pool?: Pick<Pool, 'query'>) {}
  private async file<T>(task: (rows: MemoryWork[]) => T | Promise<T>): Promise<T> {
    const path = join(this.root, 'memory-work.json');
    return locks.runExclusive(path, async () => {
      let rows: MemoryWork[];
      try { rows = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; rows = []; }
      const result = await task(rows);
      await mkdir(this.root, { recursive: true });
      const temporary = path + '.' + randomUUID();
      await writeFile(temporary, JSON.stringify(rows)); await rename(temporary, path);
      return result;
    });
  }
  async enqueue(ownerId: string, projectId: string, delayMs = 30_000): Promise<void> {
    if (this.pool) {
      await this.pool.query(`INSERT INTO memory_work(owner_id,project_id,available_at)
        SELECT $1,$2,clock_timestamp()+$3*interval '1 millisecond' FROM projects WHERE project_id=$2 AND owner_id=$1
        ON CONFLICT(project_id) DO UPDATE SET requested=memory_work.requested+1,owner_id=EXCLUDED.owner_id,
          available_at=CASE WHEN memory_work.requested=memory_work.completed THEN EXCLUDED.available_at
            ELSE LEAST(memory_work.available_at,EXCLUDED.available_at) END`, [ownerId, projectId, delayMs]);
      return;
    }
    await this.file(rows => {
      const row = rows.find(row => row.projectId === projectId);
      if (row) { if (row.requested === row.completed) row.availableAt = Date.now() + delayMs; row.requested++; row.ownerId = ownerId; }
      else rows.push({ ownerId, projectId, requested: 1, completed: 0, processed: {}, availableAt: Date.now() + delayMs,
        leaseId: null, leaseUntil: 0, attempts: 0, lastError: null });
    });
  }
  async claim(): Promise<MemoryWork | null> {
    const id = randomUUID();
    if (!this.pool) return this.file(rows => {
      const row = rows.find(row => row.requested > row.completed && row.availableAt <= Date.now() && row.leaseUntil <= Date.now());
      if (!row) return null;
      row.leaseId = id; row.leaseUntil = Date.now() + leaseMs; return structuredClone(row);
    });
    const result = await this.pool.query(`WITH picked AS (
      SELECT project_id FROM memory_work WHERE requested>completed AND available_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE memory_work w SET lease_id=$1,lease_until=clock_timestamp()+interval '180 seconds'
      FROM picked WHERE w.project_id=picked.project_id RETURNING w.*`, [id]);
    const row = result.rows[0];
    return row ? { ownerId: row.owner_id, projectId: row.project_id, requested: Number(row.requested), completed: Number(row.completed),
      processed: row.processed, availableAt: +row.available_at, leaseId: row.lease_id, leaseUntil: +row.lease_until,
      attempts: row.attempts, lastError: row.last_error } : null;
  }
  async transferOwner(source: string, target: string): Promise<void> {
    if (this.pool) throw new Error('PostgreSQL owner transfers must use the owner merge transaction');
    await this.file(rows => {
      for (const row of rows) if (row.ownerId === source) { row.ownerId = target; row.leaseId = null; row.leaseUntil = 0; }
    });
  }
  async owns(work: MemoryWork, client?: PoolClient): Promise<boolean> {
    if (this.pool) return Boolean((await (client ?? this.pool).query(
      'SELECT 1 FROM memory_work WHERE project_id=$1 AND owner_id=$2 AND lease_id=$3 AND lease_until>clock_timestamp() FOR UPDATE',
      [work.projectId, work.ownerId, work.leaseId])).rowCount);
    return this.file(rows => rows.some(row => row.projectId === work.projectId && row.ownerId === work.ownerId
      && row.leaseId === work.leaseId && row.leaseUntil > Date.now()));
  }
  async finish(work: MemoryWork, processed: Record<string, string>, complete: boolean, client?: PoolClient): Promise<void> {
    if (this.pool) {
      const result = await (client ?? this.pool).query(`UPDATE memory_work SET processed=$4::jsonb,
        completed=CASE WHEN $5 THEN $6 ELSE completed END,lease_id=NULL,lease_until=NULL,attempts=0,last_error=NULL,
        available_at=clock_timestamp() WHERE project_id=$1 AND owner_id=$2 AND lease_id=$3 AND lease_until>clock_timestamp()`,
      [work.projectId, work.ownerId, work.leaseId, JSON.stringify(processed), complete, work.requested]);
      if (!result.rowCount) throw new Error('memory_lease_lost');
      return;
    }
    await this.file(rows => {
      const row = rows.find(row => row.projectId === work.projectId && row.ownerId === work.ownerId && row.leaseId === work.leaseId && row.leaseUntil > Date.now());
      if (!row) throw new Error('memory_lease_lost');
      row.processed = processed; if (complete) row.completed = work.requested;
      row.leaseId = null; row.leaseUntil = 0; row.attempts = 0; row.lastError = null; row.availableAt = Date.now();
    });
  }
  async fail(work: MemoryWork): Promise<void> {
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(work.attempts, 6));
    if (this.pool) {
      await this.pool.query(`UPDATE memory_work SET attempts=attempts+1,last_error='memory_extraction_failed',
        lease_id=NULL,lease_until=NULL,available_at=clock_timestamp()+$4*interval '1 millisecond'
        WHERE project_id=$1 AND owner_id=$2 AND lease_id=$3`, [work.projectId, work.ownerId, work.leaseId, delay]);
    } else await this.file(rows => {
      const row = rows.find(row => row.projectId === work.projectId && row.leaseId === work.leaseId);
      if (row) { row.attempts++; row.lastError = 'memory_extraction_failed'; row.availableAt = Date.now() + delay; row.leaseId = null; row.leaseUntil = 0; }
    });
  }
}
