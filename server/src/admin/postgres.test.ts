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
import { StorageManager } from './storage.js';
import { loadConfig } from '../config.js';

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
        // Thirty independent tasks; one task's later calls would be admitted work.
        Array.from({ length: 30 }, (_, index) => budget.acquire({ ...input,
          attribution: { ...input.attribution, taskId: 'task-' + index } })),
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
      await budget.acquire({ ...input, attribution: { ...input.attribution, taskId: 'task-new-a' } });
      await assert.rejects(() => budget.acquire({ ...input, attribution: { ...input.attribution, taskId: 'task-new-b' } }), {
        code: 'site_budget_busy',
      });
      // A started task is not cut off by the daily budget it was admitted under.
      await budget.acquire({ ...input, attribution: { ...input.attribution, taskId: 'task-new-a' } });
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
        const disk = (async () => ({blocks: 100 * 1024 ** 3, bavail: 20 * 1024 ** 3, bsize: 1})) as
          unknown as typeof import('node:fs/promises').statfs;
        const storage = new StorageManager(store, loadConfig({}), disk);
        let activeAdmissions = 0, maxAdmissions = 0;
        await Promise.all(Array.from({length: 4}, () => storage.admit(job, async () => {
          activeAdmissions++;
          maxAdmissions = Math.max(maxAdmissions, activeAdmissions);
          // Other admissions may be queued, but management and business reads stay available.
          await Promise.all([store.adminPool.query('SELECT 1'), store.pool.query('SELECT 1')]);
          activeAdmissions--;
        })));
        assert.equal(maxAdmissions, 1, 'capacity admission serializes without nested pool acquisition');
        const key='b'.repeat(64);
        await pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,view_payload,analysis_payload,source_storage_key,purge_after) VALUES($1,'example/fixture','commit','test','test','isolated','{}','{}','',clock_timestamp()-interval '1 day')`,[key]);
        const now=new Date().toISOString();
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'A snapshot that was never retired is not cleaned');
        await pool.query(`UPDATE canonical_public_repository_snapshots SET retired_at=clock_timestamp()-interval '2 days' WHERE public_snapshot_key=$1`,[key]);
        await pool.query(`INSERT INTO canonical_public_repositories(repository_identity,current_public_snapshot_key) VALUES('example/fixture',$1)`,[key]);
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'The repository current pointer protects the snapshot');
        await pool.query(`UPDATE canonical_public_repositories SET current_public_snapshot_key=NULL WHERE repository_identity='example/fixture'`);
        await pool.query(`INSERT INTO snapshot_read_leases(lease_id,public_snapshot_key,expires_at,absolute_expires_at) VALUES('lease',$1,clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '5 minutes')`,[key]);
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'An in-flight read lease protects the snapshot');
        await store.releaseSnapshotReadLease('lease');
        assert.equal(await store.acquireSnapshotReadLease(key,30),null,'An expired retired version admits no new reads');
        await pool.query(`INSERT INTO repository_analysis_updates(update_id,repository_identity,analyzer_bundle_version,analysis_config_digest,status,leader_project_id,base_public_snapshot_key,created_at,updated_at) VALUES('base-update','example/fixture','test','test','queued',$1,$2,now(),now())`,[project.project_id,key]);
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'An active update based on the snapshot protects it');
        await pool.query(`UPDATE repository_analysis_updates SET status='failed' WHERE update_id='base-update'`);
        const originalDelete=store.snapshotObjects.delete.bind(store.snapshotObjects);
        store.snapshotObjects.delete=async()=>{throw new Error('isolated-object-delete-failure');};
        assert.equal(await store.purgePublicSnapshotPayload(key,now),true,'Unrelated queued work no longer blocks cleanup');
        assert.notEqual((await pool.query('SELECT payload_purged_at FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key])).rows[0].payload_purged_at,null,'The payload is logically unreadable once cleanup commits');
        const pending=await pool.query('SELECT count(*)::int AS pending FROM snapshot_payload_deletions WHERE public_snapshot_key=$1 AND deleted_at IS NULL AND last_error IS NOT NULL',[key]);
        assert.ok(pending.rows[0].pending>0,'Failed object deletions stay in the durable retry ledger');
        store.snapshotObjects.delete=originalDelete;
        await pool.query('UPDATE snapshot_payload_deletions SET next_attempt_at=clock_timestamp() WHERE public_snapshot_key=$1',[key]);
        assert.equal((await store.deleteRetiredSnapshotObjectsBatch(256)).pending,0,'A later retry finishes the ledger');
        assert.equal(await store.purgePublicSnapshotPayload(key,now),false,'Repeated deletion is idempotent');
      }finally{await store.close();await rm(root,{recursive:true,force:true});}
    } finally {
      await pool.end();
    }
  },
);
