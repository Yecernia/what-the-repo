import type { Pool } from 'pg';
import { prepareDirectoryFinalization } from './directory-reclamation-finalization.js';
import { enqueueExpiredDirectoryStaging } from './snapshot-directory-publication.js';
import { parseDirectoryManifest } from './directory-objects.js';

export const RECLAMATION_TABLES = [
  'evidence_links', 'projection_edges', 'projection_nodes', 'overlay_memberships',
  'edges', 'nodes', 'layers', 'value_points', 'evidence',
] as const;
export interface ReclamationResult {
  status: 'idle' | 'busy' | 'progress' | 'finished' | 'retry';
  deletedRows: number;
  directoryId?: string;
  errorCode?: string;
}
const PRIMARY_KEYS: Record<(typeof RECLAMATION_TABLES)[number], readonly string[]> = {
  evidence_links: ['owner_kind','owner_no','evidence_no','role'],
  projection_edges: ['projection_kind','projection_edge_id'], projection_nodes: ['projection_kind','projection_node_id'],
  overlay_memberships: ['overlay_id','entity_id','relation_id','role'],
  edges: ['row_no'], nodes: ['row_no'], layers: ['layer_id'], value_points: ['value_point_id'], evidence: ['row_no'],
};
interface WorkItem { directory_id: string; public_snapshot_key: string; table_index: number; attempts: number; cursor_values: string[] | null; object_manifest?: unknown }
const limit = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback;
const errorCode = (value: unknown) => {
  const code = (value as { code?: unknown })?.code;
  return typeof code === 'string' && ['57014','55P03','40P01','23503','23514','P0001','directory_finalization_schema_mismatch'].includes(code) ? code : 'database_error';
};

