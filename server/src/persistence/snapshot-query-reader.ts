import { connectWithAbort } from '../scheduling/permits.js';
import { executionErrorCode } from '../services/execution-error.js';
import { serviceError } from '../services/errors.js';
import type { Pool, PoolClient } from 'pg';
import { hasNodeScope, cursorKey, pageSnapshotQueryCandidates,
  type QueryItem, type SnapshotQueryDirectory, type SnapshotQueryInput, type SnapshotQueryResult } from '../domain/snapshot-query.js';
import { queryTerms } from '../domain/query-relevance.js';
import { parseDirectoryManifest, readDirectoryRows, type DirectoryObjectManifest } from './directory-objects.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

type Request = { publicKey: string; snapshotId: string; query: SnapshotQueryInput; signal?: AbortSignal };
const limitOf=(n?:number)=>Number.isFinite(n)?Math.max(1,Math.min(100,Math.floor(n!))):20;
type Candidate={kind:'node'|'edge';row_no:number;local_key:string;item_key:string;score:number};
const compareIdentity=(left:string,right:string)=>Buffer.compare(Buffer.from(left),Buffer.from(right));

export function neighborEndpointKeys(ids:readonly string[]):string[]{
  const keys=new Set<string>();for(const id of ids){keys.add(id);keys.add(`component:${id}`);keys.add(`fact:${id}`);}return [...keys];
}

async function withDirectory<T>(pool:Pool, request:{publicKey:string;snapshotId:string;signal?:AbortSignal},
  task:(db:PoolClient,id:string,manifest:DirectoryObjectManifest,digest:string)=>Promise<T>):Promise<T|null>{
  const db=await connectWithAbort<PoolClient>(pool,request.signal);let released=false;
  const release=(destroy=false)=>{if(!released){released=true;db.release(destroy);}};
  const abort=()=>release(true);request.signal?.addEventListener('abort',abort,{once:true});
  try{
    request.signal?.throwIfAborted();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Interactive pages return few indexed rows even when inherited-table row
    // estimates are large. Per-request JIT compilation can dominate their work.
    await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='1s'; SET LOCAL jit=off");
    const meta=await db.query(`SELECT d.snapshot_id,d.schema_version,d.directory_digest,d.directory_id,g.object_manifest
      FROM snapshot_query_directories d JOIN snapshot_directory_generations g USING(directory_id)
      WHERE d.public_snapshot_key=$1`,[request.publicKey]);
    const row=meta.rows[0];
    if(!row||row.snapshot_id!==request.snapshotId){await db.query('COMMIT');return null;}
    if(row.schema_version!==3||!row.object_manifest||row.object_manifest.version!==1)
      throw serviceError('snapshot_directory_reanalysis_required','snapshot_directory_reanalysis_required',409);
    const result=await task(db,row.directory_id,parseDirectoryManifest(row.object_manifest,{publicKey:request.publicKey,directoryId:row.directory_id}),row.directory_digest);
    request.signal?.throwIfAborted();await db.query('COMMIT');return result;
  }catch(error){if(!released)await db.query('ROLLBACK').catch(()=>undefined);if(request.signal?.aborted)throw request.signal.reason;
    const code=executionErrorCode(error);if(code)throw serviceError(code,code,503);throw error;
  }finally{request.signal?.removeEventListener('abort',abort);release();}
}

/** SQL selects compact ordinals; response content is hydrated in covering COS
 * chunks. The open read transaction protects this generation from reclamation. */
