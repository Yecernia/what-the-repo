import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
  PostgresProviderUsageBudget,
  DEFAULT_BUDGET_POLICIES,
} from '../agent/provider-budget.js';
import { AdminDocuments } from './documents.js';
import { AdminSecurity, digest, totp } from './security.js';
import { applyMigrations } from '../persistence/migrations.js';
import { join } from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {PostgresStore} from '../persistence/postgres-store.js';
import {createProject} from '../domain/conversation.js';
import {newAnalysisJob} from '../domain/jobs.js';
import { audienceCounts, sampleAudience } from './audience.js';

const url = process.env.WTR_ADMIN_TEST_DATABASE_URL;
test(
  'isolated PostgreSQL: concurrent budget admission, idempotent settlement, policies and cross-process MFA replay',
  { skip: !url },
  async () => {
    const target = new URL(url!);
    assert.equal(target.hostname, '127.0.0.1');
    assert.match(target.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
    const pool = new Pool({ connectionString: url, max: 12 });
    try {
      await applyMigrations(pool, join(process.cwd(), 'migrations'));
      await pool.query(`INSERT INTO app_users(owner_id,login,display_name,deleted_at) VALUES
        ('github:audience','test','test',NULL),('guest:audience','test','test',NULL),
        ('guest:deleted','test','test',clock_timestamp()),('system:audience','test','test',NULL)`);
      await pool.query(`INSERT INTO online_presence(owner_id,kind,seen_at) VALUES
        ('github:audience','github',clock_timestamp()),('guest:audience','guest',clock_timestamp()-interval '91 seconds'),
        ('guest:deleted','guest',clock_timestamp()),('guest:missing','guest',clock_timestamp())`);
      assert.equal((await audienceCounts(pool)).github, 1);
      assert.equal((await audienceCounts(pool)).guest, 1);
      await Promise.all(Array.from({length:8},()=>sampleAudience(pool)));
      const samples = (await pool.query('SELECT * FROM admin_audience_samples')).rows;
      assert.equal(samples.length, 1);
      assert.equal(samples[0].online_github, 1);
      assert.equal(samples[0].online_guest, 0, 'expired, deleted and missing identities are excluded');
      const docs = new AdminDocuments('unused', pool);
      await docs.change('budgets', DEFAULT_BUDGET_POLICIES, (p) => {
        p.analysis_daily = 0.05;
        p.chat_daily = 0;
        p.evolution_task = null;
        p.evolution_daily = 0.01;
      });
      const budget = new PostgresProviderUsageBudget(pool, {
        maxCallsPerMinute: 1000,
        deploymentMaxCallsPerMinute: 1000,
        minimumReservationUsd: 0.01,
      });
      const input = {
        ownerId: 'isolated',
        provider: 'test',
        model: 'mock',
        attribution: {
          business: 'analysis' as const,
          payer: 'platform' as const,
          taskId: 'task-1',
        },
      };
      const attempts = await Promise.allSettled(
        Array.from({ length: 30 }, () => budget.acquire(input)),
      );
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 5);
      const permit = attempts.find((r) => r.status === 'fulfilled');
      assert.ok(permit?.status === 'fulfilled');
      const report = {
        usageKnown: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        status: 'failed' as const,
      };
      await Promise.all(
        Array.from({ length: 5 }, () => permit.value.release(report)),
      );
      await budget.acquire(input);
      await assert.rejects(() => budget.acquire(input), {
        code: 'site_analysis_budget_exhausted',
      });
      await budget.acquire({
        ...input,
        attribution: { ...input.attribution, business: 'chat', payer: 'user' },
      });
      await assert.rejects(
        () =>
          budget.acquire({
            ...input,
            attribution: { ...input.attribution, business: 'chat' },
          }),
        { code: 'site_budget_disabled' },
      );
      const authConfig = {
        githubId: '123',
        encryptionSecret: 'isolated-postgres-secret-'.repeat(2),
        bootstrapHash: digest('test-bootstrap'),
        production: false,
      };
      let now = Date.now();
      const a = new AdminSecurity(docs, authConfig, () => now),
        b = new AdminSecurity(
          new AdminDocuments('unused', pool),
          authConfig,
          () => now,
        );
      const challenge = await a.beginGithub('github:123'),
        enrollment = await a.enroll(challenge, 'test-bootstrap');
      await a.confirm(
        challenge,
        totp(enrollment.seed, Math.floor(now / 30000)),
      );
      now += 30000;
      const first = await a.beginGithub('github:123'),
        second = await b.beginGithub('github:123');
      const code = totp(enrollment.seed, Math.floor(now / 30000));
      const logins = await Promise.allSettled([
        a.verify(first, code),
        b.verify(second, code),
      ]);
      assert.equal(logins.filter((r) => r.status === 'fulfilled').length, 1);
      // Deleting a user cannot erase paid calls or restore shared platform budget.
      const constraints = await pool.query(
        "SELECT confdeltype FROM pg_constraint WHERE conrelid='provider_usage_events'::regclass AND contype='f'",
      );
      assert.equal(constraints.rowCount, 0);
      const root=await mkdtemp(join(tmpdir(),'wtr-admin-pg-storage-'));
      const store=new PostgresStore({root,databaseUrl:url!,migrationsRoot:join(process.cwd(),'migrations'),encryptionSecret:authConfig.encryptionSecret});
      try{
        await store.init();
        await store.saveUser('github:987',{owner_id:'github:987',kind:'github',login:'isolated',display_name:'Isolated',avatar_url:null});
        const project=createProject('github:987','https://github.com/example/fixture','Isolated',null);const job=newAnalysisJob(project.project_id,'storage-protection');
        await store.createProjectWithJob(project,job);
        const key='b'.repeat(64);
        await pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,view_payload,analysis_payload,source_storage_key,purge_after) VALUES($1,'example/fixture','commit','test','test','isolated','{}','{}','',clock_timestamp()-interval '1 day')`,[key]);
        const now=new Date().toISOString();
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'Queued work protects payloads');
        await store.saveJob({...job,status:'succeeded',completed_at:now});
        await pool.query('INSERT INTO project_public_snapshot_bindings(project_id,public_snapshot_key) VALUES($1,$2)',[project.project_id,key]);
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'A shared project reference protects the snapshot');
        await pool.query('DELETE FROM project_public_snapshot_bindings WHERE project_id=$1',[project.project_id]);
        await pool.query(`INSERT INTO canonical_public_repository_heads(repository_identity,analyzer_bundle_version,analysis_config_digest,current_public_snapshot_key) VALUES('example/fixture','test','test',$1)`,[key]);
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'The current repository head is an effective reference');
        await pool.query(`DELETE FROM canonical_public_repository_heads WHERE repository_identity='example/fixture'`);
        const originalDelete=store.snapshotObjects.delete.bind(store.snapshotObjects);
        store.snapshotObjects.delete=async()=>{throw new Error('isolated-object-delete-failure');};
        await assert.rejects(()=>store.purgePublicSnapshotPayload(key,now),/storage_delete_incomplete/);
        assert.equal((await pool.query('SELECT payload_purged_at FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key])).rows[0].payload_purged_at,null,'Failed deletion keeps the candidate retryable');
        store.snapshotObjects.delete=originalDelete;
        assert.equal(await store.purgePublicSnapshotPayload(key,now),true,'Only an unreferenced expired test snapshot can be deleted');
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'Repeated deletion is idempotent');
      }finally{await store.close();await rm(root,{recursive:true,force:true});}
    } finally {
      await pool.end();
    }
  },
);
