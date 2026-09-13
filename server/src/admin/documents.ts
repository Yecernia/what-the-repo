import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { KeyedMutex } from '../agent/mutex.js';

export interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  outcome: string;
  created_at?: string;
}
/** PostgreSQL is authoritative. File mode is only for a single-process isolated development instance. */
export class AdminDocuments {
  private readonly mutex = new KeyedMutex();
  constructor(
    readonly root: string,
    readonly pool?: Pool,
  ) {}
  private path(key: string) {
    return join(this.root, 'admin', Buffer.from(key).toString('hex') + '.json');
  }
  async read<T>(key: string, fallback: T): Promise<T> {
    if (this.pool)
      return (
        (
          await this.pool.query(
            'SELECT value FROM admin_documents WHERE key=$1',
            [key],
          )
        ).rows[0]?.value ?? structuredClone(fallback)
      );
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return structuredClone(fallback);
    }
  }
  async change<T, R>(
    key: string,
    fallback: T,
    mutate: (value: T) => R | Promise<R>,
    audit?: AuditEntry,
  ): Promise<R> {
    if (!this.pool)
      return this.mutex.runExclusive(key, async () => {
        const value = await this.read(key, fallback);
        const result = await mutate(value);
        await mkdir(join(this.root, 'admin'), { recursive: true });
        const temporary = this.path(key) + '.' + randomUUID();
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, this.path(key));
        if (audit) await this.audit(audit);
        return result;
      });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['admin:' + key],
      );
      const value: T =
        (
          await client.query(
            'SELECT value FROM admin_documents WHERE key=$1 FOR UPDATE',
            [key],
          )
        ).rows[0]?.value ?? structuredClone(fallback);
      const result = await mutate(value);
      await client.query(
        `INSERT INTO admin_documents(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,
        [key, JSON.stringify(value)],
      );
      if (audit)
        await client.query(
          'INSERT INTO admin_audit(actor,action,target,outcome) VALUES($1,$2,$3,$4)',
          [audit.actor, audit.action, audit.target, audit.outcome],
        );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(entry: AuditEntry) {
    // Only these enumerated scalar fields are accepted; never arbitrary request bodies or errors.
    if (this.pool) {
      await this.pool.query(
        'INSERT INTO admin_audit(actor,action,target,outcome) VALUES($1,$2,$3,$4)',
        [entry.actor, entry.action, entry.target, entry.outcome],
      );
      return;
    }
    await this.change<AuditEntry[], void>('audit', [], (rows) => {
      rows.push({ ...entry, created_at: new Date().toISOString() });
    });
  }
  async auditList(limit = 100) {
    return this.pool
      ? (
          await this.pool.query(
            'SELECT * FROM admin_audit ORDER BY id DESC LIMIT $1',
            [limit],
          )
        ).rows
      : (await this.read<AuditEntry[]>('audit', [])).slice(-limit).reverse();
  }
}
