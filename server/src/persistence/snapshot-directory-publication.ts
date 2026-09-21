import type { PoolClient } from 'pg';
import type { SnapshotQueryDirectorySource } from '../domain/snapshot-query.js';
import { insertSnapshotRows } from './postgres-snapshot-rows.js';

/** Candidate rows stay invisible until the caller fences and commits the pointer. */
export async function stageSnapshotQueryDirectory(client: PoolClient, directory: SnapshotQueryDirectorySource,
  beforeBatch?: () => Promise<void>): Promise<string> {
  const inserted = await client.query<{ directory_id: string }>(
    'INSERT INTO snapshot_directory_generations(public_snapshot_key, snapshot_id) VALUES ($1, $2) RETURNING directory_id',
    [directory.public_snapshot_key, directory.snapshot_id]);
  const directoryId = inserted.rows[0]?.directory_id;
  if (!directoryId) throw new Error('snapshot_query_directory_identity_missing');
  const writeRows = <T extends object>(table: string, columns: string[], rows: Iterable<T>, convert?: (row: T) => object) =>
    insertSnapshotRows(client, table.replace('snapshot_query_', 'snapshot_directory_'), ['directory_id', ...columns.filter(column => !['public_snapshot_key','snapshot_id'].includes(column))], rows,
      row => ({ ...(convert ? convert(row) : row), directory_id: directoryId }), beforeBatch);
  await writeRows(
    "snapshot_query_nodes",
    ["public_snapshot_key", "snapshot_id", "node_key", "node_id", "node_kind", "entity_kind", "parent_entity_id", "depth", "label", "name", "responsibility", "path", "language", "layer_id", "layer_name", "certainty", "lifecycle_status", "payload"],
    directory.nodes,
  );
  await writeRows(
    "snapshot_query_edges",
    ["public_snapshot_key", "snapshot_id", "edge_key", "edge_id", "edge_kind", "source_node_key", "target_node_key", "relation_kind", "label", "description", "certainty", "weight", "lifecycle_status", "payload"],
    directory.edges,
  );
  await writeRows(
    "snapshot_query_evidence",
    ["public_snapshot_key", "snapshot_id", "evidence_id", "label", "path", "start_line", "end_line", "kind", "source_id", "target_id", "payload"],
    directory.evidence,
  );
  await writeRows(
    "snapshot_query_evidence_links",
    ["public_snapshot_key", "evidence_id", "owner_kind", "owner_key", "role"],
    directory.evidence_links,
  );
  await writeRows(
    "snapshot_query_layers",
    ["public_snapshot_key", "snapshot_id", "layer_id", "name", "responsibility", "certainty", "payload"],
    directory.layers,
  );
  await writeRows(
    "snapshot_query_value_points",
    ["public_snapshot_key", "snapshot_id", "value_point_id", "kind", "title", "claim", "certainty", "connectivity", "payload"],
    directory.value_points,
  );
  await writeRows(
    "snapshot_query_overlay_memberships",
    ["public_snapshot_key", "snapshot_id", "overlay_id", "overlay_kind", "entity_id", "relation_id", "role", "payload"],
    directory.memberships ?? [],
    row => ({ ...row, relation_id: row.relation_id ?? "" }),
  );
  await writeRows(
    "snapshot_query_projection_nodes",
    ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_node_id", "entity_id", "parent_projection_node_id", "depth", "aggregate_member_entity_ids", "evidence_ids", "overlay_ids", "payload"],
    directory.projections ?? [],
    row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }),
  );
  await writeRows(
    "snapshot_query_projection_edges",
    ["public_snapshot_key", "snapshot_id", "projection_kind", "projection_edge_id", "relation_id", "source_projection_node_id", "target_projection_node_id", "source_entity_id", "target_entity_id", "aggregate_relation_ids", "evidence_ids", "overlay_ids", "payload"],
    directory.aggregates ?? [],
    row => ({ ...row, overlay_ids: row.overlay_ids ?? [] }),
  );
  return directoryId;
}

/** Constant-sized final binding; no data-row insertion or deletion under the job lock. */
export async function bindSnapshotQueryDirectory(client: PoolClient, directory: SnapshotQueryDirectorySource, directoryId: string): Promise<void> {
  const candidate = await client.query(`SELECT directory_id FROM snapshot_directory_generations g
    WHERE directory_id=$1 AND public_snapshot_key=$2 AND snapshot_id=$3
      AND NOT EXISTS(SELECT 1 FROM snapshot_directory_reclamation q WHERE q.directory_id=g.directory_id) FOR KEY SHARE`,
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

/** Called after commit, never while the publication holds the analysis job lock. */
export async function pruneDetachedSnapshotDirectories(client: PoolClient, publicKey: string): Promise<void> {
  await client.query(`DELETE FROM snapshot_directory_generations g WHERE g.public_snapshot_key=$1
    AND NOT EXISTS (SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id)`, [publicKey]);
}