export async function readSnapshotQuery(pool:Pool,input:Request,objectStore:SnapshotObjectStore):Promise<SnapshotQueryResult|null>{
  return withDirectory(pool,input,async(db,id,manifest,digest)=>{
    const directory:SnapshotQueryDirectory={public_snapshot_key:input.publicKey,snapshot_id:input.snapshotId,digest,
      nodes:[],edges:[],evidence:[],evidence_links:[],layers:[],value_points:[],memberships:[],projections:[],aggregates:[]};
    const ranked=await rankedCandidates(db,input,id);
    const nodeCandidates=ranked.filter(row=>row.kind==='node'),edgeCandidates=ranked.filter(row=>row.kind==='edge');
    [directory.nodes,directory.edges]=await Promise.all([
      readDirectoryRows(objectStore,manifest,'nodes',nodeCandidates.map(row=>row.row_no)),
      readDirectoryRows(objectStore,manifest,'edges',edgeCandidates.map(row=>row.row_no)),
    ]);
    for (const [rows,candidates,identity] of [[directory.nodes,nodeCandidates,'node_key'],[directory.edges,edgeCandidates,'edge_key']] as const)
      rows.forEach((row,index)=>{
        if(row.public_snapshot_key!==input.publicKey||row.snapshot_id!==input.snapshotId
          ||(row as unknown as Record<string,unknown>)[identity]!==candidates[index]!.local_key)throw new Error('snapshot_directory_locator_mismatch');
      });
    const nodes=new Map(directory.nodes.map(row=>[row.node_key,row])),edges=new Map(directory.edges.map(row=>[row.edge_key,row]));
    const items=ranked.map(row=>({key:row.item_key,kind:row.kind,relevance:row.score,
      row:row.kind==='node'?nodes.get(row.local_key):edges.get(row.local_key)} as QueryItem));
    if(items.some(item=>!item.row))throw new Error('snapshot_query_candidate_missing');
    if(input.query.include_metadata!==false){
      for(const section of ['layers','value_points','memberships','projections','aggregates'] as const)
        (directory[section] as unknown[])=await readDirectoryRows(objectStore,manifest,section);
    }
    const candidates=ranked.slice(0,limitOf(input.query.limit));
    const selected=await selectedEvidence(db,id,candidates,input.query.evidence_per_owner);
    directory.evidence=await readDirectoryRows(objectStore,manifest,'evidence',selected.ordinals);
    const expectedEvidence=new Map(selected.links.map(row=>[row.evidence_no,row.evidence_id]));
    directory.evidence.forEach((row,index)=>{
      if(row.public_snapshot_key!==input.publicKey||row.snapshot_id!==input.snapshotId||row.evidence_id!==expectedEvidence.get(selected.ordinals[index]!))
        throw new Error('snapshot_directory_locator_mismatch');
    });
    // SQL owner order and COS covering-chunk order are not presentation ranks.
    // Keep evidence stable before consumers select the first references to show.
    directory.evidence.sort((left,right)=>compareIdentity(left.evidence_id,right.evidence_id));
    directory.evidence_links=selected.links.map(row=>({public_snapshot_key:input.publicKey,evidence_id:row.evidence_id,
      owner_kind:row.owner_kind===0?'node':'edge',owner_key:row.owner_key,role:row.role===0?'evidence':'member'}));
    if(!input.query.evidence_per_owner&&selected.ordinals.length){
      const wanted=new Set(directory.evidence.map(row=>row.evidence_id));
      directory.evidence_links.push(...(await readDirectoryRows(objectStore,manifest,'evidence_links')).filter(row=>wanted.has(row.evidence_id)));
    }
    directory.evidence_links.sort((left,right)=>compareIdentity(left.evidence_id,right.evidence_id)
      ||compareIdentity(left.owner_kind,right.owner_kind)||compareIdentity(left.owner_key,right.owner_key)
      ||compareIdentity(left.role,right.role));
    (directory as SnapshotQueryDirectory&{evidence_truncated:boolean}).evidence_truncated=selected.truncated;
    return pageSnapshotQueryCandidates(directory,{...input.query,cursor:null},items);
  });
}

