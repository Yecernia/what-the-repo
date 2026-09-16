import type { Pool, PoolClient } from 'pg';
import { cursorKey, pageSnapshotQueryCandidates, rankSnapshotQueryCandidates, selectSnapshotQueryCandidates,
  type QueryItem, type SnapshotQueryDirectory, type SnapshotQueryInput, type SnapshotQueryResult } from '../domain/snapshot-query.js';
import { queryTerms } from '../domain/query-relevance.js';

type Request = { publicKey: string; snapshotId: string; query: SnapshotQueryInput };
const limitOf = (n?: number) => Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n!))) : 20;

/** Rank scalar candidate keys inside PostgreSQL; hydrate only a page and its evidence. */
export async function readSnapshotQuery(pool: Pool, input: Request): Promise<SnapshotQueryResult | null> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const meta = await db.query('SELECT snapshot_id,directory_digest FROM snapshot_query_directories WHERE public_snapshot_key=$1', [input.publicKey]);
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
      const ranked = await rankedCandidates(db, input);
      const nodeKeys = ranked.filter(r => r.kind === 'node').map(r => r.local_key);
      const edgeKeys = ranked.filter(r => r.kind === 'edge').map(r => r.local_key);
      directory.nodes = nodeKeys.length ? (await db.query('SELECT * FROM snapshot_query_nodes WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND node_key=ANY($3::text[])',[input.publicKey,input.snapshotId,nodeKeys])).rows : [];
      directory.edges = edgeKeys.length ? (await db.query('SELECT * FROM snapshot_query_edges WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND edge_key=ANY($3::text[])',[input.publicKey,input.snapshotId,edgeKeys])).rows : [];
      const nodes = new Map(directory.nodes.map(r=>[r.node_key,r])), edges = new Map(directory.edges.map(r=>[r.edge_key,r]));
      items = ranked.map(r => ({key:r.item_key,kind:r.kind,relevance:r.score,row:r.kind==='node'?nodes.get(r.local_key):edges.get(r.local_key)} as QueryItem));
      if (items.some(item=>!item.row)) throw new Error('snapshot_query_candidate_missing');
    }
    const candidates = items.slice(0,limitOf(input.query.limit));
    const nodeKeys = candidates.filter(item=>item.kind==='node').map(item=>(item.row as SnapshotQueryDirectory['nodes'][number]).node_key);
    const edgeKeys = candidates.filter(item=>item.kind==='edge').map(item=>(item.row as SnapshotQueryDirectory['edges'][number]).edge_key);
    const links = await db.query('SELECT * FROM snapshot_query_evidence_links WHERE public_snapshot_key=$1 AND ((owner_kind=\'node\' AND owner_key=ANY($2::text[])) OR (owner_kind=\'edge\' AND owner_key=ANY($3::text[])))',[input.publicKey,nodeKeys,edgeKeys]);
    const ids = [...new Set(links.rows.map(row=>row.evidence_id))];
    if (ids.length) {
      directory.evidence = (await db.query('SELECT * FROM snapshot_query_evidence WHERE public_snapshot_key=$1 AND snapshot_id=$2 AND evidence_id=ANY($3::text[]) ORDER BY evidence_id',[input.publicKey,input.snapshotId,ids])).rows;
      directory.evidence_links = (await db.query('SELECT * FROM snapshot_query_evidence_links WHERE public_snapshot_key=$1 AND evidence_id=ANY($2::text[]) ORDER BY evidence_id,owner_kind,owner_key,role',[input.publicKey,ids])).rows;
    }
    const result = pageSnapshotQueryCandidates(directory,{...input.query,cursor:null},items);
    await db.query('COMMIT'); return result;
  } catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;} finally {db.release();}
}

