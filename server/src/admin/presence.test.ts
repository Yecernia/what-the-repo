import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../persistence/file-store.js';
import {recordPresence} from './routes.js';
import {adminDocuments} from './runtime-config.js';
test('multiple tab heartbeats deduplicate browser identities and expire after 90 seconds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-presence-'));const store=new FileStore(root);await store.init();let now=Date.now();t.mock.method(Date,'now',()=>now);
  try{
    const deps={store};
    for(let i=0;i<8;i++)await recordPresence(deps,{owner_id:'guest:one-browser',kind:'guest'});
    await recordPresence(deps,{owner_id:'github:1',kind:'github'});
    assert.equal(Object.keys(await adminDocuments(store).read('presence',{})).length,2);
    now+=91000;await recordPresence(deps,{owner_id:'github:1',kind:'github'});
    assert.deepEqual(Object.keys(await adminDocuments(store).read('presence',{})),['github:1']);
  }finally{await rm(root,{recursive:true,force:true});}
});
