import assert from 'node:assert/strict';
import test from 'node:test';
import { factChunkBodies, decodeFactChunk, FACT_CHUNK_FORMAT } from './fact-chunk-dictionary.js';
import { prepareStoredAnalysisPayload, assembleAnalysisPayload, visitAnalysisFactGraph, parseAnalysisPayloadEnvelope } from './analysis-payload.js';
import { snapshotObjectDigest } from './snapshot-object-store.js';

test('fact dictionary preserves arbitrary values, duplicate IDs, order and independent restored lists', () => {
  const ids = Array.from({ length: 32 }, (_, i) => 'stable:' + i + ':中文/"\\'.repeat(10));
  const rows = Array.from({ length: 4097 }, (_, i) => ({ id: String(i),
    incremental_provenance: { change_kind: i%2 ? 'reused' : 'deleted', affected_by_stable_ids: ids.slice(),
      cache_key: String(i%17), unusual: null }, evidence: [], first_seen_snapshot_id: 'previous' }));
  const extras: unknown[] = [null, 1, {incremental_provenance:{affected_by_stable_ids: 0}},
    {incremental_provenance:{affected_by_stable_ids: Array(33).fill('preserve-all')}}];
  const input = [...rows, ...extras]; const original = JSON.stringify(input);
  const chunks = [...factChunkBodies(input, 2048, 4*1024*1024)];
  const output = chunks.flatMap(chunk => decodeFactChunk(JSON.parse(Buffer.from(chunk.body).toString()),chunk.format,chunk.items.length));
  assert.deepEqual(output,input); assert.equal(JSON.stringify(input),original);
  assert.equal(JSON.stringify(output), original, 'key ordering and logical JSON stay identical');
  const restored=output as typeof rows;
  assert.notStrictEqual(restored[0]!.incremental_provenance.affected_by_stable_ids,restored[1]!.incremental_provenance.affected_by_stable_ids);
  assert.ok(chunks.reduce((n,c)=>n+c.body.byteLength,0)<Buffer.byteLength(original)/4);
  for (const chunk of chunks) assert.ok(chunk.body.byteLength<=4*1024*1024 || chunk.items.length===1);
});

test('dictionary capacity and byte boundaries fall back without losing distinct metadata', () => {
  const rows=Array.from({length:3000},(_,i)=>({id:String(i),incremental_provenance:{affected_by_stable_ids:[String(i),'x'.repeat(120)]}}));
  const chunks=[...factChunkBodies(rows,2048,8192)];
  assert.ok(chunks.length>10);
  assert.deepEqual(chunks.flatMap(c=>decodeFactChunk(JSON.parse(Buffer.from(c.body).toString()),c.format,c.items.length)),rows);
  for(const c of chunks) assert.ok(c.body.byteLength<=8192);
  const all=[...factChunkBodies(rows,4000,4*1024*1024)][0]!;
  const encoded=JSON.parse(Buffer.from(all.body).toString());
  assert.equal(encoded.dictionary.length,128);
  assert.deepEqual(decodeFactChunk(encoded,all.format,rows.length),rows);
  assert.throws(()=>decodeFactChunk({schema:FACT_CHUNK_FORMAT,dictionary:[],rows:[[0,{}]]},FACT_CHUNK_FORMAT,1),/invalid/);
  assert.throws(()=>decodeFactChunk({schema:FACT_CHUNK_FORMAT,dictionary:[Array(33).fill('x')],rows:[]},FACT_CHUNK_FORMAT,0),/invalid/);
});

test('persisted dictionaries survive gzip/raw reads and reject descriptor or reference corruption', async () => {
  const nodes=Array.from({length:2050},(_,i)=>({id:'n'+i,evidence:[],members:[],
    incremental_provenance:{affected_by_stable_ids:['one','two']}}));
  const value={fact_graph:{nodes,edges:[]}};
  for(const compression of [false,true]) {
    const bodies=new Map<string,Uint8Array>();
    const prepared=await prepareStoredAnalysisPayload(value,(p,i,h)=>`chunks/${p}-${i}-${h}`,
      async(key,body)=>{bodies.set(key,body);return {key,bytes:body.byteLength,sha256:snapshotObjectDigest(body)};},2,{compression,factDictionary:true});
    assert.equal(prepared.envelope?.schema_version,'analysis-payload-chunks-v2');
    assert.deepEqual(await assembleAnalysisPayload(prepared.value,async key=>bodies.get(key)??null),value);
    const visited:unknown[]=[];
    await visitAnalysisFactGraph(prepared.value,async key=>bodies.get(key)??null,{node:v=>visited.push(v),edge:()=>assert.fail()});
    assert.deepEqual(visited,nodes);
    const downgraded=structuredClone(prepared.envelope!); downgraded.schema_version='analysis-payload-chunks-v1';
    assert.throws(()=>parseAnalysisPayloadEnvelope(downgraded),/invalid/);
    const invalid=structuredClone(prepared.envelope!); (invalid.chunks[0] as {format:unknown}).format='unknown';
    assert.throws(()=>parseAnalysisPayloadEnvelope(invalid),/invalid/);
    const first=prepared.envelope!.chunks[0]!; bodies.set(first.key,Buffer.from('bad'));
    await assert.rejects(assembleAnalysisPayload(prepared.value,async key=>bodies.get(key)??null),/integrity_mismatch/);
  }
});

test('sparse or non-string ID lists keep the normal JSON fallback', () => {
  const sparse = Array(3); sparse[1] = 'only';
  const values = [sparse, ['a', null], {key:'value'}, -1].map(ids => ({incremental_provenance:{affected_by_stable_ids:ids}}));
  const restored = [...factChunkBodies(values,2048,4096)].flatMap(c=>decodeFactChunk(JSON.parse(Buffer.from(c.body).toString()),c.format,c.items.length));
  assert.deepEqual(restored,JSON.parse(JSON.stringify(values)));
});
