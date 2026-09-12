import type { ProviderConfig } from "./provider-types.js";

export interface ProviderDbClient {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface ProviderDbPool {
  connect(): Promise<ProviderDbClient>;
}

export interface ProviderPermit {
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

/** Cross-process gate backed by PostgreSQL advisory locks. */
export class PostgresProviderCallGate implements ProviderCallGate {
  private readonly limit: number;
  private readonly pollMs: number;

  constructor(
    private readonly pool: ProviderDbPool,
    private readonly key: string,
    limit: number,
    pollMs = 100,
  ) {
    this.limit = Math.max(1, Math.min(64, Math.floor(limit)));
    this.pollMs = Math.max(10, Math.min(5_000, Math.floor(pollMs)));
  }

  async acquire(signal?: AbortSignal): Promise<ProviderPermit> {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const client = await this.pool.connect();
      try {
        for (let slot = 0; slot < this.limit; slot += 1) {
          if (signal?.aborted) throw abortError(signal);
          const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtext($1), $2) AS acquired",
            [this.key, slot],
          );
          if (result.rows[0]?.acquired) return this.permit(client, slot);
        }
      } catch (error) {
        client.release();
        throw error;
      }
      client.release();
      await wait(this.pollMs, signal);
    }
  }

  private permit(client: ProviderDbClient, slot: number): ProviderPermit {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext($1), $2)",
            [this.key, slot],
          );
        } finally {
          client.release();
        }
      },
    };
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type ProviderGateFactory = (provider: ProviderConfig) => ProviderCallGate;

export function providerGateKey(provider: ProviderConfig): string {
  return [provider.provider, provider.connectionId, provider.baseUrl, provider.modelId].join("|");
}

export function createProviderGateFactory(input: {
  pool?: ProviderDbPool | null;
  maxConcurrent: number;
  pollMs?: number;
}): ProviderGateFactory {
  const gates = new Map<string, ProviderCallGate>();
  return (provider) => {
    const key = providerGateKey(provider);
    const existing = gates.get(key);
    if (existing) return existing;
    const gate = input.pool
      ? new PostgresProviderCallGate(input.pool, key, input.maxConcurrent, input.pollMs)
      : new LocalProviderCallGate(Math.max(1, Math.min(64, Math.floor(input.maxConcurrent))));
    gates.set(key, gate);
    return gate;
  };
}
