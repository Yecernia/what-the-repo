import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalSnapshotObjectStore, TencentCosObjectStore, putSourceSnapshot, parseSourceSnapshotManifest,
  readSourceSnapshotFile, sourceSnapshotManifestBytes, snapshotObjectDigest, jsonBytes,
  type SnapshotObjectStore } from './snapshot-object-store.js';
import { SOURCE_PACK_BYTES, SOURCE_PACK_FILES } from './source-packs.js';
import { boundedObjectStore } from './bounded-object-store.js';
import { ResourceScheduler } from '../scheduling/resources.js';
import { LocalPermitStore } from '../scheduling/permits.js';

const identity = { publicKey: 'a'.repeat(64), snapshotId: 'pack-test' };
async function fixture(operation: (root: string, store: LocalSnapshotObjectStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-source-pack-'));
  const objects = await mkdtemp(join(tmpdir(), 'wtr-source-objects-'));
  try { await operation(root, new LocalSnapshotObjectStore(objects)); }
  finally {
    for (const path of [root, objects]) { assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep)); await rm(path, { recursive: true, force: true }); }
  }
}

test('thousands of files upload as bounded packs; random access reads only the requested file frame', async () => {
  await fixture(async (root, store) => {
    const count = SOURCE_PACK_FILES * 2 + 1;
    const bodies = Array.from({ length: count }, (_, i) => Buffer.from(`file-${i}\n` + 'compressible source line\n'.repeat(20)));
    await Promise.all(bodies.map((body, i) => writeFile(join(root, `${String(i).padStart(5, '0')}.ts`), body)));
    const writes: string[] = [];
    const recording: SnapshotObjectStore = { kind: 'local', get: store.get.bind(store), delete: store.delete.bind(store),
      put: async (key, body) => { writes.push(key); return store.put(key, body); } };
    const saved = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: recording, createdAt: '2026-09-20T00:00:00Z' });
    assert.equal(writes.length, 4, 'three data requests and one manifest, instead of 2050 requests');
    const manifest = parseSourceSnapshotManifest(await store.get(saved.manifestObject.key), identity);
    assert.equal(manifest.packs?.length, 3);
    assert.ok(manifest.packs!.every(pack => pack.bytes <= SOURCE_PACK_BYTES));
    assert.deepEqual(Buffer.from(sourceSnapshotManifestBytes(manifest)), Buffer.from(await store.get(saved.manifestObject.key) ?? []));
    let transferred = 0;
    const ranged: SnapshotObjectStore = { ...recording, get: async () => { throw new Error('whole pack read'); },
      getRange: async (key, offset, length) => { transferred += length; return store.getRange(key, offset, length); } };
    for (const index of [0, 17, 1023, 1024, 2048]) assert.deepEqual(Buffer.from(await readSourceSnapshotFile(ranged, manifest.files[index])), bodies[index]);
    assert.ok(transferred < 500, `read amplification: ${transferred}`);
    const raw = JSON.parse(Buffer.from(await store.get(saved.manifestObject.key) ?? []).toString());
    assert.equal('key' in raw.files[0], false, 'wire manifest references compact pack ordinals');
    const again = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: store, createdAt: '2026-09-20T00:00:00Z' });
    assert.equal(again.manifestObject.key, saved.manifestObject.key, 'retry creates identical immutable keys');
  });
});

test('pack byte limits, incompressible bytes, empty files and identical pack contents round-trip', async () => {
  await fixture(async (root, store) => {
    const bodies = [randomBytes(SOURCE_PACK_BYTES / 2 + 1), randomBytes(SOURCE_PACK_BYTES / 2 + 1), Buffer.alloc(0)];
    await Promise.all(bodies.map((body, i) => writeFile(join(root, `${i}.bin`), body)));
    const saved = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: store });
    assert.equal(saved.manifest.packs?.length, 2);
    for (const [i, file] of saved.manifest.files.entries()) {
      assert.equal(file.encoding, 'identity');
      assert.deepEqual(Buffer.from(await readSourceSnapshotFile(store, file)), bodies[i]);
    }
    const empty = saved.manifest.files[2];
    assert.equal((await readSourceSnapshotFile({ ...store, kind: 'local', put: store.put.bind(store), delete: store.delete.bind(store), get: async () => { throw Error('empty file download'); } }, empty)).byteLength, 0);
  });
  await fixture(async (root, store) => {
    await Promise.all(Array.from({ length: SOURCE_PACK_FILES + 1 }, (_, i) => writeFile(join(root, `${i}.txt`), '')));
    const saved = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: store });
    assert.equal(saved.manifest.packs?.length, 2);
    assert.equal(new Set(saved.manifest.packs?.map(pack => pack.key)).size, 2);
    parseSourceSnapshotManifest(await store.get(saved.manifestObject.key), identity);
  });
});

test('empty repositories publish an empty index and legacy per-file snapshots remain readable', async () => {
  await fixture(async (root, store) => {
    const saved = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: store });
    assert.deepEqual(parseSourceSnapshotManifest(await store.get(saved.manifestObject.key), identity).files, []);
    const object = await store.put('legacy/source', Buffer.from('old source'));
    const legacy = { schema_version: 1, public_snapshot_key: identity.publicKey, snapshot_id: identity.snapshotId,
      files: [{ ...object, path: 'old.ts' }], total_bytes: object.bytes, created_at: new Date().toISOString() };
    const manifest = parseSourceSnapshotManifest(jsonBytes(legacy), identity);
    assert.equal(Buffer.from(await readSourceSnapshotFile(store, manifest.files[0])).toString(), 'old source');
  });
});