/** Only queued retired IDs (or expired unbound staging) are eligible; each call is one bounded transaction. */
export async function reclaimSnapshotDirectoryBatch(pool: Pick<Pool,'connect'>,
  options: { batchRows?: number; statementTimeoutMs?: number } = {}): Promise<ReclamationResult> {
  const client = await pool.connect();
  const batchRows = limit(options.batchRows, 1_000, 5_000);
  const timeout = limit(options.statementTimeoutMs, 2_000, 5_000);
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','100ms',true)", [String(timeout)]);
    const guards = await client.query(`SELECT
      pg_try_advisory_xact_lock(hashtextextended('snapshot-directory-reclamation',0)) AS worker,
      pg_try_advisory_xact_lock_shared(hashtextextended('repository-payload-use',0)) AS maintenance`);
    if (!guards.rows[0]?.worker || !guards.rows[0]?.maintenance) {
      await client.query('ROLLBACK'); return { status: 'busy', deletedRows: 0 };
    }
    // Publications that stopped before binding leave an expired staging generation.
    await enqueueExpiredDirectoryStaging(client);
    const selected = await client.query<WorkItem>(`SELECT q.directory_id,g.public_snapshot_key,q.table_index,q.attempts,q.cursor_values,g.object_manifest
      FROM snapshot_directory_reclamation q JOIN snapshot_directory_generations g USING(directory_id)
      WHERE q.available_at<=clock_timestamp() ORDER BY q.available_at,q.directory_id
      LIMIT 1 FOR UPDATE OF q SKIP LOCKED`);
    const work = selected.rows[0];
    if (!work) { await client.query('COMMIT'); return { status: 'idle', deletedRows: 0 }; }
    const keyGuard = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
      ['snapshot-publication:' + work.public_snapshot_key]);
    if (!keyGuard.rows[0]?.acquired) { await client.query('ROLLBACK'); return { status: 'busy', deletedRows: 0 }; }
    const retired = await client.query(`SELECT directory_id FROM snapshot_directory_generations g WHERE directory_id=$1
      AND NOT EXISTS (SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id) FOR UPDATE`, [work.directory_id]);
    if (!retired.rowCount) {
      await client.query('DELETE FROM snapshot_directory_reclamation WHERE directory_id=$1', [work.directory_id]);
      await client.query('COMMIT'); return { status: 'idle', deletedRows: 0 };
    }
    await client.query('SAVEPOINT reclaim_batch');
    try {
      const table = RECLAMATION_TABLES[work.table_index];
      let deletedRows = 0;
      if (table) {
        if (table === 'edges' || table === 'nodes' || table === 'evidence' || table === 'evidence_links') {
          // New generations keep these rows and indexes in one inherited table.
          // The owner-only helper verifies retirement before removing that table.
          // Legacy generations return NULL and retain the bounded row path below.
          const child = await client.query<{ removed_rows: string | null }>(
            'SELECT public.drop_retired_snapshot_directory_child($1::bigint,$2::text) AS removed_rows',
            [work.directory_id, table]);
          const removed = child.rows[0]?.removed_rows;
          if (removed === '-1') {
            const observed = await client.query(`UPDATE snapshot_directory_reclamation
              SET cleanup_observed_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE directory_id=$1 AND cleanup_observed_at IS NULL RETURNING directory_id`, [work.directory_id]);
            if (observed.rowCount) {
              // This commit is after the publishing transaction. Every reader
              // that could still see the old pointer started before this time.
              await client.query('COMMIT');
              return { status: 'progress', deletedRows: 0, directoryId: work.directory_id };
            }
            await client.query('ROLLBACK');
            return { status: 'busy', deletedRows: 0, directoryId: work.directory_id };
          }
          if (removed != null) {
            deletedRows = Number(removed);
            if (!Number.isSafeInteger(deletedRows) || deletedRows < 0) throw new Error('directory_cleanup_count_invalid');
            await client.query(`UPDATE snapshot_directory_reclamation SET table_index=$2,rows_deleted=rows_deleted+$3,
              cursor_values=NULL,attempts=0,last_error_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE directory_id=$1`, [work.directory_id,work.table_index+1,deletedRows]);
            await client.query('COMMIT');
            return { status: 'progress', deletedRows, directoryId: work.directory_id };
          }
        }
        const physical = 'snapshot_directory_' + table;
        const columns = PRIMARY_KEYS[table], order = columns.join(',');
        if (work.cursor_values && (work.cursor_values.length !== columns.length || work.cursor_values.some(v => typeof v !== 'string'))) {
          throw new Error('directory_cleanup_cursor_invalid');
        }
        const numeric = ['nodes','edges','evidence','evidence_links'].includes(table);
        const after = work.cursor_values
          ? ' AND ROW(' + order + ')>ROW(' + columns.map((_name,i) => '($3::text[])[' + (i+1) + ']' + (numeric ? '::integer' : '')).join(',') + ')' : '';
        const args: unknown[] = [work.directory_id,batchRows];
        if (work.cursor_values) args.push(work.cursor_values);
        // Persist primary keys, never physical tuple addresses. Locked rows cause
        // a retry: skipping them while advancing the cursor would lose work.
        const removed = await client.query(`WITH picked AS MATERIALIZED (
          SELECT ctid,${order} FROM ${physical} WHERE directory_id=$1${after}
          ORDER BY ${order} LIMIT $2 FOR UPDATE
        ), removed AS (
          DELETE FROM ${physical} target USING picked
          WHERE target.directory_id=$1 AND target.ctid=picked.ctid RETURNING 1
        ) SELECT (SELECT count(*)::int FROM picked) AS picked,
          (SELECT count(*)::int FROM removed) AS deleted,
          (SELECT ARRAY[${columns.map(name => name+'::text').join(',')}] FROM picked ORDER BY ${columns.map(name => name + ' DESC').join(',')} LIMIT 1) AS cursor`, args);
        const batch = removed.rows[0]; deletedRows = batch.deleted;
        if (batch.picked !== deletedRows) throw new Error('directory_cleanup_incomplete');
        const complete = deletedRows < batchRows;
        await client.query(`UPDATE snapshot_directory_reclamation SET table_index=$2,rows_deleted=rows_deleted+$3,cursor_values=$4,
          attempts=0,last_error_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE directory_id=$1`,
          [work.directory_id,complete ? work.table_index+1 : work.table_index,deletedRows,complete ? null : batch.cursor]);
      } else {
        await prepareDirectoryFinalization(client, RECLAMATION_TABLES);
        // Never let a final cascading delete hide an unexpectedly nonempty table.
        const checks = RECLAMATION_TABLES.map(name => `EXISTS(SELECT 1 FROM snapshot_directory_${name} WHERE directory_id=$1)`);
        const remaining = await client.query('SELECT ' + checks.join(' OR ') + ' AS remaining', [work.directory_id]);
        if (remaining.rows[0]?.remaining) {
          await client.query('UPDATE snapshot_directory_reclamation SET table_index=0,cursor_values=NULL,available_at=clock_timestamp() WHERE directory_id=$1', [work.directory_id]);
        } else {
          const intents = await client.query<{ object_key: string }>(
            'SELECT object_key FROM snapshot_directory_object_intents WHERE directory_id=$1', [work.directory_id]);
          const keys = intents.rows.map(intent => intent.object_key);
          if (work.object_manifest) keys.push(...Object.values(parseDirectoryManifest(work.object_manifest).sections).flat().map(chunk => chunk.key));
          if (keys.length) {
            // COS has no MVCC. An old transaction must finish before its full
            // rows can be deleted, including generations without child tables.
            const observed = await client.query(`UPDATE snapshot_directory_reclamation
              SET cleanup_observed_at=clock_timestamp() WHERE directory_id=$1
                AND cleanup_observed_at IS NULL RETURNING directory_id`, [work.directory_id]);
            if (observed.rowCount) { await client.query('COMMIT'); return { status: 'progress', deletedRows: 0, directoryId: work.directory_id }; }
            const readers = await client.query(`SELECT 1 FROM pg_stat_activity a
              WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.pid<>pg_backend_pid()
                AND a.xact_start<=(SELECT cleanup_observed_at FROM snapshot_directory_reclamation WHERE directory_id=$1) LIMIT 1`, [work.directory_id]);
            if (readers.rowCount) { await client.query('COMMIT'); return { status: 'busy', deletedRows: 0, directoryId: work.directory_id }; }
            const prefix = `public-repository-snapshots/${work.public_snapshot_key}/directory/${work.directory_id}/`;
            if (keys.some(key => !key.startsWith(prefix) || key.includes('..'))) throw new Error('directory_cleanup_unscoped_object');
            await client.query(`INSERT INTO directory_object_deletions(object_key)
              SELECT unnest($1::text[]) ON CONFLICT(object_key) DO NOTHING`, [keys]);
          }
          await client.query('DELETE FROM snapshot_directory_object_intents WHERE directory_id=$1', [work.directory_id]);
          const removed = await client.query(`DELETE FROM snapshot_directory_generations g WHERE directory_id=$1
            AND NOT EXISTS(SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id)`, [work.directory_id]);
          if (!removed.rowCount) throw new Error('directory_cleanup_incomplete');
          await client.query('COMMIT'); return { status: 'finished', deletedRows: 0, directoryId: work.directory_id };
        }
      }
      await client.query('COMMIT');
      return { status: 'progress', deletedRows, directoryId: work.directory_id };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT reclaim_batch');
      const code = errorCode(error);
      const retrySeconds = Math.min(300, 2 ** Math.min(work.attempts + 1, 8));
      await client.query(`UPDATE snapshot_directory_reclamation SET attempts=LEAST(attempts+1,20),
        last_error_code=$2,available_at=clock_timestamp()+($3*interval '1 second'),updated_at=clock_timestamp()
        WHERE directory_id=$1`, [work.directory_id,code,retrySeconds]);
      await client.query('COMMIT');
      return { status: 'retry', deletedRows: 0, directoryId: work.directory_id, errorCode: code };
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function snapshotDirectoryReclamationBacklog(pool: Pick<Pool,'query'>): Promise<{ pending: number; failed: number; oldestSeconds: number }> {
  const result = await pool.query(`SELECT count(*)::int AS pending,
    count(*) FILTER(WHERE last_error_code IS NOT NULL)::int AS failed,
    COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(enqueued_at)),0)::float8 AS oldest
    FROM snapshot_directory_reclamation`);
  return { pending: result.rows[0].pending, failed: result.rows[0].failed,
    oldestSeconds: Math.max(0, result.rows[0].oldest) };
}
