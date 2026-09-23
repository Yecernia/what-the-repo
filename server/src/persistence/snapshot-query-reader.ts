import { connectWithAbort } from '../scheduling/permits.js';
import { executionErrorCode } from '../services/execution-error.js';
import { serviceError } from '../services/errors.js';
import type { Pool, PoolClient } from 'pg';
import { hasNodeScope, cursorKey, pageSnapshotQueryCandidates, rankSnapshotQueryCandidates, selectSnapshotQueryCandidates,
  type QueryItem, type SnapshotQueryDirectory, type SnapshotQueryInput, type SnapshotQueryResult } from '../domain/snapshot-query.js';
import { queryTerms } from '../domain/query-relevance.js';


const NODE_FIELDS = "public_snapshot_key,snapshot_id,node_key,node_id,node_kind,entity_kind,parent_entity_id,depth,label,name,responsibility,path,language,layer_id,layer_name,certainty,lifecycle_status,'{}'::jsonb AS payload";
const EDGE_FIELDS = "public_snapshot_key,snapshot_id,edge_key,edge_id,edge_kind,source_node_key,target_node_key,relation_kind,label,description,certainty,weight,lifecycle_status,'{}'::jsonb AS payload";

type Request = { publicKey: string; snapshotId: string; query: SnapshotQueryInput; signal?: AbortSignal };
const limitOf = (n?: number) => Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n!))) : 20;