export async function readDirectoryEvidence(pool:Pool,input:{publicKey:string;snapshotId:string;evidenceIds:string[];signal?:AbortSignal},
  objectStore:SnapshotObjectStore):Promise<SnapshotQueryDirectory['evidence']>{
  if(!input.evidenceIds.length)return [];
  if(input.evidenceIds.length>20)throw serviceError('request_invalid','request_invalid',400);
  return await withDirectory(pool,input,async(db,id,manifest)=>{
    const found=await db.query<{row_no:number;evidence_id:string}>(`SELECT row_no,evidence_id FROM snapshot_directory_evidence
      WHERE directory_id=$1 AND evidence_id=ANY($2::text[])`,[id,[...new Set(input.evidenceIds)]]);
    const byId=new Map(found.rows.map(row=>[row.evidence_id,row.row_no]));
    const ids=[...new Set(input.evidenceIds)].filter(key=>byId.has(key));
    const rows=await readDirectoryRows(objectStore,manifest,'evidence',ids.map(key=>byId.get(key)!));
    rows.forEach((row,index)=>{
      if(row.public_snapshot_key!==input.publicKey||row.snapshot_id!==input.snapshotId||row.evidence_id!==ids[index])
        throw new Error('snapshot_directory_locator_mismatch');
    });
    return rows;
  })??[];
}

