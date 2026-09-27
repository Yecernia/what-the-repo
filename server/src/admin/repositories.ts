import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ProductStore } from '../persistence/store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import type { ServerConfig } from '../config.js';
import { adminDocuments } from './runtime-config.js';
import { adminError } from './security.js';
import { readObjectInventory } from './storage.js';
import { AdminDocuments } from './documents.js';
import { PHYSICAL_SAMPLE_INTERVAL_MS, BoundedFileScan, accountingFresh, accountingSignature,
  emptyAccounting, emptyPhysicalSample, estimateSnapshotStorage, physicalSampleKey, repositoryFilePaths,
  samplePhysicalTables, type PhysicalSample, type StoredAccounting } from './storage-accounting.js';

const repoOfProject = "lower(regexp_replace(regexp_replace(p.payload->'source'->>'value', '^https?://github.com/', '', 'i'), '(\\.git)?/?$', ''))";
// Resolve the current leader before sorting/pagination; waiters cannot override it.
// Terminal batch state must not be overwritten by mutable project progress.
const batches = `WITH batches AS (
 SELECT u.repository_identity,u.update_id AS batch_id,
   CASE WHEN u.status IN ('queued','running') THEN COALESCE(execution.status,u.status) ELSE u.status END AS status,
   u.created_at,
   CASE WHEN u.status IN ('queued','running') THEN GREATEST(u.updated_at,execution.updated_at) ELSE u.updated_at END AS updated_at,
   CASE WHEN u.status IN ('queued','running') THEN COALESCE(execution.completed_at,u.completed_at) ELSE u.completed_at END AS completed_at,
   p.payload->'analysis' AS analysis,true AS participants_known,u.update_trigger AS trigger
 FROM repository_analysis_updates u LEFT JOIN projects p ON p.project_id=u.leader_project_id
 LEFT JOIN LATERAL (
   SELECT j.status,j.updated_at,j.completed_at FROM analysis_jobs j
   WHERE j.repository_update_id=u.update_id AND j.project_id=u.leader_project_id
     -- A background update runs its leader project's job in the background role.
     AND j.execution_role IN ('leader','background')
   ORDER BY CASE WHEN j.status IN ('running','queued') THEN 0 ELSE 1 END,j.created_at DESC,j.job_id DESC LIMIT 1
 ) execution ON true
 UNION ALL
 SELECT ${repoOfProject},'job:'||j.job_id,j.status,j.created_at,j.updated_at,j.completed_at,
   p.payload->'analysis',false,'manual' FROM analysis_jobs j JOIN projects p USING(project_id)
 WHERE j.repository_update_id IS NULL AND j.execution_role IN ('standalone','leader')
   AND COALESCE(p.payload->'analysis'->>'strategy','') <> 'reuse'
   AND p.payload->'source'->>'kind'='github'
), latest AS (SELECT DISTINCT ON (repository_identity) * FROM batches WHERE repository_identity IS NOT NULL
 ORDER BY repository_identity,CASE WHEN status IN ('running','queued') THEN 0 ELSE 1 END,created_at DESC,batch_id DESC)`;

export function executionStage(status: string, stage: unknown): string {
  if (status !== 'running') return status;
  return typeof stage === 'string' && ['fetching','scanning','extracting','clustering','interpreting'].includes(stage)
    ? stage : 'running';
}

function pageInfo(total: number, input: unknown) {
  const n = Number(input), pageSize = 25, pages = Math.max(1, Math.ceil(total / pageSize));
  return { total, pageSize, pages, page: Math.min(pages, Math.max(1, Number.isSafeInteger(n) ? n : 1)) };
}
// A background update's leader project is only its anchor; the people are those who joined it.
const requesterBinding = "NOT (r.update_trigger='background' AND a.project_id=r.leader_project_id)";
const userColumns = `u.owner_id,u.login,u.display_name,
 COALESCE(u.deleted_at IS NULL AND o.seen_at>clock_timestamp()-interval '90 seconds',false) AS online`;
const userJoins = 'JOIN app_users u ON u.owner_id=p.owner_id LEFT JOIN online_presence o ON o.owner_id=u.owner_id';
const storedFilter = `(payload_purged_at IS NULL OR EXISTS(SELECT 1 FROM admin_documents d
  WHERE d.key='repository-cleanup:'||repository_identity AND d.value->>'status' IN ('pending','failed')))`;
