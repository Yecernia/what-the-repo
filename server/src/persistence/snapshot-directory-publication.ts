import type { Pool, PoolClient } from 'pg';
import type { SnapshotQueryDirectorySource } from '../domain/snapshot-query.js';
import { insertSnapshotRows, newSnapshotRowWriteMetrics } from './postgres-snapshot-rows.js';

type ChildKind = 'nodes' | 'edges' | 'evidence' | 'evidence_links';
/** An abandoned staging generation becomes reclaimable after this long. */
const STAGING_TTL_SECONDS = 3 * 60 * 60;

export interface DirectoryStagingOptions {
  /** Extra pool connections for parallel loading; 0 keeps everything on `client`. */
  parallelism: number;
  /** Called before each batch with the connection that will write it. */
  beforeBatch?: (client: PoolClient) => Promise<void>;
  timings?: Record<string, number>;
}

/**
 * Load a directory generation that stays invisible until the caller binds it.
 * With parallelism, the generation is committed first and nodes, edges and
 * evidence load on separate connections; a failure queues it for reclamation.
 * Without it, all rows are written inside the caller's transaction.
 */
export async function stageSnapshotQueryDirectory(pool: Pool, client: PoolClient,
  directory: SnapshotQueryDirectorySource, options: DirectoryStagingOptions): Promise<string> {
  const parallel = options.parallelism > 0;
  const inserted = await (parallel ? pool : client).query<{ directory_id: string }>(
    `INSERT INTO snapshot_directory_generations(public_snapshot_key, snapshot_id, staging_expires_at)
     VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3)) RETURNING directory_id`,
    [directory.public_snapshot_key, directory.snapshot_id, STAGING_TTL_SECONDS]);
  const directoryId = inserted.rows[0]?.directory_id;
  if (!directoryId) throw new Error('snapshot_query_directory_identity_missing');
  const timings = options.timings;
  const failed = new AbortController();

  const writeRows = async <T extends object>(db: PoolClient, table: string, columns: string[], rows: Iterable<T>,
    kind: ChildKind | null, convert?: (row: T) => object) => {
    const metrics = newSnapshotRowWriteMetrics();
    const name = 'directory_' + table;
    let physical = 'snapshot_directory_' + table;
    try {
      if (kind) {
        const result = await db.query<{ child_name: string }>(
          'SELECT public.stage_snapshot_directory_child($1::bigint,$2::text) AS child_name', [directoryId, kind]);
        physical = result.rows[0]?.child_name ?? '';
        if (physical !== `snapshot_directory_${kind}_g${directoryId}`
          || !/^snapshot_directory_(?:nodes|edges|evidence|evidence_links)_g[1-9][0-9]*$/.test(physical)) {
          throw new Error('snapshot_directory_child_identity_invalid');
        }
      }
      await insertSnapshotRows(db, physical,
        ['directory_id', ...columns.filter(column => !['public_snapshot_key', 'snapshot_id'].includes(column))], rows,
        row => ({ ...(convert ? convert(row) : row), directory_id: directoryId }), async () => {
          failed.signal.throwIfAborted();
          await options.beforeBatch?.(db);
        }, metrics);
      if (kind) {
        failed.signal.throwIfAborted();
        await options.beforeBatch?.(db);
        const indexStarted = performance.now();
        try {
          // Sources declare their size; a silently skipped duplicate must fail here.
          const expected = typeof (rows as { length?: unknown }).length === 'number'
            ? (rows as unknown as { length: number }).length : metrics.rows;
          await db.query('SELECT public.finish_snapshot_directory_child($1::bigint,$2::text,$3::bigint)',
            [directoryId, kind, expected]);
        } finally {
          if (timings) timings[`${name}_index_build_ms`] = performance.now() - indexStarted;
        }
      }
    } finally {
      if (timings) for (const [key, value] of Object.entries(metrics)) timings[name + '_' + key] = value;
    }
  };

  const nodes = (db: PoolClient) => writeRows(db, 'nodes',
    ["public_snapshot_key", "snapshot_id", "node_key", "node_id", "node_kind", "entity_kind", "parent_entity_id", "depth", "label", "name", "responsibility", "path", "language", "layer_id", "layer_name", "certainty", "lifecycle_status", "payload"],
    directory.nodes, 'nodes');
  const edges = (db: PoolClient) => writeRows(db, 'edges',
    ["public_snapshot_key", "snapshot_id", "edge_key", "edge_id", "edge_kind", "source_node_key", "target_node_key", "relation_kind", "label", "description", "certainty", "weight", "lifecycle_status", "payload"],
    directory.edges, 'edges');
  const evidence = (db: PoolClient) => writeRows(db, 'evidence',
      ["public_snapshot_key", "snapshot_id", "evidence_id", "label", "path", "start_line", "end_line", "kind", "source_id", "target_id", "payload"],
      directory.evidence, 'evidence');
  const evidenceLinks = (db: PoolClient) => writeRows(db, 'evidence_links',
      ["public_snapshot_key", "evidence_id", "owner_kind", "owner_key", "role"],
      directory.evidence_links, 'evidence_links');
  const smallTables = async (db: PoolClient) => {
    await writeRows(db, 'layers',
      ["public_snapshot_key", "snapshot_id", "layer_id", "name", "responsibility", "certainty", "payload"],
      directory.layers, null);
    await writeRows(db, 'value_points',
      ["public_snapshot_key", "snapshot_id", "value_point_id", "kind", "title", "claim", "certainty", "connectivity", "payload"],
      directory.value_points, null);
    await writeRows(db, 'overlay_memberships',
      ["public_snapshot_key", "snapshot_id", "overlay_id", "overlay_kind", "entity_id", "relation_id", "role", "payload"],
      directory.memberships ?? [], null, row => ({ ...row, relation_id: row.relation_id ?? "" }));
    await writeRows(db, 'projection_nodes',
      ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_node_id", "entity_id", "parent_projection_node_id", "depth", "aggregate_member_entity_ids", "evidence_ids", "overlay_ids", "payload"],
      directory.projections ?? [], null, row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }));
    await writeRows(db, 'projection_edges',
      ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_edge_id", "relation_id", "source_projection_node_id", "target_projection_node_id", "source_entity_id", "target_entity_id", "aggregate_relation_ids", "evidence_ids", "overlay_ids", "payload"],
      directory.aggregates ?? [], null, row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }));
  };
  // Links reference the evidence child, so they follow it in one lane.
  const lanes = [[nodes], [edges], [evidence, evidenceLinks, smallTables]];

  if (!parallel) {
    for (const lane of lanes) for (const step of lane) await step(client);
    return directoryId;
  }
  // Each table commits on its own so its short foreign-key lock is released
  // at once; the generation stays unbound until the caller's fenced
  // transaction, so readers never observe a partial directory.
  const runLane = async (lane: Array<(db: PoolClient) => Promise<void>>) => {
    const db = await pool.connect();
    try {
      for (const step of lane) {
        await db.query('BEGIN');
        await step(db);
        await db.query('COMMIT');
      }
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      failed.abort(error);
      throw error;
    } finally { db.release(); }
  };
  const width = Math.max(1, Math.min(lanes.length, Math.floor(options.parallelism)));
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: width }, async () => {
    while (next < lanes.length && !failed.signal.aborted) await runLane(lanes[next++]!);
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    await pool.query(`INSERT INTO snapshot_directory_reclamation(directory_id) VALUES ($1) ON CONFLICT(directory_id) DO NOTHING`,
      [directoryId]).catch(() => undefined);
    throw failure.reason;
  }
  return directoryId;
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
     VALUES ($1,$2,2,$3,$4,$5,$6,$7,$8,clock_timestamp(),$9)
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