test('corrupt ranges, overlapping offsets, foreign packs and decompression expansion fail closed', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'a.ts'), 'abcdef'.repeat(1000));
    await writeFile(join(root, 'b.ts'), 'different'.repeat(500));
    const saved = await putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: store });
    const wire = JSON.parse(Buffer.from(sourceSnapshotManifestBytes(saved.manifest)).toString());
    for (const mutate of [
      (v: typeof wire) => { v.files[1].offset = 0; },
      (v: typeof wire) => { v.files[0].stored_bytes = SOURCE_PACK_BYTES + 1; },
      (v: typeof wire) => { v.files[0].encoding = 'unknown'; },
      (v: typeof wire) => { v.files[0].pack = -1; },
      (v: typeof wire) => { v.files[0].path = '../escape'; },
      (v: typeof wire) => { v.packs[0].key = 'another/snapshot'; },
      (v: typeof wire) => { v.packs[0].bytes++; },
    ]) {
      const damaged = structuredClone(wire); mutate(damaged);
      assert.throws(() => parseSourceSnapshotManifest(jsonBytes(damaged), identity), /invalid/);
    }
    const file = saved.manifest.files[0];
    await assert.rejects(readSourceSnapshotFile(store, { ...file, bytes: 1 }), /integrity_mismatch/);
    const body = Buffer.from(await store.get(file.key) ?? []); body[file.offset! + 15] ^= 255;
    await store.put(file.key, body);
    await assert.rejects(readSourceSnapshotFile(store, file), /integrity_mismatch/);
    await store.delete(file.key);
    await assert.rejects(readSourceSnapshotFile(store, file), /object_missing/);
  });
});

test('range reads share the aggregate storage permit and reject truncated local files', async () => {
  await fixture(async (_root, store) => {
    await store.put('bytes', Buffer.from('abcdef'));
    await assert.rejects(store.getRange('bytes', 5, 2), /range_invalid/);
    let active = 0, peak = 0;
    const instrumented: SnapshotObjectStore = { kind: 'local', get: store.get.bind(store), put: store.put.bind(store), delete: store.delete.bind(store),
      getRange: async (...args) => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); try { return await store.getRange(...args); } finally { active--; } } };
    const bounded = boundedObjectStore(instrumented, new ResourceScheduler(new LocalPermitStore()), 1);
    await Promise.all(Array.from({ length: 4 }, () => bounded.getRange!('bytes', 1, 2)));
    assert.equal(peak, 1); assert.equal(active, 0);
  });
});

test('COS ranges validate 206, Content-Range and length without accepting whole-object responses', async () => {
  const store = new TencentCosObjectStore({ bucket: 'test', region: 'test', secretId: 'test', secretKey: 'test', prefix: 'prefix' });
  let response = { statusCode: 206, headers: { 'content-range': 'bytes 2-4/10' }, Body: Buffer.from('cde') };
  (store as unknown as { client: unknown }).client = { async getObject(input: { Range: string; Key: string }) {
    assert.equal(input.Range, 'bytes=2-4'); assert.equal(input.Key, 'prefix/test'); return response;
  } };
  assert.equal(Buffer.from(await store.getRange('test', 2, 3) ?? []).toString(), 'cde');
  for (const bad of [{ ...response, statusCode: 200 }, { ...response, Body: Buffer.from('cd') },
    { ...response, headers: { 'content-range': 'bytes 1-3/10' } }]) {
    response = bad; await assert.rejects(store.getRange('test', 2, 3), /range_invalid/);
  }
});

test('failed packs never publish a manifest and oversized files fail before upload', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'file.ts'), 'source');
    const writes: string[] = [];
    const failing: SnapshotObjectStore = { kind: 'local', get: store.get.bind(store), delete: store.delete.bind(store),
      put: async key => { writes.push(key); throw Error('upload unavailable'); } };
    await assert.rejects(putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: failing }), /upload unavailable/);
    assert.equal(writes.some(key => key.includes('source-manifest')), false);
    await writeFile(join(root, 'large'), Buffer.alloc(SOURCE_PACK_BYTES + 1));
    writes.length = 0;
    await assert.rejects(putSourceSnapshot({ ...identity, sourceRoot: root, objectStore: failing }), /file_too_large/);
    assert.equal(writes.length, 0);
  });
});

test('cancellation during the final manifest upload cannot return a publishable checkpoint', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'file.ts'), 'source');
    const controller = new AbortController();
    const canceling: SnapshotObjectStore = { kind: 'local', get: store.get.bind(store), delete: store.delete.bind(store),
      put: async (key, body) => {
        const stored = await store.put(key, body);
        if (key.includes('/source-manifest-')) controller.abort(new Error('publication canceled'));
        return stored;
      } };
    await assert.rejects(putSourceSnapshot({ ...identity, sourceRoot: root,
      objectStore: canceling, signal: controller.signal }), /publication canceled/);
  });
});