/** Rank scalar candidate keys inside PostgreSQL; hydrate only a page and its evidence. */
export async function readSnapshotQuery(pool: Pool, input: Request): Promise<SnapshotQueryResult | null> {
  const db = await connectWithAbort<PoolClient>(pool, input.signal);
  let released=false;
  const release=(destroy=false)=>{if(!released){released=true;db.release(destroy);}};
  const abort=()=>release(true);
  input.signal?.addEventListener('abort',abort,{once:true});
  try {
    input.signal?.throwIfAborted();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='1s'");
    const meta = await db.query('SELECT snapshot_id,directory_digest,directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1', [input.publicKey]);
    if (!meta.rows[0] || meta.rows[0].snapshot_id !== input.snapshotId) { await db.query('COMMIT'); return null; }
    const directory: SnapshotQueryDirectory = { public_snapshot_key: input.publicKey, snapshot_id: input.snapshotId,
      digest: meta.rows[0].directory_digest, nodes: [], edges: [], evidence: [], evidence_links: [],
      layers: [], value_points: [], memberships: [], projections: [], aggregates: [] };
    // Preserve optional legacy metadata only for callers that actually request it.
    const complexText = Boolean(input.query.text && !/^[a-z0-9_\-\u3400-\u9fff\s./]*$/iu.test(input.query.text));
    for (const [field, table, order] of [
      ['layers','layers','layer_id'], ['value_points','value_points','value_point_id'],
      ['memberships','overlay_memberships','overlay_id,entity_id,relation_id,role'],
      ['projections','projection_nodes','projection_kind,projection_node_id'],
      ['aggregates','projection_edges','projection_kind,projection_edge_id'],
    ] as const) if (input.query.include_metadata !== false || (complexText && input.query.projection && field === 'projections')) (directory[field] as unknown[]) = (await db.query(`SELECT * FROM snapshot_query_${table} WHERE public_snapshot_key=$1 AND snapshot_id=$2 ORDER BY ${order}`, [input.publicKey,input.snapshotId])).rows;
    directory.memberships = directory.memberships.map(row => ({ ...row, relation_id: row.relation_id || null }));
    let items: QueryItem[];
    // JSON-syntax/escape searches retain exact JS semantics; never silently drop candidates.
    if (complexText) {
      directory.nodes = (await db.query('SELECT * FROM snapshot_query_nodes WHERE public_snapshot_key=$1 AND snapshot_id=$2 ORDER BY node_key',[input.publicKey,input.snapshotId])).rows;
      directory.edges = (await db.query('SELECT * FROM snapshot_query_edges WHERE public_snapshot_key=$1 AND snapshot_id=$2 ORDER BY edge_key',[input.publicKey,input.snapshotId])).rows;
      const selected = selectSnapshotQueryCandidates(directory, input.query);
      const all = rankSnapshotQueryCandidates(selected.nodes, selected.edges, input.query);
      const after = all.findIndex(item => item.key === cursorKey(input.query.cursor));
      items = all.slice(after + 1, after + 2 + limitOf(input.query.limit));
    } else {
      const ranked = await rankedCandidates(db, input, meta.rows[0].directory_id);
      const nodeKeys = ranked.filter(r => r.kind === 'node').map(r => r.local_key);
      const edgeKeys = ranked.filter(r => r.kind === 'edge').map(r => r.local_key);
      directory.nodes = nodeKeys.length ? (await db.query(`SELECT ${input.query.include_payload === false ? NODE_FIELDS : '*'} FROM snapshot_query_nodes WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND node_key=ANY($3::text[])`,[input.publicKey,input.snapshotId,nodeKeys])).rows : [];
      directory.edges = edgeKeys.length ? (await db.query(`SELECT ${input.query.include_payload === false ? EDGE_FIELDS : '*'} FROM snapshot_query_edges WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND edge_key=ANY($3::text[])`,[input.publicKey,input.snapshotId,edgeKeys])).rows : [];
      const nodes = new Map(directory.nodes.map(r=>[r.node_key,r])), edges = new Map(directory.edges.map(r=>[r.edge_key,r]));
      items = ranked.map(r => ({key:r.item_key,kind:r.kind,relevance:r.score,row:r.kind==='node'?nodes.get(r.local_key):edges.get(r.local_key)} as QueryItem));
      if (items.some(item=>!item.row)) throw new Error('snapshot_query_candidate_missing');
    }
    const candidates = items.slice(0,limitOf(input.query.limit));
    const nodeKeys = candidates.filter(item=>item.kind==='node').map(item=>(item.row as SnapshotQueryDirectory['nodes'][number]).node_key);
    const edgeKeys = candidates.filter(item=>item.kind==='edge').map(item=>(item.row as SnapshotQueryDirectory['edges'][number]).edge_key);
    const links = input.query.evidence_per_owner ? await boundedEvidenceLinks(db,meta.rows[0].directory_id,input.publicKey,nodeKeys,edgeKeys,input.query.evidence_per_owner) : await db.query(`SELECT $1::text AS public_snapshot_key,l.evidence_id,l.owner_kind,l.owner_key,l.role
      FROM snapshot_directory_evidence_links l WHERE directory_id=$2 AND owner_kind='node' AND owner_key=ANY($3::text[])
      UNION ALL SELECT $1::text,l.evidence_id,l.owner_kind,l.owner_key,l.role
      FROM snapshot_directory_evidence_links l WHERE directory_id=$2 AND owner_kind='edge' AND owner_key=ANY($4::text[])`,
      [input.publicKey,meta.rows[0].directory_id,nodeKeys,edgeKeys]);
    const ids = [...new Set(links.rows.map(row=>row.evidence_id))];
    if ('truncated' in links) (directory as typeof directory & {evidence_truncated:boolean}).evidence_truncated = Boolean(links.truncated);
    if (ids.length) {
      directory.evidence = (await db.query('SELECT * FROM snapshot_query_evidence WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND evidence_id=ANY($3::text[]) ORDER BY evidence_id',[input.publicKey,input.snapshotId,ids])).rows;
      directory.evidence_links = input.query.evidence_per_owner ? links.rows : (await db.query('SELECT * FROM snapshot_query_evidence_links WHERE public_snapshot_key=$1 AND evidence_id=ANY($2::text[]) ORDER BY evidence_id,owner_kind,owner_key,role',[input.publicKey,ids])).rows;
    }
    const result = pageSnapshotQueryCandidates(directory,{...input.query,cursor:null},items);
    await db.query('COMMIT'); return result;
  } catch(error) {
    if (!released) await db.query('ROLLBACK').catch(()=>undefined);
    if (input.signal?.aborted) throw input.signal.reason;
    const code=executionErrorCode(error); if(code) throw serviceError(code,code,503);
    throw error;
  } finally {input.signal?.removeEventListener('abort',abort);release();}
}

