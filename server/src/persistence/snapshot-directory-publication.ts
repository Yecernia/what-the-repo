import type { Pool, PoolClient } from 'pg';
import { nodeSearchText, edgeSearchText, type SnapshotQueryDirectorySource } from '../domain/snapshot-query.js';
import { insertSnapshotRows, newSnapshotRowWriteMetrics } from './postgres-snapshot-rows.js';
import { writeDirectoryObjects } from './directory-objects.js';
import type { SnapshotObjectStore } from './snapshot-object-store.js';
import { controlPoolFor } from './control-pool.js';

const STAGING_TTL_SECONDS = 3 * 60 * 60;
export interface DirectoryStagingOptions {
  parallelism: number;
  objectStore: SnapshotObjectStore;
  beforeBatch?: (client: PoolClient) => Promise<void>;
  timings?: Record<string, number>;
}

/** Full response rows live in immutable object chunks; SQL indexes carry only
 * identity, traversal/filter/search fields and the zero-based object ordinal. */
export async function stageSnapshotQueryDirectory(pool: Pool, client: PoolClient,
  directory: SnapshotQueryDirectorySource, options: DirectoryStagingOptions): Promise<string> {
  // Ownership must survive rollback of the publishing transaction, including
  // serial writes with a one-connection business pool. Production registers a
  // separately budgeted control pool for these short metadata commits.
  const parallel=options.parallelism>0, owner=controlPoolFor(pool);
  const inserted=await owner.query<{directory_id:string}>(`INSERT INTO snapshot_directory_generations
    (public_snapshot_key,snapshot_id,staging_expires_at,logical_counts)
    VALUES ($1,$2,clock_timestamp()+make_interval(secs=>$3),$4::jsonb) RETURNING directory_id`,
    [directory.public_snapshot_key,directory.snapshot_id,STAGING_TTL_SECONDS,JSON.stringify({
      nodes:directory.nodes.length,edges:directory.edges.length,evidence:directory.evidence.length,
      evidence_links:directory.evidence_links.length,layers:directory.layers.length,value_points:directory.value_points.length,
      overlay_memberships:directory.memberships?.length??0,projection_nodes:directory.projections?.length??0,
      projection_edges:directory.aggregates?.length??0})]);
  const directoryId=inserted.rows[0]?.directory_id;
  if(!directoryId)throw new Error('snapshot_query_directory_identity_missing');
  try {
    await writeDirectoryObjects(options.objectStore,directory,directoryId,async (manifest,planned)=>{
      if(planned)await owner.query('INSERT INTO snapshot_directory_object_intents(directory_id,object_key) VALUES ($1,$2)',[directoryId,planned.key]);
      else {
        await owner.query('UPDATE snapshot_directory_generations SET object_manifest=$2::jsonb WHERE directory_id=$1',
          [directoryId,JSON.stringify(manifest)]);
        // The independently committed full manifest now owns every key. Retire
        // intents here, before entering the constant-sized publication fence.
        await owner.query('DELETE FROM snapshot_directory_object_intents WHERE directory_id=$1',[directoryId]);
      }
    });
    // Empty directories still need a valid, complete manifest.
    // Identity maps hold compact keys/ordinals, never duplicate response payloads.
    const nodes=new Map<string,number>(), nodeIds=new Map<string,number>(), edges=new Map<string,number>(), evidence=new Map<string,number>();
    let ordinal=0;
    for(const row of directory.nodes){nodes.set(row.node_key,ordinal);nodeIds.set(row.node_id,ordinal++);}
    ordinal=0;for(const row of directory.edges)edges.set(row.edge_key,ordinal++);
    ordinal=0;for(const row of directory.evidence)evidence.set(row.evidence_id,ordinal++);
    const projections=new Map<string,Set<string>>();
    for(const row of directory.projections??[]){const kinds=projections.get(row.entity_id)??new Set();kinds.add(row.projection_kind);projections.set(row.entity_id,kinds);}
    const failed=new AbortController();
    const write=async(kind:'nodes'|'edges'|'evidence'|'evidence_links',columns:string[],rows:Iterable<object>)=>{
      const db=parallel?await pool.connect():client;
      const metrics=newSnapshotRowWriteMetrics();
      try{
        if(parallel)await db.query('BEGIN');
        const child=await db.query<{child_name:string}>('SELECT public.stage_snapshot_directory_child($1::bigint,$2::text) AS child_name',[directoryId,kind]);
        const table=child.rows[0]?.child_name;
        if(table!==`snapshot_directory_${kind}_g${directoryId}`)throw new Error('snapshot_directory_child_identity_invalid');
        await insertSnapshotRows(db,table,['directory_id',...columns],rows,row=>({...row,directory_id:directoryId}),async()=>{
          failed.signal.throwIfAborted();await options.beforeBatch?.(db);
        },metrics);
        await options.beforeBatch?.(db);
        const indexStarted=performance.now();
        try{await db.query('SELECT public.finish_snapshot_directory_child($1::bigint,$2::text,$3::bigint)',[directoryId,kind,metrics.rows]);}
        finally{if(options.timings)options.timings[`directory_${kind}_index_build_ms`]=performance.now()-indexStarted;}
        if(parallel)await db.query('COMMIT');
      }catch(error){failed.abort(error);if(parallel)await db.query('ROLLBACK').catch(()=>undefined);throw error;}
      finally{if(parallel)db.release();if(options.timings)for(const [key,value]of Object.entries(metrics))options.timings[`directory_${kind}_${key}`]=value;}
    };
    function* nodeRows(){let row_no=0;for(const row of directory.nodes)yield{
      row_no:row_no++,node_key:row.node_key,parent_no:row.parent_entity_id?nodeIds.get(row.parent_entity_id)??null:null,
      entity_kind:row.entity_kind,depth:row.depth,path:row.path,language:row.language?.toLowerCase()??null,
      search_text:nodeSearchText(row),projection_kinds:[...projections.get(row.node_id)??[]]};}
    const missing=new Map<string,number>();
    const endpoint=(key:string)=>{const present=nodes.get(key);if(present!==undefined)return present;let no=missing.get(key);if(no===undefined){no=-1-missing.size;missing.set(key,no);}return no;};
    function* edgeRows(){let row_no=0;for(const row of directory.edges)yield{
      row_no:row_no++,edge_key:row.edge_key,source_no:endpoint(row.source_node_key),target_no:endpoint(row.target_node_key),
      source_missing:nodes.has(row.source_node_key)?null:row.source_node_key,target_missing:nodes.has(row.target_node_key)?null:row.target_node_key,
      relation_kind:row.relation_kind,weight:row.weight,search_text:edgeSearchText(row)};}
    function* evidenceRows(){let row_no=0;for(const row of directory.evidence)yield{row_no:row_no++,evidence_id:row.evidence_id};}
    function* linkRows(){for(const row of directory.evidence_links){
      // Metadata owners live with metadata in COS; query evidence is attached to
      // selected nodes and edges only (the same public query contract).
      if(row.owner_kind!=='node'&&row.owner_kind!=='edge')continue;
      const owner_no=(row.owner_kind==='node'?nodes:edges).get(row.owner_key), evidence_no=evidence.get(row.evidence_id);
      if(owner_no===undefined||evidence_no===undefined)throw new Error('snapshot_directory_link_target_missing');
      yield{owner_kind:row.owner_kind==='node'?0:1,owner_no,evidence_no,role:row.role==='evidence'?0:1};
    }}
    const lanes=[
      ()=>write('nodes',['row_no','node_key','parent_no','entity_kind','depth','path','language','search_text','projection_kinds'],nodeRows()),
      ()=>write('edges',['row_no','edge_key','source_no','target_no','source_missing','target_missing','relation_kind','weight','search_text'],edgeRows()),
      async()=>{await write('evidence',['row_no','evidence_id'],evidenceRows());await write('evidence_links',['owner_kind','owner_no','evidence_no','role'],linkRows());},
    ];
    let next=0;
    const results=await Promise.allSettled(Array.from({length:parallel?Math.min(3,Math.max(1,Math.floor(options.parallelism))):1},async()=>{
      while(next<lanes.length&&!failed.signal.aborted)await lanes[next++]!();
    }));
    const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failure)throw failure.reason;
    return directoryId;
  }catch(error){
    await owner.query('INSERT INTO snapshot_directory_reclamation(directory_id) VALUES ($1) ON CONFLICT DO NOTHING',[directoryId]).catch(()=>undefined);
    throw error;
  }
}
/** Constant-sized final binding; no data-row insertion or deletion under the job lock. */
export async function bindSnapshotQueryDirectory(client: PoolClient, directory: SnapshotQueryDirectorySource, directoryId: string): Promise<void> {
  const candidate = await client.query(`UPDATE snapshot_directory_generations g SET staging_expires_at=NULL
    WHERE directory_id=$1 AND public_snapshot_key=$2 AND snapshot_id=$3
      AND NOT EXISTS(SELECT 1 FROM snapshot_directory_reclamation q WHERE q.directory_id=g.directory_id)
    RETURNING directory_id`,
    [directoryId,directory.public_snapshot_key,directory.snapshot_id]);
  if (!candidate.rowCount) throw new Error('snapshot_directory_generation_not_publishable');
  // The old version and its durable work item become retired atomically with the new pointer.
  await client.query(`INSERT INTO snapshot_directory_reclamation(directory_id)
    SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1 AND directory_id<>$2
    ON CONFLICT(directory_id) DO NOTHING`, [directory.public_snapshot_key,directoryId]);
  await client.query(
    `INSERT INTO snapshot_query_directories(public_snapshot_key,snapshot_id,schema_version,directory_digest,
       node_count,edge_count,evidence_count,layer_count,value_point_count,ready_at,directory_id)
     VALUES ($1,$2,3,$3,$4,$5,$6,$7,$8,clock_timestamp(),$9)
     ON CONFLICT(public_snapshot_key) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
       schema_version=EXCLUDED.schema_version,directory_digest=EXCLUDED.directory_digest,
       node_count=EXCLUDED.node_count,edge_count=EXCLUDED.edge_count,evidence_count=EXCLUDED.evidence_count,
       layer_count=EXCLUDED.layer_count,value_point_count=EXCLUDED.value_point_count,
       ready_at=EXCLUDED.ready_at,directory_id=EXCLUDED.directory_id`,
    [directory.public_snapshot_key,directory.snapshot_id,directory.digest,directory.nodes.length,
      directory.edges.length,directory.evidence.length,directory.layers.length,directory.value_points.length,directoryId]);
}

/** Queue staging generations whose publication stopped without binding them. */
export async function enqueueExpiredDirectoryStaging(db: Pick<Pool | PoolClient, 'query'>): Promise<number> {
  const result = await db.query(`INSERT INTO snapshot_directory_reclamation(directory_id)
    SELECT g.directory_id FROM snapshot_directory_generations g
    WHERE g.staging_expires_at < clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id)
    ON CONFLICT(directory_id) DO NOTHING`);
  return result.rowCount ?? 0;
}
