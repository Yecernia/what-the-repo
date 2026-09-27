import { adminError } from './security.js';
import { defaultRuntimeMetrics, type RuntimeMetrics } from '../observability/metrics.js';
import { runAdminRead } from './read-context.js';

interface Entry {
  value?: Record<string, unknown>;
  observedAt: number;
  pending?: Promise<void>;
  failed: boolean;
  retryAt: number;
}
interface ReadResult extends Record<string, unknown> {
  readState: { observedAt: string; stale: boolean; refreshing: boolean; refreshFailed: boolean };
}

/** Display data only. Authorization and mutation preconditions must bypass this cache. */
export class AdminReadCache {
  private readonly entries = new Map<string, Entry>();
  private active = 0;
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly now = Date.now, private readonly metrics: RuntimeMetrics = defaultRuntimeMetrics) {}

  invalidate(resources?: string[]) {
    // A detached in-flight read cannot publish over a post-mutation read.
    if (!resources) this.entries.clear();
    else for (const key of this.entries.keys()) {
      const path = key.split('?')[0];
      if (resources.some(resource => path === resource || path.startsWith(resource + '/')))
        this.entries.delete(key);
    }
  }

  async read(key: string, freshMs: number, load: () => Promise<Record<string, unknown>>, force = false): Promise<ReadResult> {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 64) {
        const idle = [...this.entries].find(([, value]) => !value.pending);
        if (!idle) throw adminError(503, 'admin_read_busy');
        this.entries.delete(idle[0]);
      }
      entry = { observedAt: 0, failed: false, retryAt: 0 };
      this.entries.set(key, entry);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    const current = entry;
    const stale = () => this.now() - current.observedAt >= freshMs;
    const usable = () => !!current.value && this.now() - current.observedAt < 15 * 60_000;
    if ((!current.value || stale() || force) && !current.pending && this.now() >= current.retryAt) {
      if (this.active < 2) {
        this.active++;
        this.metrics.setGauge('what_the_repo_admin_reads_active', this.active);
        const started = this.now();
        const pending = Promise.resolve().then(() => runAdminRead(key.split('?')[0], load, this.metrics)).then(value => {
          current.value = value;
          current.observedAt = this.now();
          current.failed = false;
          current.retryAt = 0;
        }).catch(() => {
          current.failed = true;
          current.retryAt = this.now() + 5_000;
        }).finally(() => {
          current.pending = undefined;
          this.pending.delete(pending);
          this.active--;
          this.metrics.setGauge('what_the_repo_admin_reads_active', this.active);
          this.metrics.observe('what_the_repo_admin_read_duration_ms', this.now() - started,
            { resource: key.split('?')[0], outcome: current.failed ? 'failed' : 'success' });
        });
        current.pending = pending;
        this.pending.add(pending);
      } else if (!usable()) throw adminError(503, 'admin_read_busy');
    }
    if (!usable() || force) await current.pending;
    if (!usable()) throw adminError(503, 'admin_read_unavailable');
    this.metrics.increment('what_the_repo_admin_cache_reads_total', 1,
      { resource: key.split('?')[0], state: stale() ? 'stale' : 'fresh' });
    this.metrics.setGauge('what_the_repo_admin_sample_age_ms', this.now() - current.observedAt,
      { resource: key.split('?')[0] });
    return { ...current.value, readState: {
      observedAt: new Date(current.observedAt).toISOString(), stale: stale() || current.failed,
      refreshing: !!current.pending, refreshFailed: current.failed,
    } };
  }

  async close() {
    await Promise.all(this.pending);
    this.entries.clear();
  }
}
