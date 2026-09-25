import { statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ProductStore } from '../persistence/store.js';
import type { AnalysisJob } from '../domain/jobs.js';
import type { ServerConfig } from '../config.js';
import { createSnapshotObjectStore } from '../persistence/factory.js';
import { adminDocuments } from './runtime-config.js';
import type { AdminDocuments } from './documents.js';
import type { Pool } from 'pg';
import { adminError } from './security.js';
import { PostgresStore } from '../persistence/postgres-store.js';

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
  totalBytes: number;
  snapshotBytes: Record<string,number>;
}
export const EMPTY_OBJECT_INVENTORY: ObjectInventory={observedAt:'',totalBytes:0,snapshotBytes:{}};
export async function readObjectInventory(docs:AdminDocuments,pool:Pool|undefined=docs.pool):Promise<ObjectInventory> {
  if(!pool) return docs.read('object-inventory',EMPTY_OBJECT_INVENTORY);
  // Project only the compact fields. An old per-object document can be very large
  // until the background collector replaces it.
  const result=await pool.query(`SELECT jsonb_build_object(
    'observedAt',value->'observedAt','totalBytes',value->'totalBytes',
    'snapshotBytes',value->'snapshotBytes') AS value
    FROM admin_documents WHERE key='object-inventory'`);
  return result.rows[0]?.value??structuredClone(EMPTY_OBJECT_INVENTORY);
}
function summarizeObjects(objects:Array<{key:string;bytes:number}>):ObjectInventory {
  const snapshotBytes:Record<string,number>={};
  let totalBytes=0;
  for(const object of objects) {
    totalBytes+=object.bytes;
    const key=/^public-repository-snapshots\/([a-f0-9]{64})\//.exec(object.key)?.[1];
    if(key) snapshotBytes[key]=(snapshotBytes[key]??0)+object.bytes;
  }
  return {observedAt:new Date().toISOString(),totalBytes,snapshotBytes};
}
function publishInventory(target:ObjectInventory,summary:ObjectInventory) {
  // Existing deployments may still have the old per-object JSON document.
  delete (target as ObjectInventory & {objects?:unknown}).objects;
  Object.assign(target,summary);
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
  async refreshInventoryIfDue(now = Date.now(), force = false) {
    const fallback = EMPTY_OBJECT_INVENTORY;
    const current=await readObjectInventory(this.docs,this.store instanceof PostgresStore?this.store.pool:undefined);
    if (!force && Number.isFinite(current.totalBytes) && current.snapshotBytes &&
      Date.parse(current.observedAt)>now-2*60_000)
      return 'fresh';
    const owner=randomUUID(), leaseKey='object-inventory-lease';
    const acquired=await this.docs.change(leaseKey,{owner:'',until:0},state=>{
      if(state.until>now) return false;
      state.owner=owner;state.until=now+30*60_000;
      return true;
    });
    if(!acquired) return 'in_progress';
    try {
      const objects=await this.objects(this.config).inventory?.();
      if(!objects) throw adminError(503,'storage_inventory_unavailable');
      const summary=summarizeObjects(objects);
      if(this.store instanceof PostgresStore)
        await this.store.pool.query(`INSERT INTO admin_documents(key,value)
          VALUES('object-inventory',$1::jsonb)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()
          WHERE COALESCE(admin_documents.value->>'observedAt','')<=$2`,
          [JSON.stringify(summary),new Date(now).toISOString()]);
      else await this.docs.change<ObjectInventory,void>('object-inventory',fallback,value=>{
        // A manual refresh may have published a newer result while this scan ran.
        if(Date.parse(value.observedAt)>now) return;
        publishInventory(value,summary);
      });
      return 'refreshed';
    } finally {
      await this.docs.change(leaseKey,{owner:'',until:0},state=>{
        if(state.owner===owner) state.until=0;
      });
    }
  }
  async status(extraReservations = 0) {
    const policy = await this.policy();
    const activeTasks = this.store instanceof PostgresStore
      ? await this.docs.pool!.query("SELECT count(*)::int AS n FROM analysis_jobs WHERE status IN ('queued','running')").then(r=>Number(r.rows[0].n))
      : (await this.store.listJobs()).filter(j=>j.status==='queued'||j.status==='running').length;
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
    const inventory = await readObjectInventory(this.docs);
    const fresh = Number.isFinite(inventory.totalBytes) && !!inventory.snapshotBytes &&
      Date.parse(inventory.observedAt) > Date.now() - 5 * 60_000;
    const objectBytes = fresh ? inventory.totalBytes : null;
    const held = (activeTasks + extraReservations) * policy.taskBytes;
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
      activeTasks,
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
    const inventory = await readObjectInventory(this.docs);
    const rows = await this.store.listPurgeablePublicSnapshots(
      new Date().toISOString(),
    );
    const candidates = rows.map((row) => ({
      ...row,
      location: this.config.cosBucket ? 'cos' : 'host',
      references: 0,
      reclaimableBytes: status.inventoryFresh
        ? inventory.snapshotBytes[row.public_snapshot_key]??0 : null,
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
    if (this.store instanceof PostgresStore
      ? (await this.docs.pool!.query("SELECT 1 FROM analysis_jobs WHERE status IN ('queued','running') LIMIT 1")).rowCount
      : (await this.store.listJobs()).some(j=>j.status==='queued'||j.status==='running'))
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
      EMPTY_OBJECT_INVENTORY,
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
  let lastErrorLog=0;
  const sample = () => {
    if (pending) return;
    pending = storage.refreshInventoryIfDue()
      .catch(error => {
        // Keep the old timestamp: a failed scan must never become a healthy zero.
        if(Date.now()-lastErrorLog>60_000) {
          console.error('admin_storage_inventory_failed',error instanceof Error?error.name:'unknown');
          lastErrorLog=Date.now();
        }
      })
      .finally(() => { pending = undefined; });
  };
  sample();
  const timer = setInterval(sample, 2 * 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