async function rankedCandidates(db: PoolClient, request: Request): Promise<Array<{kind:'node'|'edge';local_key:string;item_key:string;score:number}>> {
  const input=request.query, values:unknown[]=[request.publicKey,request.snapshotId];
  const bind=(value:unknown,type='text')=>{values.push(value);return `$${values.length}::${type}`;};
  const nodeBase='n.public_snapshot_key=$1 AND n.snapshot_id=$2';
  const edgeBase='e.public_snapshot_key=$1 AND e.snapshot_id=$2';
  const ids=[...new Set([...(input.entity_ids??[]),...(input.component_ids??[])])];
  const idParam=ids.length?bind(ids,'text[]'):null;
  const nodeConditions=[nodeBase];
  const scopes:string[]=[];
  if(idParam){
    const matches=`(n.node_id=ANY(${idParam}) OR n.node_key=ANY(${idParam}))`;
    if(!input.scope||input.scope==='self')nodeConditions.push(matches);
    else if(input.scope==='neighbors'){
      scopes.push(`scope_nodes AS (SELECT DISTINCT unnest(ARRAY[e.source_node_key,e.target_node_key]) AS node_key FROM snapshot_query_edges e WHERE ${edgeBase} AND
        (e.source_node_key=ANY(${idParam}) OR e.target_node_key=ANY(${idParam}) OR regexp_replace(e.source_node_key,'^[^:]+:','')=ANY(${idParam}) OR regexp_replace(e.target_node_key,'^[^:]+:','')=ANY(${idParam})))`);
      nodeConditions.push('n.node_key IN (SELECT node_key FROM scope_nodes)');
    }else{
      scopes.push(`scope_nodes AS (SELECT n.node_key,n.node_id,n.parent_entity_id FROM snapshot_query_nodes n WHERE ${nodeBase} AND ${matches}
        UNION SELECT n.node_key,n.node_id,n.parent_entity_id FROM snapshot_query_nodes n JOIN scope_nodes s ON ${input.scope==='ancestors'?'n.node_id=s.parent_entity_id':'n.parent_entity_id=s.node_id'} WHERE ${nodeBase})`);
      nodeConditions.push('n.node_key IN (SELECT node_key FROM scope_nodes)');
    }
  }
  if(input.paths?.length){const p=bind(input.paths,'text[]');nodeConditions.push(`EXISTS(SELECT 1 FROM unnest(${p}) p WHERE strpos(COALESCE(n.path,''),p)>0)`);}
  if(input.languages?.length)nodeConditions.push(`lower(n.language)=ANY(${bind(input.languages.map(v=>v.toLowerCase()),'text[]')})`);
  if(input.symbol_ids?.length){const p=bind(input.symbol_ids,'text[]');nodeConditions.push(`(n.node_id=ANY(${p}) OR n.node_key=ANY(${p}))`);}
  if(input.entity_kinds?.length)nodeConditions.push(`n.entity_kind=ANY(${bind(input.entity_kinds,'text[]')})`);
  if(input.depth!==undefined)nodeConditions.push(`n.depth<=${bind(Math.max(0,Math.min(100,Math.floor(input.depth))),'int')}`);
  if(input.projection)nodeConditions.push(`EXISTS(SELECT 1 FROM snapshot_query_projection_nodes p WHERE p.public_snapshot_key=$1 AND p.snapshot_id=$2 AND p.entity_id=n.node_id AND p.projection_kind=${bind(input.projection)})`);
  const edgeConditions=[edgeBase];
  const text=input.text?.trim().toLowerCase();
  if(text){
    const p=bind(text);
    const fields=['n.node_key','n.node_id','n.name','n.label','n.responsibility','n.path','n.payload::text'].map(f=>`NULLIF(${f},'')`);
    nodeConditions.push(`strpos(lower(concat_ws(' ',${fields.join(',')})),${p})>0`);
    edgeConditions.push(`strpos(lower(concat_ws(' ',e.edge_key,e.edge_id,e.relation_kind,e.label,e.description,e.source_node_key,e.target_node_key)),${p})>0`);
  }
  if(input.relation_kinds?.length)edgeConditions.push(`e.relation_kind=ANY(${bind(input.relation_kinds,'text[]')})`);
  scopes.push(`seed AS (SELECT n.node_key FROM snapshot_query_nodes n WHERE ${nodeConditions.join(' AND ')})`);
  const hops=Math.max(0,Math.min(2,Math.floor(input.expand_hops??0)));
  if(hops){
    scopes.push(`walked(node_key,hop) AS (SELECT node_key,0 FROM seed UNION
      SELECT endpoint.node_key,w.hop+1 FROM walked w JOIN snapshot_query_edges e ON ${edgeBase} AND (e.source_node_key=w.node_key OR e.target_node_key=w.node_key)
      CROSS JOIN LATERAL unnest(ARRAY[e.source_node_key,e.target_node_key]) AS endpoint(node_key) WHERE w.hop<${hops})`);
    scopes.push('chosen AS (SELECT DISTINCT node_key FROM walked)');
    edgeConditions.splice(0,edgeConditions.length,edgeBase,'(e.source_node_key IN (SELECT node_key FROM chosen) OR e.target_node_key IN (SELECT node_key FROM chosen))');
  }else{
    scopes.push('chosen AS (SELECT node_key FROM seed)');
    if(ids.length||input.depth!==undefined||input.projection)edgeConditions.push('(e.source_node_key IN (SELECT node_key FROM chosen) OR e.target_node_key IN (SELECT node_key FROM chosen))');
  }
  const terms=bind(queryTerms(input.text),'text[]');
  const nodeText="lower(concat_ws(' ',n.node_id,n.name,n.label,n.responsibility,COALESCE(n.path,''),n.payload::text))";
  const edgeText="lower(concat_ws(' ',e.edge_id,e.relation_kind,e.label,e.description,e.source_node_key,e.target_node_key))";
  const hits=(content:string)=>`(SELECT count(*)::float8*10 FROM unnest(${terms}) term WHERE strpos(${content},term)>0)`;
  const personal=bind(input.personalized_entity_ids??[],'text[]');
  const nodeScore=`${hits(nodeText)}+CASE WHEN n.node_id=ANY(${personal}) THEN 1.5::float8 ELSE 0::float8 END+GREATEST(0::float8,1::float8-n.depth*0.02::float8)+CASE WHEN n.entity_kind='component' THEN 0.1::float8 ELSE 0::float8 END`;
  const hierarchy=input.scope==='subtree'||input.scope==='ancestors';
  scopes.push(`ranked AS (
    SELECT 'node'::text AS kind,n.node_key AS local_key,'0:'||n.node_key AS item_key,${hierarchy?'n.depth::bigint':'0::bigint'} AS rank_depth,${nodeScore} AS score
      FROM snapshot_query_nodes n WHERE ${nodeBase} AND n.node_key IN (SELECT node_key FROM chosen)
    UNION ALL
    SELECT 'edge',e.edge_key,'1:'||e.edge_key,${hierarchy?'9007199254740991::bigint':'0::bigint'},${hits(edgeText)}+e.weight
      FROM snapshot_query_edges e WHERE ${edgeConditions.join(' AND ')}
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
