import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ProductStore } from '../persistence/store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import type { ServerConfig } from '../config.js';
import { adminDocuments } from './runtime-config.js';
import { adminError } from './security.js';
import { readObjectInventory } from './storage.js';

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
 SELECT repository_identity,public_snapshot_key,analysis_snapshot_id,NULL::text AS project_id,commit_sha,created_at
 FROM canonical_public_repository_snapshots WHERE ${storedFilter}
 UNION ALL SELECT ${repoOfProject},NULL,s.analysis_snapshot_id,p.project_id,p.payload->'source'->>'commit_sha',s.updated_at
 FROM project_snapshots s JOIN projects p USING(project_id) WHERE p.payload->'source'->>'kind'='github'
 AND NOT EXISTS(SELECT 1 FROM project_public_snapshot_bindings b WHERE b.project_id=p.project_id)
 UNION ALL SELECT substring(key FROM length('repository-cleanup:')+1),NULL,NULL,NULL,NULL,updated_at
 FROM admin_documents WHERE key LIKE 'repository-cleanup:%' AND value->>'status' IN ('pending','failed')
), stored AS (SELECT repository_identity,count(analysis_snapshot_id)::int AS versions,
 COALESCE(array_agg(public_snapshot_key ORDER BY public_snapshot_key) FILTER(WHERE public_snapshot_key IS NOT NULL),ARRAY[]::text[]) AS keys,
 COALESCE(array_agg(project_id ORDER BY project_id) FILTER(WHERE project_id IS NOT NULL),ARRAY[]::text[]) AS legacy_projects,
 array_agg(DISTINCT commit_sha) FILTER(WHERE commit_sha IS NOT NULL) AS commits,max(created_at) AS created_at
 FROM versions GROUP BY repository_identity)`;
interface StoredAccounting {
  observedAt: string;
  signature: string;
  host_file_bytes: number | null;
  database_bytes: number | null;
  database_index_bytes: number | null;
}
const emptyAccounting: StoredAccounting = {
  observedAt: '', signature: '', host_file_bytes: null, database_bytes: null, database_index_bytes: null,
};
const accountingSignature=(row:{keys:string[];legacy_projects:string[];created_at:unknown})=>
  JSON.stringify([row.keys,row.legacy_projects,row.created_at]);
function validRepo(repository: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw adminError(400, 'admin_invalid_repository');
}

export class AdminRepositories {
  readonly docs;
  constructor(readonly store: ProductStore, readonly config: ServerConfig, private readonly queryPool?: Pool) { this.docs = adminDocuments(store); }
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
    const inventory = await readObjectInventory(this.docs);
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
        database_estimated:true,last_conversation_at:usageByRepository.get(row.repository_identity)??null,
        cos_bytes:this.config.cosBucket ? objectBytes : 0, cos_enabled:Boolean(this.config.cosBucket),
        cleanup_status:cleanup.status==='completed' ? null : cleanup.status,
        inventory_at:inventory.observedAt || null, inventory_fresh:fresh });
    }
    return { storedRepositories:repositories, storedPagination:pagination };
  }
  async localBytes(keys: string[], projectIds:string[] = []) {
    let bytes = 0;
    const walk = async (path:string):Promise<void> => {
      const info = await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if (!info || info.isSymbolicLink()) return;
      if (info.isFile()) { bytes += info.size; return; }
      if(info.isDirectory()) for(const name of await readdir(path)) await walk(join(path,name));
    };
    try {
      for(const key of keys) {
        if(!/^[a-f0-9]{64}$/.test(key)) return null;
        await walk(join(this.store.root,'public-repository-snapshots',key));
        await walk(join(this.store.root,'source-snapshots','public',key));
        await walk(join(this.store.root,'snapshot-language-overlays',key));
      }
      for(const id of projectIds) if(/^[\w-]+$/.test(id)) {
        await walk(join(this.store.root,'source-snapshots',id));
        for(const folder of ['snapshots','analysis-results','analysis-checkpoints']) await walk(join(this.store.root,folder,id+'.json'));
      }
      return bytes;
    } catch { return null; }
  }
  async databaseBytes(keys:string[],additionalProjects:string[] = []) {
    // Heap/TOAST and B-tree pages are shared: report an explicit estimate, never physical reclaimable bytes.
    const tables = (await this.pool.query(`SELECT c.relname,c.reltuples::float8 AS estimated_rows,pg_table_size(c.oid)::float8 AS data_bytes,
      pg_indexes_size(c.oid)::float8 AS index_bytes,
      array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped
        AND a.attname IN ('public_snapshot_key','snapshot_id','analysis_snapshot_id','project_id','current_public_snapshot_key','directory_id')) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relkind='r'`)).rows;
    const projectIds=[...new Set([...additionalProjects,...(await this.pool.query('SELECT project_id FROM project_public_snapshot_bindings WHERE public_snapshot_key=ANY($1::text[])',[keys])).rows.map(r=>String(r.project_id))])];
    const snapshotIds=(await this.pool.query(`SELECT analysis_snapshot_id FROM canonical_public_repository_snapshots WHERE public_snapshot_key=ANY($1::text[])
      UNION SELECT analysis_snapshot_id FROM project_snapshots WHERE project_id=ANY($2::text[])`,[keys,projectIds])).rows.map(r=>String(r.analysis_snapshot_id));
    const directoryIds=(await this.pool.query('SELECT directory_id::text FROM snapshot_query_directories WHERE public_snapshot_key=ANY($1::text[])',[keys])).rows.map(row=>String(row.directory_id));
    let dataBytes=0,indexBytes=0;
    for(const t of tables) {
      if(!/^[a-z_][a-z_0-9]*$/.test(t.relname) || !t.columns.length) continue;
      const clauses:string[]=[],params:string[][]=[];
      for(const column of t.columns as string[]) {
        params.push(column==='directory_id'?directoryIds:column==='project_id'?projectIds:column==='snapshot_id'||column==='analysis_snapshot_id'?snapshotIds:keys);
        clauses.push(`"${column}"=ANY($${params.length}::${column==='directory_id'?'bigint':'text'}[])`);
      }
      const r=(await this.pool.query(`SELECT count(*)::float8 AS selected FROM ONLY "${t.relname}"
        WHERE ${clauses.join(' OR ')}`,params)).rows[0];
      // The result is already an estimate. Use catalog row estimates instead of
      // recounting every large table for each repository.
      const total=Math.max(Number(t.estimated_rows),Number(r.selected));
      const share=total>0 ? Number(r.selected)/total : 0;
      dataBytes+=Number(t.data_bytes)*share;indexBytes+=Number(t.index_bytes)*share;
    }
    return { database_bytes:Math.round(dataBytes), database_index_bytes:Math.round(indexBytes), database_estimated:true };
  }
  async refreshAccounting() {
    const leaseKey='storage-accounting-lease', owner=randomUUID(), now=Date.now();
    const acquired=await this.docs.change(leaseKey,{owner:'',until:0,cursor:''},state=>{
      if(state.until>now) return false;
      state.owner=owner;state.until=now+30*60_000;
      return true;
    });
    if(!acquired) return;
    try {
      // Heavy estimates run only while analysis is idle, never in an admin GET.
      const active=await this.pool.query("SELECT 1 FROM analysis_jobs WHERE status IN ('queued','running') LIMIT 1");
      if(active.rowCount) return;
      const lease=await this.docs.read(leaseKey,{owner:'',until:0,cursor:''});
      const query=async(after:string)=>this.pool.query(`${storedVersions}
        SELECT * FROM stored WHERE repository_identity>$1 ORDER BY repository_identity LIMIT 1`,[after]);
      let rows=(await query(lease.cursor)).rows;
      if(!rows.length) rows=(await query('')).rows;
      const row=rows[0];
      if(!row) return;
      await this.docs.change(leaseKey,{owner:'',until:0,cursor:''},state=>{
        if(state.owner===owner) state.cursor=String(row.repository_identity);
      });
      const key='storage-accounting:'+row.repository_identity;
      const previous=await this.docs.read<StoredAccounting>(key,emptyAccounting);
      const signature=accountingSignature(row);
      if(previous.signature===signature && Date.parse(previous.observedAt)>now-6*60*60_000) return;
      const cleanup=await this.docs.read<{status?:string;projectIds?:string[]}>(
        'repository-cleanup:'+row.repository_identity,{},
      );
      const bindings=(await this.pool.query(
        'SELECT project_id FROM project_public_snapshot_bindings WHERE public_snapshot_key=ANY($1::text[])',
        [row.keys],
      )).rows.map(value=>String(value.project_id));
      const projectIds=[...new Set<string>([
        ...bindings,...row.legacy_projects,...(cleanup.status!=='completed'?cleanup.projectIds??[]:[]),
      ])];
      const database=await this.databaseBytes(row.keys,projectIds);
      const hostFiles=await this.localBytes(row.keys,projectIds);
      await this.docs.change<StoredAccounting,void>(key,emptyAccounting,value=>{
        Object.assign(value,{...database,host_file_bytes:hostFiles,signature,observedAt:new Date().toISOString()});
      });
    } finally {
      await this.docs.change(leaseKey,{owner:'',until:0,cursor:''},state=>{
        if(state.owner===owner) state.until=0;
      });
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
    const inventory=await readObjectInventory(this.docs);
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
  // Collection uses the ordinary pool; it must not occupy the small admin read lane.
  const repository=new AdminRepositories(store,config,store instanceof PostgresStore?store.pool:undefined);
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
  return async()=>{clearInterval(timer);await pending;};
}
