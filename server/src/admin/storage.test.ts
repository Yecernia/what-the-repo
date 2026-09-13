import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../persistence/file-store.js';
import { loadConfig } from '../config.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { StorageManager, DEFAULT_STORAGE_POLICY } from './storage.js';
const GiB = 1024 ** 3;

test('inventory refresh skips fresh samples and preserves the old timestamp after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-inventory-'));
  const store = new FileStore(root);
  await store.init();
  let calls = 0, fail = false;
  const manager = new StorageManager(store, { ...loadConfig({}), dataDir: root }, undefined, () => ({
    kind: 'local',
    get: async () => null, put: async () => { throw new Error('Unexpected object write'); }, delete: async () => undefined,
    inventory: async () => { calls++; if (fail) throw new Error('AccessDenied'); return [{key:'snapshot.json', bytes:123}]; },
  }));
  try {
    assert.equal(await manager.refreshInventoryIfDue(), 'refreshed');
    const original = await manager.docs.read('object-inventory', {observedAt:'',objects:[]});
    assert.equal(await manager.refreshInventoryIfDue(), 'fresh');
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(() => manager.refreshInventoryIfDue(Date.now() + 300_000));
    assert.deepEqual(await manager.docs.read('object-inventory', {}), original);
    fail = false;
    assert.equal(await manager.refreshInventoryIfDue(Date.now() + 300_000), 'refreshed');
    assert.equal(calls, 3);
  } finally { await store.close(); await rm(root, {recursive:true,force:true}); }
});

test('capacity admission reserves running work, persists recovery threshold, and does not scan healthy storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-admin-storage-'));
  const store = new FileStore(root);
  await store.init();
  let free = 20 * GiB,
    scans = 0;
  const disk = (async () => ({
    blocks: 100 * GiB,
    bavail: free,
    bsize: 1,
  })) as unknown as typeof import('node:fs/promises').statfs;
  const manager = new StorageManager(
    store,
    { ...loadConfig({}), dataDir: root },
    disk,
  );
  store.listPurgeablePublicSnapshots = async () => {
    scans++;
    return [];
  };
  try {
    assert.equal((await manager.candidates()).scan, 'not_needed');
    assert.equal(scans, 0);
    const job = newAnalysisJob('isolated', 'test');
    free = 2.5 * GiB;
    let dispatched = false;
    await assert.rejects(
      () =>
        manager.admit(job, async () => {
          dispatched = true;
        }),
      { code: 'site_storage_low' },
    );
    assert.equal(dispatched, false);
    assert.equal(
      (await manager.docs.read('storage-state', { blocked: false })).blocked,
      true,
    );
    free = 4 * GiB;
    await assert.rejects(() => manager.admit(job, async () => undefined), {
      code: 'site_storage_low',
    });
    free = 7 * GiB;
    await manager.admit(job, async () => {
      await store.saveJob(job);
    });
    assert.equal((await manager.status()).reservedBytes, GiB);
    free = 2.5 * GiB;
    assert.equal((await manager.status()).state, 'blocked');
    await manager.candidates();
    assert.equal(scans, 1);
    assert.equal(
      await store.checkHealth(),
      undefined,
      'Read and health access remains available',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('COS uses actual object bytes, unknown inventory is not zero, and deletion rechecks live references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-admin-cos-'));
  const store = new FileStore(root);
  await store.init();
  const disk = (async () => ({
    blocks: 100 * GiB,
    bavail: 20 * GiB,
    bsize: 1,
  })) as unknown as typeof import('node:fs/promises').statfs;
  const manager = new StorageManager(
    store,
    { ...loadConfig({}), dataDir: root, cosBucket: 'isolated' },
    disk,
  );
  const key = 'a'.repeat(64);
  let deleted = 0;
  try {
    await manager.updatePolicy(
      { ...DEFAULT_STORAGE_POLICY, cosCapacityBytes: GiB },
      'test',
    );
    assert.equal((await manager.status()).cos?.usedBytes, null);
    assert.equal((await manager.status()).state, 'blocked');
    await manager.docs.change(
      'object-inventory',
      { observedAt: '', objects: [] as Array<{ key: string; bytes: number }> },
      (row) => {
        row.observedAt = new Date().toISOString();
        row.objects = [
          { key: `public-repository-snapshots/${key}/one`, bytes: GiB },
        ];
      },
    );
    store.listPurgeablePublicSnapshots = async () => [
      { public_snapshot_key: key } as never,
    ];
    store.purgePublicSnapshotPayload = async () => {
      deleted++;
      return false;
    };
    const candidates = await manager.candidates();
    assert.equal(candidates.candidates[0]?.reclaimableBytes, GiB);
    assert.equal(candidates.candidates[0]?.hostBytesFreed, 0);
    await assert.rejects(() => manager.remove(key), {
      code: 'admin_snapshot_protected',
    });
    assert.equal(deleted, 1, 'Final store check may veto changed references');
    await store.saveJob(newAnalysisJob('isolated', 'running'));
    await assert.rejects(() => manager.remove(key), {
      code: 'admin_snapshot_busy',
    });
    assert.equal(deleted, 1, 'Running jobs prevent even attempting a delete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
