import type { ProviderConfig } from "./provider-types.js";
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CapacityScheduler, LocalPermitStore, PostgresPermitStore } from '../scheduling/permits.js';

export interface ProviderDbClient {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface ProviderDbPool {
  connect(): Promise<ProviderDbClient>;
}

export interface ProviderPermit {
  signal?: AbortSignal;
  release(): Promise<void>;
}

export interface ProviderCallGate {
  acquire(signal?: AbortSignal): Promise<ProviderPermit>;
}

interface Waiter {
  resolve: (permit: ProviderPermit) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("provider_gate_aborted");
}

/** Per-process fallback used by File Store development and tests. */
export class LocalProviderCallGate implements ProviderCallGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.min(64, Math.floor(limit)));
  }

  private readonly limit: number;

  async acquire(signal?: AbortSignal): Promise<ProviderPermit> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return this.permit();
    }
    return new Promise<ProviderPermit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private permit(): ProviderPermit {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.onAbort && waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      waiter.resolve(this.permit());
    }
  }
}

/** Cross-process model capacity without holding a connection during inference. */
export class PostgresProviderCallGate implements ProviderCallGate {
  private readonly scheduler: CapacityScheduler;
  constructor(pool: ProviderDbPool, key: string, limit: number, _pollMs = 100) {
    this.scheduler = new CapacityScheduler(new PostgresPermitStore(pool as Pool), 'model:' + key,
      { running: limit, waiting: 128, waitMs: 60_000 });
  }
  acquire(signal?: AbortSignal): Promise<ProviderPermit> { return this.scheduler.acquire('', '', signal); }
}

export type ProviderGateFactory = (provider: ProviderConfig, business?: string) => ProviderCallGate;

export function providerGateKey(provider: ProviderConfig): string {
  // Connection labels do not identify upstream accounts; never persist raw keys.
  return createHash('sha256').update(`${provider.baseUrl.replace(/\/+$/, '').toLowerCase()}\0${provider.apiKey ?? ''}`).digest('hex');
}

export function createProviderGateFactory(input: {
  pool?: ProviderDbPool | null;
  maxConcurrent: number;
  pollMs?: number;
  analysisConcurrent?: number;
  upstreamConcurrent?: number;
}): ProviderGateFactory {
  const store = input.pool ? new PostgresPermitStore(input.pool as Pool) : new LocalPermitStore();
  return (provider, business = 'chat') => {
    const category = business === 'analysis' ? 'analysis' : business === 'evolution' ? 'evolution' : 'chat';
    const scheduler = new CapacityScheduler(store, `model:${category}`, {
      running: category === 'analysis' ? input.analysisConcurrent ?? 4 : category === 'evolution' ? 1 : input.maxConcurrent,
      waiting: 128, waitMs: 60_000, fullError: 'model_capacity_busy', timeoutError: 'model_capacity_timeout',
    });
    return { acquire: async signal => {
      const permit = await scheduler.acquire('', '', signal);
      try {
        const upstream = input.upstreamConcurrent ? await new CapacityScheduler(store, `upstream:${providerGateKey(provider)}`, {
          running: input.upstreamConcurrent, waiting: 128, waitMs: 60_000,
          fullError: 'upstream_capacity_busy', timeoutError: 'upstream_capacity_timeout',
        }).acquire('', '', permit.signal) : undefined;
        return { signal: upstream?.signal ?? permit.signal, release: async () => {
          try { await upstream?.release(); } finally { await permit.release(); }
        } };
      } catch (error) { await permit.release(); throw error; }
    } };
  };
}
