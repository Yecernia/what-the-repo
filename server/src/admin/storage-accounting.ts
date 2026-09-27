import type { Dir } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export const ACCOUNTING_MAX_AGE_MS = 6 * 60 * 60_000;
export const PHYSICAL_SAMPLE_INTERVAL_MS = 10 * 60_000;
export const physicalSampleKey = 'storage-physical-sample';
export interface PhysicalTable { relname: string; estimated_rows: number; data_bytes: number; index_bytes: number }
export interface PhysicalSample { observedAt: string; tables: PhysicalTable[]; database_bytes: number; database_index_bytes: number }
export const emptyPhysicalSample: PhysicalSample = { observedAt: '', tables: [], database_bytes: 0, database_index_bytes: 0 };
export type LogicalCounts = Record<'nodes'|'edges'|'evidence'|'layers'|'value_points', number>;
export interface StoredAccounting {
  observedAt: string;
  signature: string;
  host_file_bytes: number | null;
  database_bytes: number | null;
  database_index_bytes: number | null;
  physical_observed_at?: string;
  database_estimate_complete?: boolean;
  logical_counts?: LogicalCounts | null;
  generation_counts?: { published: number; staging: number; retired: number; unknown: number };
  accounting_status?: 'ready'|'pending'|'scanning'|'incomplete';
}
export const emptyAccounting: StoredAccounting = {
  observedAt: '', signature: '', host_file_bytes: null, database_bytes: null, database_index_bytes: null,
};
export const accountingSignature = (row: {keys: string[]; legacy_projects: string[]; created_at: unknown; revisions?: string[]}) =>
  JSON.stringify([row.keys, row.legacy_projects, row.created_at, row.revisions ?? []]);
export function accountingFresh(value: StoredAccounting, now = Date.now()) {
  return value.accounting_status === 'ready' && Date.parse(value.observedAt) > now - ACCOUNTING_MAX_AGE_MS
    && Date.parse(value.physical_observed_at ?? '') > now - ACCOUNTING_MAX_AGE_MS;
}

/** Called once per sampling interval under the collector lease, never per repository. */
export async function samplePhysicalTables(pool: Pick<Pool, 'query'>): Promise<PhysicalSample> {
  const tables: PhysicalTable[] = (await pool.query(`SELECT c.relname,c.reltuples::float8 AS estimated_rows,
    pg_table_size(c.oid)::float8 AS data_bytes,pg_indexes_size(c.oid)::float8 AS index_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind='r'`)).rows;
  return { observedAt: new Date().toISOString(), tables,
    database_bytes: tables.reduce((sum, table) => sum + Number(table.data_bytes), 0),
    database_index_bytes: tables.reduce((sum, table) => sum + Number(table.index_bytes), 0) };
}

