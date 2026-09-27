import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { DIRECTORY_SECTIONS, parseDirectoryManifest, readDirectoryRows, writeDirectoryObjects,
  type DirectoryChunk, type DirectoryObjectManifest } from './directory-objects.js';
import { snapshotObjectDigest, type SnapshotObjectStore } from './snapshot-object-store.js';
import { streamSnapshotQueryDirectory } from '../domain/snapshot-query.js';

const publicKey = 'a'.repeat(64);
const manifest = (): DirectoryObjectManifest => ({ version: 1,
  sections: Object.fromEntries(DIRECTORY_SECTIONS.map(section => [section, [] as DirectoryChunk[]])) as DirectoryObjectManifest['sections'] });
function chunk(section: string, start: number, rows: unknown[]) {
  const body = gzipSync(JSON.stringify(rows));
  const sha256 = snapshotObjectDigest(body);
  return { descriptor: { key: `public-repository-snapshots/${publicKey}/directory/123/${section}/${start}-${sha256}.json.gz`,
    sha256, bytes: body.byteLength, start, count: rows.length }, body };
}
function objects() {
  const values = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const store: SnapshotObjectStore = {
    kind: 'local',
    async put(key, body) { values.set(key, body); return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) }; },
    async get(key) { reads.push(key); return values.get(key) ?? null; },
    async delete(key) { values.delete(key); },
  };
  return { values, reads, store };
}

