export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  isLocked(key: string): boolean { return this.tails.has(key); }

  /** Never wait while holding another lock; the reservation is synchronous. */
  async tryRunExclusive<T>(key: string, task: () => Promise<T>): Promise<
    { acquired: false } | { acquired: true; value: T }
  > {
    if (this.isLocked(key)) return { acquired: false };
    return { acquired: true, value: await this.runExclusive(key, task) };
  }

  async runExclusive<T>(
    key: string,
    task: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    let acquired = false;
    const finish = (): void => {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
    try {
      await waitForTurn(previous, options.signal);
      if (options.signal?.aborted) throw abortError(options.signal);
      acquired = true;
      return await task();
    } catch (error) {
      if (!acquired) {
        // Keep this queue position chained behind the active holder so a later
        // waiter cannot bypass it when this caller gives up early.
        void previous.then(finish, finish);
      }
      throw error;
    } finally {
      if (acquired) finish();
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("mutex_wait_aborted");
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
