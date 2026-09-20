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
