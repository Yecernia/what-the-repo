import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readCheckpointRecords, writeCheckpointRecords } from './checkpoint-records.js';
import { FileStore } from './file-store.js';

test('framed checkpoints restore graph arrays, nested caches and shared array references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-records-'));
  try {
    const rows = Array.from({ length: 600 }, (_, index) => ({ index, text: 'code'.repeat(2200), missing: undefined, bytes: Buffer.from([index % 256]) }));
    const value = { snapshot: { nodes: rows, alias: rows, edges: [{ evidence: rows }] },
      checkpoint: { parsed: rows, nested: { syntax: rows.slice() } },
      special: JSON.parse('{"__proto__":{"owned":true}}'), when: new Date('2026-01-01') };
    const file = join(root, 'payload.bin'), descriptor = await writeCheckpointRecords(file, value);
    const decoded = await readCheckpointRecords(file, descriptor) as typeof value;
    assert.deepEqual(decoded, value);
    assert.equal(decoded.snapshot.nodes, decoded.snapshot.alias);
    assert.equal(decoded.snapshot.nodes, decoded.checkpoint.parsed);
    assert.equal(Object.hasOwn(decoded.special, '__proto__'), true);
    assert.equal(({} as { owned?: boolean }).owned, undefined);
    await assert.rejects(writeCheckpointRecords(file, {}), { code: 'EEXIST' });
    assert.deepEqual(await readCheckpointRecords(file, descriptor), value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corruption, truncation, extra records and missing files never expose partial checkpoint data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-corruption-'));
  try {
    const file = join(root, 'payload.bin');
    const descriptor = await writeCheckpointRecords(file, { nodes: Array.from({ length: 500 }, (_, id) => ({ id })) });
    const original = await readFile(file);
    for (const body of [original.subarray(0, -1), Buffer.concat([original, Buffer.from([1])]), Buffer.from(original).fill(0, 0, 7)]) {
      await writeFile(file, body);
      await assert.rejects(readCheckpointRecords(file, descriptor), /analysis_checkpoint_integrity_mismatch/);
      const declared = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
      await assert.rejects(readCheckpointRecords(file, declared), /analysis_checkpoint_payload_invalid/);
    }
    await rm(file);
    await assert.rejects(readCheckpointRecords(file, descriptor), /analysis_checkpoint_payload_missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('semantic resume omits framed static data and retains it across the next checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-stages-'));
  const store = new FileStore(root);
  try {
    await store.init();
    const parsed = Array.from({ length: 400 }, (_, id) => ({ path: `src/${id}.ts`, symbols: [id] }));
    const snapshot = { fact_graph: { nodes: parsed, edges: [] } };
    await store.saveAnalysisCheckpoint('project', { stage: 'semantic', parsed }, snapshot);
    const first = JSON.parse(await readFile(join(root, 'analysis-checkpoints/project.json'), 'utf8'));
    assert.equal(first.encoding, 'v8-records');
    const light = await store.loadAnalysisCheckpoint('project', { omitStatic: true });
    assert.equal(light!.checkpoint.parsed, undefined);
    assert.deepEqual(light!.snapshot, snapshot);
    await store.saveAnalysisCheckpoint('project', { ...light!.checkpoint, stage: 'assembly' }, light!.snapshot);
    const second = JSON.parse(await readFile(join(root, 'analysis-checkpoints/project.json'), 'utf8'));
    assert.equal(second.static_payload.file, first.static_payload.file);
    assert.deepEqual((await store.loadAnalysisCheckpoint('project'))!.checkpoint.parsed, parsed);
    await store.clearAnalysisCheckpoint('project');
    assert.equal(await store.loadAnalysisCheckpoint('project'), null);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('root projection hydrates shared aliases even when their first path is excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-project-'));
  try {
    const shared = Array.from({ length: 200 }, (_, id) => ({ id, value: 'shared' }));
    const hidden = Array.from({ length: 200 }, (_, id) => ({ id, value: 'hidden'.repeat(800) }));
    const value = { excluded: { shared, hidden }, retained: { first: shared, second: shared },
      special: JSON.parse('{"__proto__":{"own":true}}') };
    const path = join(root, 'project.bin');
    const descriptor = await writeCheckpointRecords(path, value);
    const result = await readCheckpointRecords(path, descriptor, { includeRootFields: ['retained', 'special'] }) as Partial<typeof value>;
    assert.deepEqual(result, { retained: value.retained, special: value.special });
    assert.strictEqual(result.retained!.first, result.retained!.second);
    assert.equal(Object.hasOwn(result.special!, '__proto__'), true);
    assert.deepEqual(await readCheckpointRecords(path, descriptor, { includeRootFields: [] }), {});
    assert.deepEqual(await readCheckpointRecords(path, descriptor), value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('excluded records remain checksum protected and cancellation is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-project-integrity-'));
  try {
    const path = join(root, 'payload.bin');
    const value = { metadata: { stage: 'assembly' }, hidden: Array.from({ length: 200 }, (_, id) => ({ id, text: 'x'.repeat(9000) })) };
    const descriptor = await writeCheckpointRecords(path, value);
    const original = await readFile(path);
    const modified = Buffer.from(original); modified[modified.length - 7]! ^= 1;
    await writeFile(path, modified);
    await assert.rejects(readCheckpointRecords(path, descriptor, { includeRootFields: ['metadata'] }), /integrity_mismatch/);
    await writeFile(path, original);
    const controller = new AbortController();
    const reason = new Error('test-cancel-checkpoint');
    controller.abort(reason);
    await assert.rejects(readCheckpointRecords(path, descriptor, { signal: controller.signal }), error => error === reason);
    const during = new AbortController();
    const pending = readCheckpointRecords(path, descriptor, { includeRootFields: ['metadata'], signal: during.signal });
    setImmediate(() => during.abort(reason));
    await assert.rejects(pending, error => error === reason || (error as Error).name === 'AbortError');
    assert.deepEqual(await readCheckpointRecords(path, descriptor, { includeRootFields: ['metadata'] }), { metadata: value.metadata });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('projection rejects empty skipped frames and duplicate array destinations', async () => {
  const { serialize } = await import('node:v8');
  const { projectCheckpointHeader } = await import('./checkpoint-projection.js');
  const shared: unknown[] = [];
  assert.throws(() => projectCheckpointHeader({ a: shared, b: shared }, [
    { path: ['a'], length: 1 }, { path: ['b'], length: 1 },
  ], 4096, []), /payload_invalid/);
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-empty-frame-'));
  try {
    const path = join(root, 'payload.bin');
    const header = serialize({ root: { hidden: [] }, arrays: [{ path: ['hidden'], length: 1 }] });
    const size = Buffer.alloc(4); size.writeUInt32LE(header.length);
    const body = Buffer.concat([Buffer.from('WTRCP2\n'), size, header, Buffer.alloc(4)]);
    await writeFile(path, body);
    const descriptor = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    await assert.rejects(readCheckpointRecords(path, descriptor, { includeRootFields: [] }), /payload_invalid/);
    await assert.rejects(readCheckpointRecords(path, descriptor), /payload_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