test('directory manifest validates canonical keys, section, ordinal, digest and generation identity', () => {
  const input = manifest();
  input.sections.nodes.push(chunk('nodes', 0, [{}]).descriptor);
  input.sections.edges.push(chunk('edges', 0, [{}]).descriptor);
  assert.equal(parseDirectoryManifest(input, { publicKey, directoryId: '123' }), input);
  const mutations: Array<(value: DirectoryObjectManifest) => void> = [
    value => { value.sections.edges[0].key = value.sections.edges[0].key.replace('/directory/123/', '/directory/124/'); },
    value => { value.sections.edges[0].key = value.sections.edges[0].key.replace(publicKey, 'b'.repeat(64)); },
    value => { value.sections.edges[0].key = value.sections.edges[0].key.replace('/edges/', '/nodes/'); },
    value => { value.sections.edges[0].key = value.sections.edges[0].key.replace('/0-', '/1-'); },
    value => { value.sections.edges[0].sha256 = 'f'.repeat(64); },
    value => { value.sections.edges[0].key = '../' + value.sections.edges[0].key; },
    value => { value.sections.edges[0].count = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(input); mutate(changed);
    assert.throws(() => parseDirectoryManifest(changed), /manifest_invalid/);
  }
  assert.throws(() => parseDirectoryManifest(input, { publicKey, directoryId: '124' }), /manifest_invalid/);
  const overflow = manifest();
  const first = chunk('nodes', 0, [{}]).descriptor;
  first.count = Number.MAX_SAFE_INTEGER;
  overflow.sections.nodes.push(first, chunk('nodes', Number.MAX_SAFE_INTEGER, [{}]).descriptor);
  assert.throws(() => parseDirectoryManifest(overflow), /manifest_invalid/);
});

test('directory reads preserve all-row order and selected duplicates while fetching each chunk once', async () => {
  const f = objects(), input = manifest();
  for (let start = 0; start < 6; start += 2) {
    const value = chunk('nodes', start, [{ node_key: String(start) }, { node_key: String(start + 1) }]);
    input.sections.nodes.push(value.descriptor); f.values.set(value.descriptor.key, value.body);
  }
  assert.deepEqual((await readDirectoryRows(f.store, input, 'nodes')).map(row => row.node_key), ['0', '1', '2', '3', '4', '5']);
  f.reads.length = 0;
  assert.deepEqual((await readDirectoryRows(f.store, input, 'nodes', [5, 0, 5])).map(row => row.node_key), ['5', '0', '5']);
  assert.equal(f.reads.length, 2);
  await assert.rejects(readDirectoryRows(f.store, input, 'nodes', [6]), /locator_invalid/);
  f.values.set(input.sections.nodes[0].key, gzipSync('[{"node_key":"corrupt"}]'));
  await assert.rejects(readDirectoryRows(f.store, input, 'nodes', [0]), /object_corrupt/);
});

test('upload intent is checkpointed before storage and checkpoint failure prevents the upload', async () => {
  const f = objects();
  const directory = streamSnapshotQueryDirectory(publicKey, 'snapshot', {
    graph: { nodes: Array.from({length:1200},(_,i)=>({ id: 'n'+i, name: 'n'+i, members: [], evidence: [], certainty: 'verified' })), edges: [], layers: [] },
    value_points: [],
  }, { fact_graph: { nodes: [], edges: [] } });
  const intents=new Set<string>();let finalWrites=0;
  const put = f.store.put.bind(f.store);
  f.store.put = async (key, body) => {
    assert.ok(intents.has(key));
    return put(key, body);
  };
  await writeDirectoryObjects(f.store, directory, '123', async (value,planned) => {
    if(planned)intents.add(planned.key);
    else{finalWrites++;assert.deepEqual(new Set(Object.values(value.sections).flat().map(chunk=>chunk.key)),intents);}
  });
  assert.ok(f.values.size > 1);assert.equal(finalWrites,1,'write the full manifest once, regardless of chunk count');
  f.values.clear();
  await assert.rejects(writeDirectoryObjects(f.store, directory, '123', async () => { throw new Error('checkpoint_failure'); }), /checkpoint_failure/);
  assert.equal(f.values.size, 0);
});

function uploadDirectory() {
  return streamSnapshotQueryDirectory(publicKey, 'snapshot', {
    graph: { nodes: Array.from({ length: 12 }, (_, i) => ({
      id: 'n' + i, name: 'n' + i, responsibility: 'x'.repeat(140 * 1024),
      members: [], evidence: [], certainty: 'verified',
    })), edges: [], layers: [] }, value_points: [],
  }, { fact_graph: { nodes: [], edges: [] } });
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('directory uploads overlap at most four PUTs and publish ordered descriptors only after all succeed', { timeout: 5000 }, async () => {
  const f = objects(), put = f.store.put.bind(f.store);
  const intents: string[] = [], releases: Array<() => void> = [];
  let active = 0, maximum = 0, releaseNew = false, finalWrites = 0;
  f.store.put = async (key, body) => {
    assert.ok(intents.includes(key), 'the durable intent must finish before PUT starts');
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => { releases.push(resolve); if (releaseNew) resolve(); });
    const stored = await put(key, body);
    active--;
    return stored;
  };
  const writing = writeDirectoryObjects(f.store, uploadDirectory(), '123', async (value, planned) => {
    if (planned) {
      await Promise.resolve();
      intents.push(planned.key);
    } else {
      finalWrites++;
      assert.equal(active, 0);
      assert.equal(f.values.size, intents.length);
      assert.deepEqual(Object.values(value.sections).flat().map(item => item.key), intents);
    }
  });
  await nextTurn();
  assert.equal(active, 4);
  assert.equal(releases.length, 4, 'backpressure must prevent a fifth PUT');
  assert.equal(finalWrites, 0);
  releases[3](); // Deliberately finish a later ordinal first.
  await nextTurn();
  assert.equal(releases.length, 5);
  assert.equal(active, 4);
  releaseNew = true;
  for (const release of releases) release();
  const result = await writing;
  assert.equal(maximum, 4);
  assert.equal(finalWrites, 1);
  assert.equal(result.sections.nodes.length, 12);
  assert.deepEqual(result.sections.nodes.map(item => item.start), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(parseDirectoryManifest(result, { publicKey, directoryId: '123' }), result);
  assert.deepEqual((await readDirectoryRows(f.store, result, 'nodes')).map(row => row.node_id), Array.from({ length: 12 }, (_, i) => 'n' + i));
});

for (const failure of ['put', 'checkpoint', 'invalid_response'] as const) {
  test(`directory ${failure} failure drains admitted PUTs and never publishes the final manifest`, { timeout: 5000 }, async () => {
    const f = objects(), put = f.store.put.bind(f.store);
    const releases: Array<() => void> = [];
    let admitted = 0, active = 0, intentCount = 0, finalWrites = 0, settled = false;
    f.store.put = async (key, body) => {
      const index = admitted++;
      active++;
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      if (index === 1 && failure === 'put') throw new Error('put_failure');
      const stored = await put(key, body);
      return index === 1 && failure === 'invalid_response' ? { ...stored, bytes: stored.bytes + 1 } : stored;
    };
    const writing = writeDirectoryObjects(f.store, uploadDirectory(), '123', async (_value, planned) => {
      if (!planned) { finalWrites++; return; }
      if (++intentCount === 4 && failure === 'checkpoint') throw new Error('checkpoint_failure');
    });
    void writing.then(() => { settled = true; }, () => { settled = true; });
    await nextTurn();
    const expectedAdmitted = failure === 'checkpoint' ? 3 : 4;
    assert.equal(admitted, expectedAdmitted);
    releases[1]();
    await nextTurn();
    assert.equal(settled, false, 'the failing write must still await other admitted PUTs');
    assert.equal(admitted, expectedAdmitted, 'failure must stop admitting uploads');
    assert.equal(finalWrites, 0);
    for (const release of releases) release();
    await assert.rejects(writing, failure === 'invalid_response' ? /object_write_invalid/ : new RegExp(failure + '_failure'));
    assert.equal(active, 0);
    assert.equal(finalWrites, 0);
    assert.equal(admitted, expectedAdmitted);
  });
}