async function rankedCandidates(db: PoolClient, request: Request, directoryId: string): Promise<Array<{kind:'node'|'edge';local_key:string;item_key:string;score:number}>> {
  const input=request.query, values:unknown[]=[directoryId];
  const bind=(value:unknown,type='text')=>{values.push(value);return `$${values.length}::${type}`;};
  const nodeBase='n.directory_id=$1';
  const edgeBase='e.directory_id=$1';
  const ids=[...new Set([...(input.entity_ids??[]),...(input.component_ids??[])])];
  const idParam=ids.length?bind(ids,'text[]'):null;
  const nodeConditions=[nodeBase];
  const scopes:string[]=[];
  if(idParam){
    const matches=`(n.node_id=ANY(${idParam}) OR n.node_key=ANY(${idParam}))`;
    if(!input.scope||input.scope==='self')nodeConditions.push(matches);
    else if(input.scope==='neighbors'){
      scopes.push(`scope_nodes AS (SELECT DISTINCT unnest(ARRAY[e.source_node_key,e.target_node_key]) AS node_key FROM snapshot_directory_edges e WHERE ${edgeBase} AND
        (e.source_node_key=ANY(${idParam}) OR e.target_node_key=ANY(${idParam}) OR regexp_replace(e.source_node_key,'^[^:]+:','')=ANY(${idParam}) OR regexp_replace(e.target_node_key,'^[^:]+:','')=ANY(${idParam})))`);
      nodeConditions.push('n.node_key IN (SELECT node_key FROM scope_nodes)');
    }else{
      scopes.push(`scope_nodes AS (SELECT n.node_key,n.node_id,n.parent_entity_id FROM snapshot_directory_nodes n WHERE ${nodeBase} AND ${matches}
        UNION SELECT n.node_key,n.node_id,n.parent_entity_id FROM snapshot_directory_nodes n JOIN scope_nodes s ON ${input.scope==='ancestors'?'n.node_id=s.parent_entity_id':'n.parent_entity_id=s.node_id'} WHERE ${nodeBase})`);
      nodeConditions.push('n.node_key IN (SELECT node_key FROM scope_nodes)');
    }
  }
  if(input.paths?.length){const p=bind(input.paths,'text[]');
    const like=bind(input.paths.map(path=>'%'+path.toLowerCase().replace(/[\\%_]/g, ch=>'\\'+ch)+'%'),'text[]');
    nodeConditions.push(`n.search_text LIKE ANY(${like})`, `EXISTS(SELECT 1 FROM unnest(${p}) p WHERE strpos(COALESCE(n.path,''),p)>0)`);
  }
  if(input.languages?.length)nodeConditions.push(`lower(n.language)=ANY(${bind(input.languages.map(v=>v.toLowerCase()),'text[]')})`);
  if(input.symbol_ids?.length){const p=bind(input.symbol_ids,'text[]');nodeConditions.push(`(n.node_id=ANY(${p}) OR n.node_key=ANY(${p}))`);}
  if(input.entity_kinds?.length)nodeConditions.push(`n.entity_kind=ANY(${bind(input.entity_kinds,'text[]')})`);
  if(input.depth!==undefined)nodeConditions.push(`n.depth<=${bind(Math.max(0,Math.min(100,Math.floor(input.depth))),'int')}`);
  if(input.projection)nodeConditions.push(`EXISTS(SELECT 1 FROM snapshot_directory_projection_nodes p WHERE p.directory_id=$1 AND p.entity_id=n.node_id AND p.projection_kind=${bind(input.projection)})`);
  const edgeConditions=[edgeBase];
  const text=input.text?.trim().toLowerCase();
  if(text){
    // LIKE is indexable with pg_trgm; escape wildcard syntax to retain literal
    // substring semantics (including identifiers containing underscores).
    const p=bind('%'+text.replace(/[\\%_]/g,'\\$&')+'%');
    nodeConditions.push(`n.search_text LIKE ${p}`);
    edgeConditions.push(`e.search_text LIKE ${p}`);
  }
  if(input.relation_kinds?.length)edgeConditions.push(`e.relation_kind=ANY(${bind(input.relation_kinds,'text[]')})`);
  scopes.push(`seed AS (SELECT n.node_key FROM snapshot_directory_nodes n WHERE ${nodeConditions.join(' AND ')})`);
  const hops=Math.max(0,Math.min(2,Math.floor(input.expand_hops??0)));
  if(hops){
    scopes.push(`walked(node_key,hop) AS (SELECT node_key,0 FROM seed UNION
      SELECT endpoint.node_key,w.hop+1 FROM walked w JOIN snapshot_directory_edges e ON ${edgeBase} AND (e.source_node_key=w.node_key OR e.target_node_key=w.node_key)
      CROSS JOIN LATERAL unnest(ARRAY[e.source_node_key,e.target_node_key]) AS endpoint(node_key) WHERE w.hop<${hops})`);
    scopes.push('chosen AS (SELECT DISTINCT node_key FROM walked)');
    edgeConditions.splice(0,edgeConditions.length,edgeBase,'e.edge_key IN (SELECT edge_key FROM incident_edges)');
  }else{
    scopes.push('chosen AS (SELECT node_key FROM seed)');
    if(hasNodeScope(input))edgeConditions.push('e.edge_key IN (SELECT edge_key FROM incident_edges)');
  }
  if (hops || hasNodeScope(input)) {
    // Parameterize each endpoint lookup. OR over two subqueries otherwise turns
    // a one-node request into a full scan of every edge in a large directory.
    scopes.push(`incident_edges AS MATERIALIZED (SELECT DISTINCT hit.edge_key FROM chosen c
      CROSS JOIN LATERAL (
        SELECT e.edge_key FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.source_node_key=c.node_key
        UNION ALL
        SELECT e.edge_key FROM snapshot_directory_edges e WHERE ${edgeBase} AND e.target_node_key=c.node_key
      ) hit)`);
  }
  const terms=bind(queryTerms(input.text),'text[]');
  // Ranking excludes the local key. Terms contain no spaces, so skipped empty
  // node fields do not change term matches. Never deserialize payload to rank.
  const nodeText="substr(n.search_text,CASE WHEN n.node_key='' THEN 1 ELSE char_length(lower(n.node_key))+2 END)";
  const edgeText="substr(e.search_text,char_length(lower(e.edge_key))+2)";
  const hits=(content:string)=>`(SELECT count(*)::float8*10 FROM unnest(${terms}) term WHERE strpos(${content},term)>0)`;
  const personal=bind(input.personalized_entity_ids??[],'text[]');
  const nodeScore=`${hits(nodeText)}+CASE WHEN n.node_id=ANY(${personal}) THEN 1.5::float8 ELSE 0::float8 END+GREATEST(0::float8,1::float8-n.depth*0.02::float8)+CASE WHEN n.entity_kind='component' THEN 0.1::float8 ELSE 0::float8 END`;
  const hierarchy=input.scope==='subtree'||input.scope==='ancestors';
  scopes.push(`ranked AS (
    SELECT 'node'::text AS kind,n.node_key AS local_key,'0:'||n.node_key AS item_key,${hierarchy?'n.depth::bigint':'0::bigint'} AS rank_depth,${nodeScore} AS score
      FROM snapshot_directory_nodes n WHERE ${nodeBase} AND n.node_key IN (SELECT node_key FROM chosen)
    UNION ALL
    SELECT 'edge',e.edge_key,'1:'||e.edge_key,${hierarchy?'9007199254740991::bigint':'0::bigint'},${hits(edgeText)}+e.weight
      FROM snapshot_directory_edges e WHERE ${edgeConditions.join(' AND ')}
  )`);
  const cursor=bind(cursorKey(input.cursor));
  scopes.push(`anchor AS (SELECT rank_depth,score,item_key FROM ranked WHERE item_key=${cursor} LIMIT 1)`);
  const count=bind(limitOf(input.limit)+1,'int');
  const result=await db.query(`WITH RECURSIVE ${scopes.join(',\n')}
    SELECT kind,local_key,item_key,score FROM ranked r
    WHERE NOT EXISTS(SELECT 1 FROM anchor) OR EXISTS(SELECT 1 FROM anchor a
      WHERE (r.rank_depth,-r.score,r.item_key COLLATE "C")>(a.rank_depth,-a.score,a.item_key COLLATE "C"))
    ORDER BY rank_depth,score DESC,item_key COLLATE "C" LIMIT ${count}`,values);
  return result.rows;
}