async function rankedCandidates(db:PoolClient,request:Request,id:string):Promise<Candidate[]>{
  const input=request.query,values:unknown[]=[id],scopes:string[]=[];
  const bind=(value:unknown,type='text')=>{values.push(value);return `$${values.length}::${type}`;};
  const nodeBase='n.directory_id=$1',edgeBase='e.directory_id=$1';
  const nodeId="substr(n.node_key,strpos(n.node_key,':')+1)";
  const conditions=[nodeBase],edgeConditions=[edgeBase];
  const ids=[...new Set([...(input.entity_ids??[]),...(input.component_ids??[])])];
  if(ids.length){
    const param=bind(input.scope==='neighbors'?neighborEndpointKeys(ids):ids,'text[]'),matches=`(n.node_key=ANY(${param}) OR ${nodeId}=ANY(${param}))`;
    if(!input.scope||input.scope==='self')conditions.push(matches);
    else if(input.scope==='neighbors'){
      const endpoint=param;
      scopes.push(`neighbor_seeds AS (SELECT n.row_no FROM snapshot_directory_nodes n WHERE ${nodeBase} AND n.node_key=ANY(${endpoint})
        UNION SELECT e.source_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.source_missing=ANY(${endpoint})
        UNION SELECT e.target_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.target_missing=ANY(${endpoint}))`);
      scopes.push(`scope_nodes AS (SELECT DISTINCT endpoint.no FROM neighbor_seeds seed CROSS JOIN LATERAL (
        SELECT e.source_no,e.target_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.source_no=seed.row_no
        UNION ALL SELECT e.source_no,e.target_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.target_no=seed.row_no
      ) hit CROSS JOIN LATERAL unnest(ARRAY[hit.source_no,hit.target_no]) endpoint(no))`);
      conditions.push('n.row_no IN (SELECT no FROM scope_nodes)');
    }else{
      scopes.push(`scope_nodes AS (SELECT n.row_no,n.parent_no FROM snapshot_directory_nodes n WHERE ${nodeBase} AND ${matches}
        UNION SELECT n.row_no,n.parent_no FROM snapshot_directory_nodes n JOIN scope_nodes s ON
        ${input.scope==='ancestors'?'n.row_no=s.parent_no':'n.parent_no=s.row_no'} WHERE ${nodeBase})`);
      conditions.push('n.row_no IN (SELECT row_no FROM scope_nodes)');
    }
  }
  if(input.paths?.length){
    const paths=bind(input.paths,'text[]');
    const patterns=bind(input.paths.map(path=>'%'+path.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%'),'text[]');
    conditions.push(`n.search_text LIKE ANY(${patterns})`,`EXISTS(SELECT 1 FROM unnest(${paths}) p WHERE strpos(COALESCE(n.path,''),p)>0)`);
  }
  if(input.languages?.length)conditions.push(`n.language=ANY(${bind(input.languages.map(v=>v.toLowerCase()),'text[]')})`);
  if(input.symbol_ids?.length){const param=bind(input.symbol_ids,'text[]');conditions.push(`(n.node_key=ANY(${param}) OR ${nodeId}=ANY(${param}))`);}
  if(input.entity_kinds?.length)conditions.push(`n.entity_kind=ANY(${bind(input.entity_kinds,'text[]')})`);
  if(input.depth!==undefined)conditions.push(`n.depth<=${bind(Math.max(0,Math.min(100,Math.floor(input.depth))),'int')}`);
  if(input.projection)conditions.push(`${bind(input.projection)}=ANY(n.projection_kinds)`);
  const text=input.text?.trim().toLowerCase();
  if(text){const pattern=bind('%'+text.replace(/[\\%_]/g,'\\$&')+'%');conditions.push(`n.search_text LIKE ${pattern}`);edgeConditions.push(`e.search_text LIKE ${pattern}`);}
  if(input.relation_kinds?.length&&!(input.expand_hops&&input.expand_hops>=1))edgeConditions.push(`e.relation_kind=ANY(${bind(input.relation_kinds,'text[]')})`);
  scopes.push(`seed AS (SELECT n.row_no FROM snapshot_directory_nodes n WHERE ${conditions.join(' AND ')})`);
  const hops=Math.max(0,Math.min(2,Math.floor(input.expand_hops??0)));
  if(hops){
    scopes.push(`walked(row_no,hop) AS (SELECT row_no,0 FROM seed UNION
      SELECT endpoint.no,w.hop+1 FROM walked w JOIN snapshot_directory_edges e ON ${edgeBase}
      AND (e.source_no=w.row_no OR e.target_no=w.row_no)
      CROSS JOIN LATERAL unnest(ARRAY[e.source_no,e.target_no]) endpoint(no) WHERE w.hop<${hops})`);
    scopes.push('chosen AS (SELECT DISTINCT row_no FROM walked)');
    edgeConditions.splice(0,edgeConditions.length,edgeBase,'e.row_no IN (SELECT row_no FROM incident_edges)');
  }else{
    scopes.push('chosen AS (SELECT row_no FROM seed)');
    if(hasNodeScope(input))edgeConditions.push('e.row_no IN (SELECT row_no FROM incident_edges)');
  }
  if(hops||hasNodeScope(input))scopes.push(`incident_edges AS MATERIALIZED (SELECT DISTINCT hit.row_no FROM chosen c CROSS JOIN LATERAL (
    SELECT e.row_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.source_no=c.row_no
    UNION ALL SELECT e.row_no FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.target_no=c.row_no) hit)`);
  const terms=bind(queryTerms(input.text),'text[]'),personal=bind(input.personalized_entity_ids??[],'text[]');
  const hits=(content:string)=>`(SELECT count(*)::float8*10 FROM unnest(${terms}) term WHERE strpos(${content},term)>0)`;
  const nodeScore=`${hits('n.search_text')}+CASE WHEN ${nodeId}=ANY(${personal}) THEN 1.5::float8 ELSE 0::float8 END
    +GREATEST(0::float8,1::float8-n.depth*0.02::float8)+CASE WHEN n.entity_kind='component' THEN 0.1::float8 ELSE 0::float8 END`;
  const hierarchy=input.scope==='subtree'||input.scope==='ancestors';
  scopes.push(`ranked AS (
    SELECT 'node'::text kind,n.row_no,n.node_key local_key,'0:'||n.node_key item_key,
      ${hierarchy?'n.depth::bigint':'0::bigint'} rank_depth,${nodeScore} score
    FROM snapshot_directory_nodes n WHERE ${nodeBase} AND n.row_no IN (SELECT row_no FROM chosen)
    UNION ALL SELECT 'edge',e.row_no,e.edge_key,'1:'||e.edge_key,${hierarchy?'9007199254740991::bigint':'0::bigint'},${hits('e.search_text')}+e.weight
    FROM snapshot_directory_edges e WHERE ${edgeConditions.join(' AND ')})`);
  const cursor=bind(cursorKey(input.cursor));scopes.push(`anchor AS (SELECT rank_depth,score,item_key FROM ranked WHERE item_key=${cursor} LIMIT 1)`);
  const count=bind(limitOf(input.limit)+1,'int');
  return (await db.query(`WITH RECURSIVE ${scopes.join(',\n')}
    SELECT kind,row_no,local_key,item_key,score FROM ranked r WHERE NOT EXISTS(SELECT 1 FROM anchor) OR EXISTS(
      SELECT 1 FROM anchor a WHERE (r.rank_depth,-r.score,r.item_key COLLATE "C")>(a.rank_depth,-a.score,a.item_key COLLATE "C"))
    ORDER BY rank_depth,score DESC,item_key COLLATE "C" LIMIT ${count}`,values)).rows;
}

type Link={evidence_no:number;evidence_id:string;owner_kind:0|1;owner_no:number;owner_key:string;role:0|1};
async function selectedEvidence(db:PoolClient,id:string,owners:Candidate[],limits?:{node:number;edge:number}){
  let selected:Link[]=[];let truncated=false;
  for(const [kind,no] of [['node',0],['edge',1]] as const){
    const keys=owners.filter(row=>row.kind===kind).map(row=>row.row_no);if(!keys.length)continue;
    const count=limits?Math.max(0,Math.min(100,Math.floor(limits[kind]))):null;
    const found=await db.query<Link>(`SELECT hit.*,owner.key AS owner_no,$3::smallint AS owner_kind
      FROM unnest($2::int[]) AS owner(key) CROSS JOIN LATERAL (
        SELECT l.evidence_no,e.evidence_id,array_agg(l.role) roles FROM snapshot_directory_evidence_links l
        JOIN snapshot_directory_evidence e ON e.directory_id=l.directory_id AND e.row_no=l.evidence_no
        WHERE l.directory_id=$1 AND l.owner_kind=$3 AND l.owner_no=owner.key
        GROUP BY l.evidence_no,e.evidence_id ORDER BY e.evidence_id COLLATE "C" ${count===null?'':'LIMIT $4'}
      ) hit`,count===null?[id,keys,no]:[id,keys,no,count+1]);
    const seen=new Map<number,number>();
    for(const row of found.rows as (Link&{roles:Array<0|1>})[]){
      const used=seen.get(row.owner_no)??0;
      if(count!==null&&used>=count){truncated=true;continue;}
      seen.set(row.owner_no,used+1);
      const owner=owners.find(candidate=>candidate.kind===kind&&candidate.row_no===row.owner_no)!;
      for(const role of row.roles)selected.push({...row,owner_key:owner.local_key,role});
    }
  }
  const ordinals=[...new Set(selected.map(row=>row.evidence_no))].sort((left,right)=>left-right);
  if(!limits&&ordinals.length){
    selected=(await db.query<Link>(`SELECT l.*,e.evidence_id,COALESCE(n.node_key,edge.edge_key) owner_key
      FROM snapshot_directory_evidence_links l JOIN snapshot_directory_evidence e ON e.directory_id=l.directory_id AND e.row_no=l.evidence_no
      LEFT JOIN snapshot_directory_nodes n ON n.directory_id=l.directory_id AND l.owner_kind=0 AND n.row_no=l.owner_no
      LEFT JOIN snapshot_directory_edges edge ON edge.directory_id=l.directory_id AND l.owner_kind=1 AND edge.row_no=l.owner_no
      WHERE l.directory_id=$1 AND l.evidence_no=ANY($2::int[])`,[id,ordinals])).rows;
  }
  return{ordinals,links:selected,truncated};
}