/** Only directory metadata is read; published counts come from the publication transaction. */
export async function estimateSnapshotStorage(pool: Pick<Pool, 'query'>, keys: string[], sample: PhysicalSample,
  legacyProjects: string[] = []) {
  const generations = (await pool.query(`SELECT g.directory_id::text,g.logical_counts,
    d.node_count,d.edge_count,d.evidence_count,d.layer_count,d.value_point_count,
    CASE WHEN d.directory_id IS NOT NULL THEN 'published'
      WHEN g.staging_expires_at IS NOT NULL AND q.directory_id IS NULL THEN 'staging' ELSE 'retired' END AS state
    FROM snapshot_directory_generations g
    LEFT JOIN snapshot_query_directories d USING(directory_id)
    LEFT JOIN snapshot_directory_reclamation q USING(directory_id)
    WHERE g.public_snapshot_key=ANY($1::text[])`, [keys])).rows;
  const logical: LogicalCounts = {nodes: 0, edges: 0, evidence: 0, layers: 0, value_points: 0};
  const generationCounts = {published: 0, staging: 0, retired: 0, unknown: 0};
  const tables = new Map(sample.tables.map(table => [table.relname, table]));
  let data = 0, indexes = 0;
  let complete = true;
  // These are shared-page estimates. Child tables have exclusive generation ownership.
  const add = (name: string, rows: number, exclusive = false) => {
    const table = tables.get(name);
    if (!table) return false;
    const share = exclusive ? 1 : rows / Math.max(Number(table.estimated_rows), rows, 1);
    data += Number(table.data_bytes) * share; indexes += Number(table.index_bytes) * share;
    return true;
  };
  for (const generation of generations) {
    const state = generation.state as 'published'|'staging'|'retired';
    generationCounts[state]++;
    const counts = generation.logical_counts as Record<string, number> | null;
    if (!counts) generationCounts.unknown++;
    if (state === 'published') {
      logical.nodes += Number(generation.node_count); logical.edges += Number(generation.edge_count);
      logical.evidence += Number(generation.evidence_count); logical.layers += Number(generation.layer_count);
      logical.value_points += Number(generation.value_point_count);
    }
    for (const kind of ['nodes','edges','evidence','evidence_links','layers','value_points',
      'overlay_memberships','projection_nodes','projection_edges']) {
      if (!add(`snapshot_directory_${kind}_g${generation.directory_id}`, 0, true)) {
        if (counts?.[kind] != null) add('snapshot_directory_' + kind, Number(counts[kind]));
        else complete = false;
      }
    }
  }
  add('canonical_public_repository_snapshots', keys.length);
  add('snapshot_query_directories', generationCounts.published);
  add('snapshot_directory_generations', generations.length);
  add('project_snapshots', legacyProjects.length);
  const measured = Boolean(sample.observedAt);
  return {database_bytes: measured ? Math.round(data) : null, database_index_bytes: measured ? Math.round(indexes) : null,
    database_estimated: true, database_estimate_complete: measured && complete, physical_observed_at: sample.observedAt,
    logical_counts: logical, generation_counts: generationCounts};
}

/** Keeps one directory handle across ticks, so large directories also make progress.
 * A lost lease closes the handle; a replacement process starts a fresh scan rather
 * than publishing a partial total. No connection is retained between chunks. */
export class BoundedFileScan {
  private paths: string[];
  private directory: {handle: Dir; path: string} | undefined;
  private bytes = 0;
  private failed = false;
  constructor(paths: string[]) { this.paths = [...paths]; }
  async close() { await this.directory?.handle.close().catch(() => undefined); this.directory = undefined; }
  async step(options: {maxEntries?: number; maxMs?: number} = {}) {
    const deadline = performance.now() + (options.maxMs ?? 2_000);
    const maxEntries = options.maxEntries ?? 2_000;
    let visited = 0;
    try {
      while (visited < maxEntries && performance.now() < deadline) {
        let path: string | undefined;
        if (this.directory) {
          const entry = await this.directory.handle.read();
          if (!entry) { await this.close(); continue; }
          visited++;
          if (entry.isSymbolicLink()) continue;
          path = join(this.directory.path, entry.name);
          if (entry.isDirectory()) { this.paths.push(path); continue; }
        } else {
          path = this.paths.pop();
          if (!path) return {done: true, bytes: this.failed ? null : this.bytes, visited};
          visited++;
        }
        const info = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (!info || info.isSymbolicLink()) continue;
        if (info.isDirectory()) this.directory = {handle: await opendir(path), path};
        else if (info.isFile()) this.bytes += info.size;
      }
      return {done: false, bytes: null, visited};
    } catch {
      this.failed = true; await this.close(); this.paths = [];
      return {done: true, bytes: null, visited};
    }
  }
}

export function repositoryFilePaths(root: string, keys: string[], projects: string[]) {
  const paths: string[] = [];
  for (const key of keys) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid_snapshot_key');
    for (const folder of ['public-repository-snapshots','source-snapshots/public','snapshot-language-overlays'])
      paths.push(join(root, folder, key));
  }
  for (const id of new Set(projects)) {
    if (!/^[\w-]+$/.test(id)) throw new Error('invalid_project_id');
    paths.push(join(root, 'source-snapshots', id));
    for (const folder of ['snapshots','analysis-results','analysis-checkpoints']) paths.push(join(root, folder, id + '.json'));
  }
  return paths;
}