async function boundedEvidenceLinks(db: PoolClient, directoryId: string, publicKey: string,
  nodes: string[], edges: string[], limits: {node:number;edge:number}) {
  const rows: SnapshotQueryDirectory['evidence_links'] = [];
  let truncated = false;
  for (const [kind,keys] of [['node',nodes],['edge',edges]] as const) {
    if (!keys.length) continue;
    const count = Math.max(0,Math.min(100,Math.floor(limits[kind])));
    // Read each owner's links once. Joining the selected IDs back to this table
    // lets the planner put role rows outside the LIMIT subquery, recomputing its
    // scan/sort once per role (quadratic work for evidence-heavy components).
    // Group roles with the distinct ID before limiting, then expand only that page.
    const result = await db.query(`SELECT $1::text AS public_snapshot_key,hit.evidence_id,$4::text AS owner_kind,owner.key AS owner_key,roles.role
      FROM unnest($3::text[]) AS owner(key)
      CROSS JOIN LATERAL (SELECT evidence_id COLLATE "C" AS evidence_id,array_agg(role) AS roles FROM snapshot_directory_evidence_links
        WHERE directory_id=$2 AND owner_kind=$4 AND owner_key=owner.key
        GROUP BY evidence_id COLLATE "C"
        ORDER BY evidence_id COLLATE "C" LIMIT $5) hit
      CROSS JOIN LATERAL unnest(hit.roles) AS roles(role)
      ORDER BY owner.key COLLATE "C",hit.evidence_id COLLATE "C",roles.role COLLATE "C"`,[publicKey,directoryId,keys,kind,count+1]);
    const seen = new Map<string,Set<string>>();
    for (const row of result.rows) {
      const ids = seen.get(row.owner_key) ?? new Set<string>(); seen.set(row.owner_key,ids);
      if (!ids.has(row.evidence_id) && ids.size >= count) { truncated=true; continue; }
      ids.add(row.evidence_id); rows.push(row);
    }
    // The extra distinct evidence ID detects omitted evidence, not duplicate roles.
  }
  return {rows,truncated};
}
