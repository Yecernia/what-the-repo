import { statfs } from 'node:fs/promises';
import type { ProductStore } from '../persistence/store.js';
import type { AnalysisJob } from '../domain/jobs.js';
import type { ServerConfig } from '../config.js';
import { createSnapshotObjectStore } from '../persistence/factory.js';
import { adminDocuments } from './runtime-config.js';
import { adminError } from './security.js';

const GiB = 1024 ** 3;
export interface StoragePolicy {
  reserveBytes: number;
  taskBytes: number;
  warningBytes: number;
  resumeBytes: number;
  cosCapacityBytes: number | null;
  cosMonthlyBudgetUsd: number | null;
  cosUsdPerGiBMonth: number | null;
}
export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  reserveBytes: 2 * GiB,
  taskBytes: GiB,
  warningBytes: 8 * GiB,
  resumeBytes: 4 * GiB,
  cosCapacityBytes: null,
  cosMonthlyBudgetUsd: null,
  cosUsdPerGiBMonth: null,
};
export interface ObjectInventory {
  observedAt: string;
  objects: Array<{ key: string; bytes: number }>;
}
export class StorageManager {
  readonly docs;
  constructor(
    readonly store: ProductStore,
    readonly config: ServerConfig,
    private readonly disk = statfs,
    private readonly objects = createSnapshotObjectStore,
  ) {
    this.docs = adminDocuments(store);
  }
  async policy() {
    return this.docs.read('storage-policy', DEFAULT_STORAGE_POLICY);
  }
  async updatePolicy(input: StoragePolicy, actor: string) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).length !== Object.keys(DEFAULT_STORAGE_POLICY).length
    )
      throw adminError(400, 'admin_invalid_storage_policy');
    for (const [key, value] of Object.entries(input))
      if (
        !(key in DEFAULT_STORAGE_POLICY) ||
        (value === null
          ? !key.startsWith('cos')
          : typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      )
        throw adminError(400, 'admin_invalid_storage_policy');
    if (
      input.taskBytes < 1024 ** 2 ||
      input.reserveBytes < 1024 ** 2 ||
      input.resumeBytes < input.reserveBytes ||
      input.warningBytes < input.resumeBytes
    )
      throw adminError(400, 'admin_invalid_storage_policy');
    await this.docs.change(
      'storage-policy',
      DEFAULT_STORAGE_POLICY,
      (row) => Object.assign(row, input),
      {
        actor,
        action: 'storage.policy',
        target: 'capacity',
        outcome: 'success',
      },
    );
  }
  async refreshInventory() {
    const adapter = this.objects(this.config);
    const objects = await adapter.inventory?.();
    if (!objects) throw adminError(503, 'storage_inventory_unavailable');
    const value = { observedAt: new Date().toISOString(), objects };
    await this.docs.change<ObjectInventory, void>(
      'object-inventory',
      { observedAt: '', objects: [] },
      (row) => {
        Object.assign(row, value);
      },
    );
    return value;
  }
  async refreshInventoryIfDue(now = Date.now()) {
    return this.docs.change<ObjectInventory, 'fresh' | 'refreshed'>(
      'object-inventory',
      { observedAt: '', objects: [] },
      async (value) => {
        if (Date.parse(value.observedAt) > now - 2 * 60_000) return 'fresh';
        const objects = await this.objects(this.config).inventory?.();
        if (!objects) throw adminError(503, 'storage_inventory_unavailable');
        value.objects = objects;
        value.observedAt = new Date().toISOString();
        return 'refreshed';
      },
    );
  }
  async status(extraReservations = 0) {
    const policy = await this.policy();
    const jobs = await this.store.listJobs();
    const active = jobs.filter(
      (j) => j.status === 'queued' || j.status === 'running',
    );
    const paths = [
      ...new Set([this.store.root, ...(this.config.storageVolumePaths ?? [])]),
    ];
    const volumes = await Promise.all(
      paths.map(async (path) => {
        try {
          const value = await this.disk(path);
          return {
            path,
            totalBytes: Number(value.blocks) * Number(value.bsize),
            availableBytes: Number(value.bavail) * Number(value.bsize),
            known: true,
          };
        } catch {
          return { path, totalBytes: null, availableBytes: null, known: false };
        }
      }),
    );
    const inventory = await this.docs.read<ObjectInventory>(
      'object-inventory',
      { observedAt: '', objects: [] },
    );
    const fresh = Date.parse(inventory.observedAt) > Date.now() - 5 * 60_000;
    const objectBytes = fresh
      ? inventory.objects.reduce((sum, o) => sum + o.bytes, 0)
      : null;
    const held = (active.length + extraReservations) * policy.taskBytes;
    const previous = await this.docs.read<{ blocked: boolean }>(
      'storage-state',
      { blocked: false },
    );
    const threshold = previous.blocked
      ? policy.resumeBytes
      : policy.reserveBytes;
    const volumeBlocked = volumes.some(
      (v) => v.availableBytes === null || v.availableBytes - held < threshold,
    );
    const cos = this.config.cosBucket
      ? {
          usedBytes: objectBytes,
          capacityBytes: policy.cosCapacityBytes,
          monthlyBudgetUsd: policy.cosMonthlyBudgetUsd,
          projectedMonthlyUsd:
            objectBytes !== null && policy.cosUsdPerGiBMonth !== null
              ? (objectBytes / GiB) * policy.cosUsdPerGiBMonth
              : null,
          observedAt: inventory.observedAt || null,
          fresh,
        }
      : null;
    const cosBlocked =
      !!cos &&
      ((policy.cosCapacityBytes !== null &&
        (objectBytes === null ||
          objectBytes + held > policy.cosCapacityBytes)) ||
        (policy.cosMonthlyBudgetUsd !== null &&
          (objectBytes === null ||
            policy.cosUsdPerGiBMonth === null ||
            ((objectBytes + held) / GiB) * policy.cosUsdPerGiBMonth >
              policy.cosMonthlyBudgetUsd)));
    const blocked = volumeBlocked || cosBlocked;
    const low =
      blocked ||
      volumes.some(
        (v) =>
          v.availableBytes !== null &&
          v.availableBytes - held < policy.warningBytes,
      ) ||
      (!!cos &&
        policy.cosCapacityBytes !== null &&
        objectBytes !== null &&
        objectBytes + held > policy.cosCapacityBytes * 0.85);
    return {
      state: blocked ? 'blocked' : low ? 'warning' : 'healthy',
      volumes,
      cos,
      policy,
      activeTasks: active.length,
      reservedBytes: held,
      observedAt: new Date().toISOString(),
      inventoryFresh: fresh,
    };
  }
  async admit<T>(job: AnalysisJob, operation: () => Promise<T>): Promise<T> {
    const result = await this.docs.change<
      { blocked: boolean },
      { allowed: false } | { allowed: true; value: T }
    >('storage-state', { blocked: false }, async (state) => {
      const capacity = await this.status(1);
      state.blocked = capacity.state === 'blocked';
      if (state.blocked) return { allowed: false };
      return { allowed: true, value: await operation() };
    });
    if (!result.allowed) throw adminError(503, 'site_storage_low');
    return result.value;
  }
  async candidates() {
    const status = await this.status();
    if (status.state === 'healthy')
      return { status, candidates: [], scan: 'not_needed' };
    const inventory = await this.docs.read<ObjectInventory>(
      'object-inventory',
      { observedAt: '', objects: [] },
    );
    const rows = await this.store.listPurgeablePublicSnapshots(
      new Date().toISOString(),
    );
    const candidates = rows.map((row) => ({
      ...row,
      location: this.config.cosBucket ? 'cos' : 'host',
      references: 0,
      reclaimableBytes: status.inventoryFresh
        ? [
            ...new Map(
              inventory.objects
                .filter((o) =>
                  o.key.startsWith(
                    `public-repository-snapshots/${row.public_snapshot_key}/`,
                  ),
                )
                .map((o) => [o.key, o.bytes]),
            ).values(),
          ].reduce((a, b) => a + b, 0)
        : null,
      hostBytesFreed: this.config.cosBucket ? 0 : null,
        impact:
          '永久删除此旧快照的分析与源码载荷（含 COS 保留版本）；没有当前项目或仓库头引用。数据库文件不承诺立即缩小。',
    }));
    return { status, candidates, scan: 'completed' };
  }
  async remove(publicKey: string) {
    if (!/^[a-f0-9]{64}$/i.test(publicKey))
      throw adminError(400, 'admin_invalid_snapshot');
    const { candidates } = await this.candidates();
    if (!candidates.some((c) => c.public_snapshot_key === publicKey))
      throw adminError(409, 'admin_snapshot_protected');
    if (
      (await this.store.listJobs()).some(
        (j) => j.status === 'queued' || j.status === 'running',
      )
    )
      throw adminError(409, 'admin_snapshot_busy');
    if (
      !(await this.store.purgePublicSnapshotPayload(
        publicKey,
        new Date().toISOString(),
      ))
    )
      throw adminError(409, 'admin_snapshot_protected');
    await this.docs.change<ObjectInventory, void>(
      'object-inventory',
      { observedAt: '', objects: [] },
      (row) => {
        row.observedAt = '';
      },
    );
    return { deleted: true };
  }
}

/** Collect actual COS inventory independently of an open administrator browser. */
export function collectStorageInventory(store: ProductStore, config: ServerConfig) {
  if (!config.cosBucket || !adminDocuments(store).pool) return async () => undefined;
  const storage = new StorageManager(store, config);
  let pending: Promise<unknown> | undefined;
  const sample = () => {
    if (pending) return;
    pending = storage.refreshInventoryIfDue()
      .catch(() => undefined) // Keep the old timestamp: failed/stale collection never becomes a healthy zero.
      .finally(() => { pending = undefined; });
  };
  sample();
  const timer = setInterval(sample, 2 * 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
