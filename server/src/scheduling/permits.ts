import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { KeyedMutex } from '../agent/mutex.js';
import { serviceError } from '../services/errors.js';

export interface PermitRow {
  id: string; owner: string; resource: string; state: 'waiting' | 'running';
  order: number; expires: number; deadline: number;
}
export interface PermitStore {
  change<T>(namespace: string, fn: (rows: PermitRow[], now: number) => T, signal?: AbortSignal): Promise<T>;
}

/** A cancelled pool wait releases a late connection instead of leaking it. */
export async function connectWithAbort<T extends { release(): void }>(pool: { connect(): Promise<T> }, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new Error('cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    void pool.connect().then(client => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { client.release(); abort(); } else resolve(client);
    }, error => { signal?.removeEventListener('abort', abort); reject(error); });
  });
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class LocalPermitStore implements PermitStore {
  private readonly rows = new Map<string, PermitRow[]>();
  private readonly mutex = new KeyedMutex();
  change<T>(namespace: string, fn: (rows: PermitRow[], now: number) => T, signal?: AbortSignal): Promise<T> {
    return this.mutex.runExclusive(namespace, async () => {
      signal?.throwIfAborted();
      const rows = structuredClone(this.rows.get(namespace) ?? []);
      const result = fn(rows, Date.now());
      this.rows.set(namespace, rows);
      return result;
    }, { signal });
  }
}

const stores = new WeakMap<object, PermitStore>();
export function permitStoreFor(owner: object): PermitStore {
  let store = stores.get(owner);
  if (!store) {
    const pool = (owner as { pool?: Pool }).pool;
    store = pool ? new PostgresPermitStore(pool) : new LocalPermitStore();
    stores.set(owner, store);
  }
  return store;
}

export class PostgresPermitStore implements PermitStore {
  constructor(readonly pool: Pool) {}
  async change<T>(namespace: string, fn: (rows: PermitRow[], now: number) => T, signal?: AbortSignal): Promise<T> {
    const client = await connectWithAbort<PoolClient>(this.pool, signal);
    let released = false;
    const release = (destroy = false) => { if (!released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await client.query('BEGIN');
      // Try rather than queue a connection behind a long database lock.
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`admission:${namespace}`]);
      if (!lock.rows[0]?.acquired) {
        await client.query('ROLLBACK');
      } else {
        signal?.throwIfAborted();
        const loaded = await client.query<{ payload: PermitRow }>('SELECT payload FROM runtime_permits WHERE namespace=$1', [namespace]);
        const clock = await client.query<{ now: string }>('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now');
        const before = new Map(loaded.rows.map(row => [row.payload.id, JSON.stringify(row.payload)]));
        const rows = loaded.rows.map(row => row.payload);
        const result = fn(rows, Number(clock.rows[0]!.now));
        const remaining = new Set(rows.map(row => row.id));
        const removed = [...before.keys()].filter(id => !remaining.has(id));
        if (removed.length) await client.query('DELETE FROM runtime_permits WHERE namespace=$1 AND permit_id=ANY($2::text[])', [namespace, removed]);
        for (const row of rows) {
          const payload = JSON.stringify(row);
          if (before.get(row.id) === payload) continue;
          await client.query(`INSERT INTO runtime_permits(namespace,permit_id,payload) VALUES($1,$2,$3::jsonb)
            ON CONFLICT(namespace,permit_id) DO UPDATE SET payload=EXCLUDED.payload`, [namespace, row.id, payload]);
        }
        signal?.throwIfAborted();
        await client.query('COMMIT');
        return result;
      }
    } catch (error) {
      if (!released) await client.query('ROLLBACK').catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally { signal?.removeEventListener('abort', abort); release(); }
    await delay(25, signal);
    return this.change(namespace, fn, signal);
  }
}

export interface CapacityPolicy {
  running: number; waiting: number; waitMs: number;
  ownerActive?: number; ownerWaiting?: number;
  exclusiveResource?: boolean;
  ownerError?: string; fullError?: string; timeoutError?: string;
}
export interface CapacityPermit {
  id: string; signal: AbortSignal; release(): Promise<void>;
}
export const LEASE_MS = 30_000;

function prune(rows: PermitRow[], now: number) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.expires <= now || (row.state === 'waiting' && row.deadline <= now)) rows.splice(i, 1);
  }
}
function promote(rows: PermitRow[], policy: CapacityPolicy) {
  let active = rows.filter(row => row.state === 'running').length;
  for (const row of [...rows].sort((a,b) => a.order-b.order)) {
    if (active >= policy.running) break;
    if (row.state === 'waiting') { row.state = 'running'; active++; }
  }
}

