import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PostgresStore} from '../persistence/postgres-store.js';
import {createProject,createMessage} from '../domain/conversation.js';
import {newAnalysisJob} from '../domain/jobs.js';
import {loadConfig} from '../config.js';
import {AdminRepositories} from './repositories.js';
import {adminDocuments} from './runtime-config.js';
import {acquireRepositoryReadLease} from '../persistence/repository-read-lease.js';

const url=process.env.WTR_ADMIN_TEST_DATABASE_URL;
test('repository directory, shared participants, accounting and destructive cleanup guards',{skip:!url,timeout:60000},async t=>{
  assert.match(new URL(url!).pathname,/^\/wtr_admin_test_[a-z0-9_]+$/);
  const root=await mkdtemp(join(tmpdir(),'wtr-repository-test-'));
  const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:'isolated-admin-repo-secret'.repeat(2),poolMax:1});
  const config={...loadConfig({}),dataDir:root,cosBucket:'isolated-inventory-only'};
  const admin=new AdminRepositories(store,config), docs=adminDocuments(store);
  const ids:string[]=[],keys:string[]=[];
  try {
    await store.init();
    for(let i=0;i<5;i++)await store.saveUser('github:repo-case-'+i,{login:'repo-user-'+i,display_name:'Repository user '+i});
    for(let i=0;i<29;i++){
      const key=createHash('sha256').update('repository-test-'+i).digest('hex');keys.push(key);
      await store.pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,view_payload,analysis_payload,source_storage_key,created_at)
        VALUES($1,$2,'commit','case','case',$3,'{}','{}','',clock_timestamp()-$4::int*interval '1 minute')`,[key,'repo-case/r'+i,'snapshot-case-'+i,i]);
      for(let u=0;u<(i===0?4:1);u++){
        const p=createProject('github:repo-case-'+u,'https://github.com/repo-case/r'+i,'Do not use this conversation title');
        p.analysis.stage='done';p.analysis.canonical_snapshot_key=key;p.analysis.snapshot_id='snapshot-case-'+i;
        p.messages.push(createMessage('user','retained history',{analysis_snapshot_id:'snapshot-case-'+i}));
        await store.saveProject(p);if(i===0)ids.push(p.project_id);
        if(u===0)await store.pool.query(`INSERT INTO repository_analysis_updates(update_id,repository_identity,analyzer_bundle_version,analysis_config_digest,status,leader_project_id,created_at,updated_at,completed_at)
          VALUES($1,$2,'case','case','completed',$3,clock_timestamp()-interval '3 hours',clock_timestamp(),clock_timestamp()-interval '1 hour')`,['case-batch-'+i,'repo-case/r'+i,p.project_id]);
        await store.pool.query(`INSERT INTO repository_analysis_update_projects(update_id,project_id,created_at)
          VALUES($1,$2,clock_timestamp()-$3::int*interval '1 hour')`,['case-batch-'+i,p.project_id,u===3?0:2]);
      }
    }
    await store.pool.query(`INSERT INTO online_presence(owner_id,kind,seen_at) VALUES('github:repo-case-2','github',clock_timestamp())`);
    await docs.change('object-inventory',{observedAt:'',objects:[] as Array<{key:string;bytes:number}>},r=>{
      r.observedAt=new Date().toISOString();r.objects=[{key:`public-repository-snapshots/${keys[0]}/view.json`,bytes:5},{key:`public-repository-snapshots/${keys[0]}/view.json`,bytes:7}];
    });
    await t.test('repository pagination and cohorts exclude post-completion reuse; names and online ordering',async()=>{
      const list=await admin.activity(1);assert.equal(list.repositories.length,25);assert.ok((await admin.activity(2)).repositories.length>=4);
      const cohort=await admin.users('repo-case/r0','analysis','case-batch-0',2);
      assert.equal(cohort.user_count,3);assert.equal(cohort.users.length,2);assert.equal(cohort.users[0].login,'repo-user-2');
      assert.equal((await admin.users('repo-case/r0','analysis','case-batch-0')).users.length,3);
      const stored=await admin.stored(1);const row=stored.storedRepositories.find(r=>r.repository_identity==='repo-case/r0')!;
      assert.equal(row.user_count,4);assert.equal(row.cos_bytes,12,'retained COS versions counted once, never multiplied by users');
      assert.ok(row.database_bytes>0);assert.ok(row.database_index_bytes>0);assert.ok(row.last_conversation_at);
      await docs.change('object-inventory',{observedAt:'',objects:[]},r=>{r.observedAt='2000-01-01T00:00:00Z';});
      assert.equal((await admin.stored(1)).storedRepositories.find(r=>r.repository_identity==='repo-case/r0')!.cos_bytes,null);
    });
    await t.test('changed references and running analysis reject deletion',async()=>{
      const stale=await admin.deletionPlan('repo-case/r0');
      const p=createProject('github:repo-case-4','https://github.com/repo-case/r0','new reference');p.analysis.canonical_snapshot_key=keys[0]!;p.analysis.snapshot_id='snapshot-case-0';await store.saveProject(p);ids.push(p.project_id);
      await assert.rejects(store.adminDeleteRepository('repo-case/r0',stale.token,'test'),/admin_repository_changed/);
      const job=newAnalysisJob(ids[0]!,'repository-delete-guard');await store.saveJob(job);
      const plan=await admin.deletionPlan('repo-case/r0');assert.equal(plan.active_tasks,1);
      await assert.rejects(store.adminDeleteRepository('repo-case/r0',plan.token,'test'),/admin_snapshot_busy/);
      await store.saveJob({...job,status:'succeeded'});
    });
    await t.test('concurrent read leases do not exhaust a one-connection pool; last reader protects deletion',async()=>{
      const [a,b]=await Promise.all([acquireRepositoryReadLease(store),acquireRepositoryReadLease(store)]);
      try {
        assert.equal((await store.pool.query('SELECT 1 AS n')).rows[0].n,1);
        const plan=await admin.deletionPlan('repo-case/r0');
        await assert.rejects(store.adminDeleteRepository('repo-case/r0',plan.token,'test'),/admin_repository_in_use/);
        await a!();await assert.rejects(store.adminDeleteRepository('repo-case/r0',plan.token,'test'),/admin_repository_in_use/);
      } finally {await a!();await b!();}
    });
    await t.test('partial delete stays withdrawn, retries cleanly, preserves history and other repositories',async()=>{
      const original=store.snapshotObjects.delete.bind(store.snapshotObjects);let failed=false;
      store.snapshotObjects.delete=async key=>{if(!failed){failed=true;throw Error('isolated failure');}await original(key);};
      const plan=await admin.deletionPlan('repo-case/r0');
      await assert.rejects(store.adminDeleteRepository('repo-case/r0',plan.token,'test'),/storage_delete_incomplete/);
      assert.equal((await store.loadProject(ids[0]!))!.analysis.removed_by_admin,true);
      assert.equal((await docs.read<{status:string}>('repository-cleanup:repo-case/r0',{status:''})).status,'failed');
      assert.ok((await admin.stored(1)).storedRepositories.some(r=>r.repository_identity==='repo-case/r0'));
      store.snapshotObjects.delete=original;
      await store.adminDeleteRepository('repo-case/r0',(await admin.deletionPlan('repo-case/r0')).token,'test');
      assert.equal((await docs.read<{status:string}>('repository-cleanup:repo-case/r0',{status:''})).status,'completed');
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id=ANY($1::text[])',[ids])).rows[0].n,4);
      assert.equal((await store.pool.query('SELECT payload_purged_at FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[keys[1]])).rows[0].payload_purged_at,null);
    });
    await t.test('legacy independent snapshots are listed and deleted with their conversation retained',async()=>{
      const p=createProject('github:repo-case-0','https://github.com/repo-case/legacy','legacy');await store.saveProject(p);
      await store.pool.query(`INSERT INTO project_snapshots(project_id,analysis_snapshot_id,view_payload,analysis_payload) VALUES($1,'legacy-snapshot','{}','{}')`,[p.project_id]);
      assert.equal((await admin.users('repo-case/legacy','storage','')).user_count,1);
      const plan=await admin.deletionPlan('repo-case/legacy');assert.equal(plan.versions,1);
      await store.adminDeleteRepository('repo-case/legacy',plan.token,'test');
      assert.ok(await store.loadProject(p.project_id));assert.equal((await store.pool.query('SELECT 1 FROM project_snapshots WHERE project_id=$1',[p.project_id])).rowCount,0);
    });
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});