const storedVersions = `WITH versions AS (
 SELECT repository_identity,public_snapshot_key,analysis_snapshot_id,NULL::text AS project_id,commit_sha,created_at,
 public_snapshot_key||':'||accounting_revision::text||':'||analysis_snapshot_id AS revision
 FROM canonical_public_repository_snapshots WHERE ${storedFilter}
 UNION ALL SELECT ${repoOfProject},NULL,s.analysis_snapshot_id,p.project_id,p.payload->'source'->>'commit_sha',s.updated_at,
 p.project_id||':'||s.analysis_snapshot_id||':'||s.updated_at::text
 FROM project_snapshots s JOIN projects p USING(project_id) WHERE p.payload->'source'->>'kind'='github'
 AND NOT EXISTS(SELECT 1 FROM project_public_snapshot_bindings b WHERE b.project_id=p.project_id)
 UNION ALL SELECT substring(key FROM length('repository-cleanup:')+1),NULL,NULL,NULL,NULL,updated_at,key||':'||updated_at::text
 FROM admin_documents WHERE key LIKE 'repository-cleanup:%' AND value->>'status' IN ('pending','failed')
), stored AS (SELECT repository_identity,count(analysis_snapshot_id)::int AS versions,
 COALESCE(array_agg(public_snapshot_key ORDER BY public_snapshot_key) FILTER(WHERE public_snapshot_key IS NOT NULL),ARRAY[]::text[]) AS keys,
 COALESCE(array_agg(project_id ORDER BY project_id) FILTER(WHERE project_id IS NOT NULL),ARRAY[]::text[]) AS legacy_projects,
 array_agg(DISTINCT commit_sha) FILTER(WHERE commit_sha IS NOT NULL) AS commits,max(created_at) AS created_at,
 array_agg(revision ORDER BY revision) AS revisions
 FROM versions GROUP BY repository_identity)`;
function validRepo(repository: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw adminError(400, 'admin_invalid_repository');
}