export class CapacityScheduler {
  constructor(readonly store: PermitStore, readonly namespace: string, readonly policy: CapacityPolicy) {}
  async acquire(owner: string, resource: string, signal?: AbortSignal, onWaiting?: () => void): Promise<CapacityPermit> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const lost = new AbortController();
    const combined = signal ? AbortSignal.any([signal, lost.signal]) : lost.signal;
    const waitingDeadline = new AbortController();
    const waitingSignal = AbortSignal.any([combined, waitingDeadline.signal]);
    const waitTimer = setTimeout(() => waitingDeadline.abort(serviceError(
      this.policy.timeoutError ?? 'chat_wait_timeout', '等待处理超时，请稍后重试。', 503)), this.policy.waitMs || LEASE_MS);
    waitTimer.unref();
    const renewal = new AbortController();
    const renewalSignal = AbortSignal.any([combined, renewal.signal]);
    let leaseStarted = performance.now();
    let admitted = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let renewing = false;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      clearTimeout(waitTimer);
      clearTimeout(watchdog);
      renewal.abort(new Error('permit_released'));
      if (admitted) {
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(() => cleanup.abort(new Error('permit_cleanup_timeout')), 1000);
        cleanupTimer.unref();
        try {
          await this.store.change(this.namespace, rows => {
            const index = rows.findIndex(row => row.id === id);
            if (index >= 0) rows.splice(index, 1);
          }, cleanup.signal);
        } catch {
          // Leases provide eventual reclamation if the database is unavailable.
          console.warn('[capacity] deferred lease cleanup', { lane: this.namespace.split(':')[0] });
        } finally { clearTimeout(cleanupTimer); }
      }
    };
    try {
      let state = await this.store.change(this.namespace, (rows, now) => {
        prune(rows, now); promote(rows, this.policy);
        if (this.policy.exclusiveResource && rows.some(row => row.resource === resource))
          throw serviceError('session_busy', '上一轮仍在处理，请等待它结束或取消后再试', 409);
        const own = rows.filter(row => row.owner === owner);
        if (own.length >= (this.policy.ownerActive ?? Infinity))
          throw serviceError(this.policy.ownerError ?? 'chat_owner_busy', '你已有多轮对话正在进行，请等待一轮结束或取消后再试。', 429);
        const waiting = rows.filter(row => row.state === 'waiting');
        const busy = rows.filter(row => row.state === 'running').length >= this.policy.running;
        if (busy && (waiting.length >= this.policy.waiting || own.filter(row => row.state === 'waiting').length >= (this.policy.ownerWaiting ?? Infinity)))
          throw serviceError(this.policy.fullError ?? 'chat_queue_full', '服务器繁忙，请稍后重试。', 503);
        const row: PermitRow = { id, owner, resource, state: busy ? 'waiting' : 'running',
          order: Math.max(0, ...rows.map(row => row.order)) + 1, expires: now+LEASE_MS, deadline: now+this.policy.waitMs };
        rows.push(row);
        return row.state;
      }, waitingSignal);
      admitted = true;
      if (state === 'waiting') onWaiting?.();
      while (state === 'waiting') {
        await delay(100, waitingSignal);
        leaseStarted = performance.now();
        state = await this.store.change(this.namespace, (rows, now) => {
          const own = rows.find(row => row.id === id);
          if (!own || (own.state === 'waiting' && own.deadline <= now)) throw serviceError(this.policy.timeoutError ?? 'chat_wait_timeout', '等待处理超时，请稍后重试。', 503);
          if (own.expires <= now) throw serviceError('runtime_lease_lost', '处理已中断，请重试。', 503);
          own.expires = now+LEASE_MS;
          prune(rows, now); promote(rows, this.policy);
          return own.state;
        }, waitingSignal);
      }
      clearTimeout(waitTimer);
      waitingSignal.throwIfAborted();
      const armWatchdog = (started: number) => {
        clearTimeout(watchdog);
        const remaining = LEASE_MS - 1000 - (performance.now() - started);
        if (remaining <= 0) { lost.abort(new Error('runtime_lease_lost')); return; }
        watchdog = setTimeout(() => lost.abort(new Error('runtime_lease_lost')), remaining);
        watchdog.unref();
      };
      armWatchdog(leaseStarted);
      combined.throwIfAborted();
      timer = setInterval(() => {
        if (renewing || released || combined.aborted) return;
        renewing = true;
        const started = performance.now();
        void this.store.change(this.namespace, (rows, now) => {
          const row = rows.find(row => row.id === id);
          if (!row || row.expires <= now) throw new Error('runtime_lease_lost');
          row.expires = now+LEASE_MS;
        }, renewalSignal).then(() => { if (!released && !combined.aborted) armWatchdog(started); }).catch(error => { if (!released) lost.abort(error); }).finally(() => { renewing = false; });
      }, LEASE_MS/3);
      timer.unref();
      return { id, signal: combined, release };
    } catch (error) { await release(); throw error; }
  }
}

/** Fence session writes against an expired execution, on the write transaction. */
export async function assertSessionPermit(client: PoolClient, id: string) {
  const result = await client.query(`SELECT permit_id FROM runtime_permits
    WHERE namespace='session' AND permit_id=$1 AND (payload->>'expires')::bigint > extract(epoch FROM clock_timestamp())*1000 FOR UPDATE`, [id]);
  if (!result.rowCount) throw new Error('pi_session_lease_lost');
}
