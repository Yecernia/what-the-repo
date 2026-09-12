export const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Runs one deterministic retention sweep at a time and waits for it during
 * shutdown. The standalone PostgreSQL entrypoint elects one active instance;
 * local API startup may use this class as a compatibility fallback.
 */
export class RetentionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;

  constructor(
    private readonly sweep: () => Promise<void>,
    private readonly intervalMs = DEFAULT_RETENTION_INTERVAL_MS,
  ) {}

  runNow(): Promise<void> {
    if (this.active) return this.active;
    const current = this.sweep().finally(() => {
      if (this.active === current) this.active = null;
    });
    this.active = current;
    return current;
  }

  start(options: { keepProcessAlive?: boolean } = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow().catch(() => undefined);
    }, this.intervalMs);
    if (!options.keepProcessAlive) this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.active) {
      await this.active.catch(() => undefined);
    }
  }
}