export class AdminRepositories {
  readonly docs;
  private readonly accountingOwner = randomUUID();
  private pendingScan?: {repository: string; signature: string; scan: BoundedFileScan; accounting: StoredAccounting};
  constructor(readonly store: ProductStore, readonly config: ServerConfig, private readonly queryPool?: Pool) {
    this.docs = queryPool ? new AdminDocuments(store.root,queryPool) : adminDocuments(store);
  }
  get pool(): Pool { if (!this.docs.pool) throw adminError(503, 'admin_requires_postgres'); return this.queryPool??this.docs.pool; }
  async users(repository: string, kind: string, batch: string, limit?: number) {
    validRepo(repository);
    let source: string, params: unknown[];
    if (kind === 'analysis') {
      if (batch.startsWith('job:')) {
        source = `FROM analysis_jobs j JOIN projects p USING(project_id) ${userJoins}
          WHERE j.job_id=$2 AND ${repoOfProject}=$1 AND j.repository_update_id IS NULL`;
        params = [repository, batch.slice(4)];
      } else {
        source = `FROM repository_analysis_update_projects a JOIN repository_analysis_updates r USING(update_id)
          JOIN projects p ON p.project_id=a.project_id ${userJoins}
          WHERE r.repository_identity=$1 AND r.update_id=$2 AND a.created_at<=COALESCE(r.completed_at,'infinity'::timestamptz)
            AND ${requesterBinding}`;
        params = [repository, batch];
      }
    } else if (kind === 'storage') {
      source = `FROM projects p ${userJoins} WHERE (
        EXISTS(SELECT 1 FROM project_public_snapshot_bindings b JOIN canonical_public_repository_snapshots s USING(public_snapshot_key)
          WHERE b.project_id=p.project_id AND s.repository_identity=$1)
        OR (EXISTS(SELECT 1 FROM project_snapshots s WHERE s.project_id=p.project_id) AND ${repoOfProject}=$1))`;
      params = [repository];
    } else throw adminError(400, 'admin_invalid_request');
    const where = ` AND (u.owner_id LIKE 'github:%' OR u.owner_id LIKE 'guest:%')`;
    const query = `SELECT DISTINCT ${userColumns} ${source}${where}`;
    const count = Number((await this.pool.query(`SELECT count(*) AS n FROM (${query}) users`,params)).rows[0].n);
    const users = (await this.pool.query(`${query} ORDER BY online DESC,login,owner_id ${limit ? 'LIMIT '+limit : ''}`,params)).rows;
    return { users, user_count: count };
  }
  async activity(input: unknown) {
    const total = Number((await this.pool.query(`${batches} SELECT count(*) AS n FROM latest`)).rows[0].n);
    const pagination = pageInfo(total,input);
    const result = await this.pool.query(`${batches} SELECT * FROM latest ORDER BY
      CASE WHEN status='running' THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,updated_at DESC,repository_identity
      LIMIT $1 OFFSET $2`,[pagination.pageSize,(pagination.page-1)*pagination.pageSize]);
    const cohortQuery = `WITH selected AS (
      SELECT * FROM unnest($1::text[],$2::text[]) AS batch(repository_identity,batch_id)
    ), owners AS (
      SELECT selected.repository_identity,selected.batch_id,p.owner_id
      FROM selected JOIN repository_analysis_updates r ON r.update_id=selected.batch_id
        AND r.repository_identity=selected.repository_identity
      JOIN repository_analysis_update_projects a ON a.update_id=r.update_id
      JOIN projects p ON p.project_id=a.project_id
      WHERE a.created_at<=COALESCE(r.completed_at,'infinity'::timestamptz) AND ${requesterBinding}
      UNION
      SELECT selected.repository_identity,selected.batch_id,p.owner_id
      FROM selected JOIN analysis_jobs j ON selected.batch_id='job:'||j.job_id
      JOIN projects p USING(project_id)
      WHERE j.repository_update_id IS NULL AND ${repoOfProject}=selected.repository_identity
    ), ranked AS (
      SELECT owners.repository_identity,owners.batch_id,u.owner_id,u.login,u.display_name,
        COALESCE(u.deleted_at IS NULL AND presence.seen_at>clock_timestamp()-interval '90 seconds',false) AS online,
        count(*) OVER(PARTITION BY owners.repository_identity,owners.batch_id)::int AS user_count,
        row_number() OVER(PARTITION BY owners.repository_identity,owners.batch_id ORDER BY
          COALESCE(u.deleted_at IS NULL AND presence.seen_at>clock_timestamp()-interval '90 seconds',false) DESC,
          u.login,u.owner_id) AS rank
      FROM owners JOIN app_users u USING(owner_id)
      LEFT JOIN online_presence presence ON presence.owner_id=u.owner_id
      WHERE u.owner_id LIKE 'github:%' OR u.owner_id LIKE 'guest:%'
    ) SELECT * FROM ranked WHERE rank<=2`;
    const cohortRows=result.rows.length ? (await this.pool.query(cohortQuery,[
      result.rows.map(row=>row.repository_identity),result.rows.map(row=>row.batch_id),
    ])).rows : [];
    const cohorts=new Map<string,{users:unknown[];user_count:number}>();
    for(const row of cohortRows) {
      const key=row.repository_identity+'\0'+row.batch_id;
      const cohort=cohorts.get(key)??{users:[],user_count:Number(row.user_count)};
      cohort.users.push({owner_id:row.owner_id,login:row.login,display_name:row.display_name,online:row.online});
      cohorts.set(key,cohort);
    }
    const repositories = result.rows.map(row=>({ ...row,
      stage: executionStage(row.status,row.analysis?.stage),
      ...(cohorts.get(row.repository_identity+'\0'+row.batch_id)??{users:[],user_count:0}),
    }));
    return { repositories, repositoryPagination: pagination };
  }
  async stored(input: unknown) {
    const total = Number((await this.pool.query(`${storedVersions} SELECT count(*) AS n FROM stored`)).rows[0].n);
    const pagination = pageInfo(total,input);
    const result = await this.pool.query(`${storedVersions} SELECT * FROM stored ORDER BY created_at DESC,repository_identity LIMIT $1 OFFSET $2`,[25,(pagination.page-1)*25]);
    const inventory = await readObjectInventory(this.docs,this.pool,result.rows.flatMap(row=>row.keys as string[]));
    const fresh = Number.isFinite(inventory.totalBytes) && !!inventory.snapshotBytes &&
      Date.parse(inventory.observedAt)>Date.now()-5*60_000;
    const identities = result.rows.map(row=>String(row.repository_identity));
    const userQuery = `WITH owners AS (
      SELECT DISTINCT s.repository_identity,p.owner_id
      FROM project_public_snapshot_bindings b
      JOIN canonical_public_repository_snapshots s USING(public_snapshot_key)
      JOIN projects p USING(project_id)
      WHERE s.repository_identity=ANY($1::text[])
      UNION
      SELECT ${repoOfProject},p.owner_id
      FROM project_snapshots s JOIN projects p USING(project_id)
      WHERE p.payload->'source'->>'kind'='github' AND ${repoOfProject}=ANY($1::text[])
    ), ranked AS (
      SELECT o.repository_identity,u.owner_id,u.login,u.display_name,
        COALESCE(u.deleted_at IS NULL AND presence.seen_at>clock_timestamp()-interval '90 seconds',false) AS online,
        count(*) OVER(PARTITION BY o.repository_identity)::int AS user_count,
        row_number() OVER(PARTITION BY o.repository_identity ORDER BY
          COALESCE(u.deleted_at IS NULL AND presence.seen_at>clock_timestamp()-interval '90 seconds',false) DESC,
          u.login,u.owner_id) AS rank
      FROM owners o JOIN app_users u USING(owner_id)
      LEFT JOIN online_presence presence ON presence.owner_id=u.owner_id
      WHERE u.owner_id LIKE 'github:%' OR u.owner_id LIKE 'guest:%'
    ) SELECT * FROM ranked WHERE rank<=2`;
    const usageQuery = `WITH snapshots AS (
      SELECT repository_identity,analysis_snapshot_id
      FROM canonical_public_repository_snapshots WHERE repository_identity=ANY($1::text[])
      UNION SELECT ${repoOfProject},s.analysis_snapshot_id
      FROM project_snapshots s JOIN projects p USING(project_id)
      WHERE ${repoOfProject}=ANY($1::text[])
    ) SELECT s.repository_identity,max(latest.created_at) AS last_conversation_at
      FROM snapshots s LEFT JOIN LATERAL (
        SELECT m.created_at FROM project_messages m
        WHERE m.role='user' AND m.payload ? 'analysis_snapshot_id'
          AND m.payload->>'analysis_snapshot_id'=s.analysis_snapshot_id
        ORDER BY m.created_at DESC LIMIT 1
      ) latest ON true GROUP BY s.repository_identity`;
    const [userRows,usageRows,accountingRows,cleanupRows] = await Promise.all([
      identities.length ? this.pool.query(userQuery,[identities]).then(r=>r.rows) : [],
      identities.length ? this.pool.query(usageQuery,[identities]).then(r=>r.rows) : [],
      identities.length ? this.pool.query(
      'SELECT key,value FROM admin_documents WHERE key=ANY($1::text[])',
      [identities.map(id=>'storage-accounting:'+id)],
      ).then(r=>r.rows) : [],
      identities.length ? this.pool.query(
        'SELECT key,value FROM admin_documents WHERE key=ANY($1::text[])',
        [identities.map(id=>'repository-cleanup:'+id)],
      ).then(r=>r.rows) : [],
    ]);
    const usersByRepository = new Map<string,{users:unknown[];user_count:number}>();
    for (const user of userRows) {
      const entry=usersByRepository.get(user.repository_identity)??{users:[],user_count:Number(user.user_count)};
      entry.users.push(user);usersByRepository.set(user.repository_identity,entry);
    }
    const usageByRepository=new Map<string,unknown>(usageRows.map(row=>[
      String(row.repository_identity),row.last_conversation_at,
    ]));
    const accounting = new Map<string,StoredAccounting>(accountingRows.map(row=>[
      String(row.key).slice('storage-accounting:'.length),row.value as StoredAccounting,
    ]));
    const cleanupByRepository = new Map<string,{status?:string}>(cleanupRows.map(row=>[
      String(row.key).slice('repository-cleanup:'.length),row.value as {status?:string},
    ]));
    const repositories = [];
    for (const row of result.rows) {
      const objectBytes = fresh ? (row.keys as string[]).reduce((n,key)=>n+(inventory.snapshotBytes[key]??0),0) : null;
      const cleanup=cleanupByRepository.get(row.repository_identity)??{};
      const candidate=accounting.get(row.repository_identity);
      const measured=candidate?.signature===accountingSignature(row)?candidate:emptyAccounting;
      repositories.push({ ...row,...(usersByRepository.get(row.repository_identity)??{users:[],user_count:0}),
        host_file_bytes:measured.host_file_bytes,database_bytes:measured.database_bytes,
        database_index_bytes:measured.database_index_bytes,observedAt:measured.observedAt,
        accounting_fresh:accountingFresh(measured),accounting_status:measured.accounting_status??'pending',
        logical_counts:measured.logical_counts??null,generation_counts:measured.generation_counts??null,
        database_scope:'snapshot_directory_estimate',physical_observed_at:measured.physical_observed_at??null,
        database_estimate_complete:measured.database_estimate_complete??false,
        database_estimated:true,last_conversation_at:usageByRepository.get(row.repository_identity)??null,
        cos_bytes:this.config.cosBucket ? objectBytes : 0, cos_enabled:Boolean(this.config.cosBucket),
        cleanup_status:cleanup.status==='completed' ? null : cleanup.status,
        inventory_at:inventory.observedAt || null, inventory_fresh:fresh });
    }
    return { storedRepositories:repositories, storedPagination:pagination };
  }
  async localBytes(keys: string[], projectIds: string[] = []) {
    const scan = new BoundedFileScan(repositoryFilePaths(this.store.root, keys, projectIds));
    try {
      const result = await scan.step({maxEntries: 10_000, maxMs: 5_000});
      return result.done ? result.bytes : null;
    } finally { await scan.close(); }
  }
  async databaseBytes(keys: string[], additionalProjects: string[] = []) {
    const sample = await this.docs.read<PhysicalSample>(physicalSampleKey, emptyPhysicalSample);
    return estimateSnapshotStorage(this.pool, keys, sample, additionalProjects);
  }
  async closeAccounting() {
    await this.pendingScan?.scan.close(); this.pendingScan = undefined;
    await this.pool.query(`UPDATE admin_documents SET value=jsonb_set(value,'{until}','0'::jsonb)
      WHERE key='storage-accounting-lease' AND value->>'owner'=$1`, [this.accountingOwner]);
  }
  async refreshAccounting() {
    const owner = this.accountingOwner;
    // Atomic, short lease acquisition. Expired owners cannot publish after takeover.
    const lease = (await this.pool.query(`INSERT INTO admin_documents(key,value)
      VALUES('storage-accounting-lease',jsonb_build_object('owner',$1::text,'until',
        extract(epoch FROM clock_timestamp())*1000+60000,'cursor',''))
      ON CONFLICT(key) DO UPDATE SET value=admin_documents.value || jsonb_build_object(
        'owner',$1::text,'until',extract(epoch FROM clock_timestamp())*1000+60000)
      WHERE COALESCE((admin_documents.value->>'until')::numeric,0)<extract(epoch FROM clock_timestamp())*1000
        OR admin_documents.value->>'owner'=$1
      RETURNING value`, [owner])).rows[0]?.value as {cursor: string} | undefined;
    if (!lease) {
      await this.pendingScan?.scan.close(); this.pendingScan = undefined; return;
    }
    const publish = async (key: string, value: unknown) => this.pool.query(`WITH lease AS MATERIALIZED (
      SELECT key FROM admin_documents lease WHERE lease.key='storage-accounting-lease'
        AND lease.value->>'owner'=$3 AND (lease.value->>'until')::numeric>extract(epoch FROM clock_timestamp())*1000
      FOR UPDATE)
      INSERT INTO admin_documents(key,value) SELECT $1,$2::jsonb FROM lease
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`, [key,JSON.stringify(value),owner]);
    let keepLease = false;
    try {
      // Reconcile old published metadata in bounded batches; aborted staging stays
      // explicitly unknown rather than being counted by scanning its fact rows.
      await this.pool.query(`WITH batch AS (SELECT g.directory_id,d.node_count,d.edge_count,d.evidence_count,
        d.layer_count,d.value_point_count FROM snapshot_directory_generations g
        JOIN snapshot_query_directories d USING(directory_id) WHERE g.logical_counts IS NULL
        ORDER BY g.directory_id LIMIT 100)
        UPDATE snapshot_directory_generations g SET logical_counts=jsonb_build_object(
          'nodes',b.node_count,'edges',b.edge_count,'evidence',b.evidence_count,
          'layers',b.layer_count,'value_points',b.value_point_count)
        FROM batch b WHERE g.directory_id=b.directory_id`);
      let physical = await this.docs.read<PhysicalSample>(physicalSampleKey, emptyPhysicalSample);
      if (!(Date.parse(physical.observedAt)>Date.now()-PHYSICAL_SAMPLE_INTERVAL_MS)) {
        physical = await samplePhysicalTables(this.pool);
        await publish(physicalSampleKey, physical);
      }
      const query = async (after: string, exact = false) => this.pool.query(`${storedVersions}
        SELECT * FROM stored WHERE repository_identity${exact ? '=' : '>'}$1 ORDER BY repository_identity LIMIT 1`, [after]);
      const active = (await this.pool.query("SELECT 1 FROM analysis_jobs WHERE status IN ('queued','running') LIMIT 1")).rowCount;
      if (this.pendingScan) {
        const current = (await query(this.pendingScan.repository, true)).rows[0];
        if (!current || accountingSignature(current) !== this.pendingScan.signature) {
          await this.pendingScan.scan.close(); this.pendingScan = undefined;
        }
      }
      // A long disk scan must not hold up other repositories' cheap summaries.
      let row = (await query(lease.cursor ?? '')).rows[0];
      if (!row) row = (await query('')).rows[0];
      if (row) {
        await this.pool.query(`UPDATE admin_documents SET value=jsonb_set(value,'{cursor}',to_jsonb($2::text))
          WHERE key='storage-accounting-lease' AND value->>'owner'=$1`, [owner,String(row.repository_identity)]);
        const key = 'storage-accounting:' + row.repository_identity;
        const previous = await this.docs.read<StoredAccounting>(key, emptyAccounting);
        const signature = accountingSignature(row);
        if (!(previous.signature === signature && accountingFresh(previous))
          && this.pendingScan?.repository !== row.repository_identity) {
          const cleanup = await this.docs.read<{status?: string; projectIds?: string[]}>(
            'repository-cleanup:' + row.repository_identity, {});
          const bindings = (await this.pool.query(
            'SELECT project_id FROM project_public_snapshot_bindings WHERE public_snapshot_key=ANY($1::text[])',
            [row.keys])).rows.map(value => String(value.project_id));
          const projectIds = [...new Set<string>([...bindings,...row.legacy_projects,
            ...(cleanup.status !== 'completed' ? cleanup.projectIds ?? [] : [])])];
          const database = await estimateSnapshotStorage(this.pool, row.keys, physical, row.legacy_projects);
          const accounting: StoredAccounting = {...database, signature, observedAt: new Date().toISOString(),
            host_file_bytes: previous.signature === signature ? previous.host_file_bytes : null, accounting_status: 'scanning'};
          await publish(key, accounting);
          if (!active && !this.pendingScan) this.pendingScan = {repository: String(row.repository_identity), signature, accounting,
            scan: new BoundedFileScan(repositoryFilePaths(this.store.root, row.keys, projectIds))};
        }
      }
      // Metadata stays available under analysis load. Only disk work yields.
      if (active || !this.pendingScan) { keepLease = Boolean(this.pendingScan); return; }
      const pending = this.pendingScan!;
      const result = await pending.scan.step();
      if (!result.done) { keepLease = true; return; }
      await pending.scan.close(); this.pendingScan = undefined;
      pending.accounting.host_file_bytes = result.bytes;
      pending.accounting.accounting_status = result.bytes === null || pending.accounting.generation_counts?.unknown
        ? 'incomplete' : 'ready';
      pending.accounting.observedAt = new Date().toISOString();
      const current = (await query(pending.repository,true)).rows[0];
      if (current && accountingSignature(current) === pending.signature)
        await publish('storage-accounting:' + pending.repository, pending.accounting);
    } finally {
      if (!keepLease) {
        await this.pendingScan?.scan.close(); this.pendingScan = undefined;
        await this.pool.query(`UPDATE admin_documents SET value=jsonb_set(value,'{until}','0'::jsonb)
          WHERE key='storage-accounting-lease' AND value->>'owner'=$1`, [owner]);
      }
    }
  }
  async deletionPlan(repository:string) {
    validRepo(repository);
    const snapshots=(await this.pool.query(`SELECT public_snapshot_key,payload_purged_at FROM canonical_public_repository_snapshots
      WHERE repository_identity=$1 ORDER BY public_snapshot_key`,[repository])).rows;
    const legacy=(await this.pool.query(`SELECT s.project_id,s.analysis_snapshot_id FROM project_snapshots s JOIN projects p USING(project_id)
      WHERE ${repoOfProject}=$1 AND p.payload->'source'->>'kind'='github' AND NOT EXISTS(SELECT 1 FROM project_public_snapshot_bindings b WHERE b.project_id=p.project_id) ORDER BY s.project_id`,[repository])).rows;
    const cleanup=await this.docs.read<{status?:string;projectIds?:string[]}>('repository-cleanup:'+repository,{});
    if(!snapshots.length&&!legacy.length&&!['pending','failed'].includes(cleanup.status??'')) throw adminError(404,'admin_repository_not_found');
    const owners=await this.users(repository,'storage','');
    const active=Number((await this.pool.query(`SELECT count(*) AS n FROM analysis_jobs j JOIN projects p USING(project_id)
      WHERE j.status IN ('queued','running') AND ${repoOfProject}=$1`,[repository])).rows[0].n);
    const bindings=(await this.pool.query(`SELECT b.project_id,b.public_snapshot_key FROM project_public_snapshot_bindings b
      JOIN canonical_public_repository_snapshots s USING(public_snapshot_key) WHERE s.repository_identity=$1 ORDER BY b.project_id`,[repository])).rows;
    const token=createHash('sha256').update(JSON.stringify({repository,snapshots,bindings,legacy})).digest('hex');
    const keys=snapshots.map(s=>String(s.public_snapshot_key));
    const inventory=await readObjectInventory(this.docs,this.pool,keys);
    const fresh=Number.isFinite(inventory.totalBytes) && !!inventory.snapshotBytes &&
      Date.parse(inventory.observedAt)>Date.now()-5*60_000;
    const cosBytes=this.config.cosBucket ? (fresh ? keys.reduce((n,key)=>n+(inventory.snapshotBytes[key]??0),0) : null) : 0;
    const cached=await this.docs.read<StoredAccounting>('storage-accounting:'+repository,emptyAccounting);
    const storedRow=(await this.pool.query(`${storedVersions} SELECT * FROM stored WHERE repository_identity=$1`,[repository])).rows[0];
    const measured=storedRow && cached.signature===accountingSignature(storedRow)?cached:emptyAccounting;
    return { repository_identity:repository, keys:snapshots.map(s=>s.public_snapshot_key), token,
      cos_bytes:cosBytes,host_file_bytes:await this.localBytes(keys,[...bindings.map(b=>String(b.project_id)),...legacy.map(p=>String(p.project_id)),...(cleanup.status!=='completed'?cleanup.projectIds??[]:[])]),
      database_bytes:measured.database_bytes,database_index_bytes:measured.database_index_bytes,
      database_observed_at:measured.observedAt,versions:snapshots.length+legacy.length,
      active_tasks:active, affected_projects:bindings.length+legacy.length, ...owners,
      impact:'删除该仓库所有保存版本的分析成果、快照、安全源码与查询索引；保留用户对话历史。受影响对话将不能继续使用已删除的源码证据，需要重新分析。数据库文件不保证立即缩小。' };
  }
}

/** One bounded accounting pass at a time across API replicas. */
export function collectStoredRepositoryAccounting(store:ProductStore,config:ServerConfig) {
  if(!adminDocuments(store).pool) return async()=>undefined;
  const pool = store instanceof PostgresStore ? store.collectorPool : undefined;
  const repository=new AdminRepositories(store,config,pool);
  let pending:Promise<void>|undefined;
  let lastErrorLog=0;
  const sample=()=>{
    if(pending) return;
    pending=repository.refreshAccounting().catch(error=>{
      if(Date.now()-lastErrorLog>60_000) {
        console.error('admin_storage_accounting_failed',error instanceof Error?error.name:'unknown');
        lastErrorLog=Date.now();
      }
    }).finally(()=>{pending=undefined;});
  };
  sample();
  const timer=setInterval(sample,15_000);
  timer.unref();
  return async()=>{clearInterval(timer);await pending;await repository.closeAccounting();};
}
