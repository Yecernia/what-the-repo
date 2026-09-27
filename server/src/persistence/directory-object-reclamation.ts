import type { Pool } from 'pg';
import type { SnapshotObjectStore } from './snapshot-object-store.js';

/** Runs after generation retirement commits. Keys belong to a unique generation,
 * so a later publication can never resurrect one of these objects. */
export async function deleteDirectoryObjectsBatch(db: Pick<Pool, 'query'>, objects: SnapshotObjectStore,
  limit = 128): Promise<{ deleted: number; failed: number; pending: number }> {
  const rows = (await db.query<{ object_key: string }>(`SELECT object_key FROM directory_object_deletions
    WHERE next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,object_key LIMIT $1`,
  [Math.max(1, Math.min(256, Math.floor(limit)))])).rows;
  let deleted = 0, failed = 0;
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(rows.slice(offset, offset + 8).map(async ({ object_key: key }) => {
      try {
        if (!/^public-repository-snapshots\/[a-f0-9]{64}\/directory\/[1-9][0-9]*\/[a-z_]+\/[^/]+$/.test(key)
          || key.includes('..')) throw new Error('directory_cleanup_unscoped_object');
        await (objects.purge?.(key) ?? objects.delete(key));
        await db.query('DELETE FROM directory_object_deletions WHERE object_key=$1', [key]);
        deleted++;
      } catch {
        failed++;
        await db.query(`UPDATE directory_object_deletions SET attempts=attempts+1,
          next_attempt_at=clock_timestamp()+(least(3600,30*power(2,least(7,attempts)))::int*interval '1 second'),
          last_error='object_delete_failed' WHERE object_key=$1`, [key]);
      }
    }));
  }
  const remaining = await db.query<{ pending: string }>('SELECT count(*)::text AS pending FROM directory_object_deletions');
  return { deleted, failed, pending: Number(remaining.rows[0]?.pending ?? 0) };
}
