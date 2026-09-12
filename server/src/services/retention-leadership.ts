import type { Pool, PoolClient } from "pg";

export const RETENTION_LEADERSHIP_LOCK_KEY = "what-the-repo:retention-scheduler";
export const DEFAULT_RETENTION_LEADERSHIP_RETRY_MS = 5_000;

export interface RetentionLeadershipLease {
  readonly lost: Promise<Error>;
  release(): Promise<void>;
}

export interface RetentionLeadership {
  tryAcquire(): Promise<RetentionLeadershipLease | null>;
}

class PostgresRetentionLeadershipLease implements RetentionLeadershipLease {
  readonly lost: Promise<Error>;
  private resolveLost!: (error: Error) => void;
  private released = false;
  private failed = false;

  constructor(
    private readonly client: PoolClient,
    private readonly lockKey: string,
  ) {
    this.lost = new Promise<Error>((resolve) => {
      this.resolveLost = resolve;
    });
    this.client.once("error", this.handleError);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.client.off("error", this.handleError);
    try {
      if (!this.failed) {
        await this.client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [this.lockKey],
        );
      }
    } finally {
      this.client.release(this.failed);
    }
  }

  private readonly handleError = (error: Error): void => {
    if (this.released || this.failed) return;
    this.failed = true;
    this.resolveLost(error);
  };
}

/** Holds one PostgreSQL session lock for the lifetime of the active scheduler. */
export class PostgresRetentionLeadership implements RetentionLeadership {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly lockKey = RETENTION_LEADERSHIP_LOCK_KEY,
  ) {}

  async tryAcquire(): Promise<RetentionLeadershipLease | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [this.lockKey],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      return new PostgresRetentionLeadershipLease(client, this.lockKey);
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  }
}

export async function waitForRetentionLeadership(
  leadership: RetentionLeadership,
  options: {
    signal?: AbortSignal;
    retryMs?: number;
    onWaiting?: () => void;
  } = {},
): Promise<RetentionLeadershipLease | null> {
  const retryMs = Math.max(10, options.retryMs ?? DEFAULT_RETENTION_LEADERSHIP_RETRY_MS);
  let waitingReported = false;
  while (!options.signal?.aborted) {
    const lease = await leadership.tryAcquire();
    if (lease) return lease;
    if (!waitingReported) {
      waitingReported = true;
      options.onWaiting?.();
    }
    await delay(retryMs, options.signal);
  }
  return null;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
