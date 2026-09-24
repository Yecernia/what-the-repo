import type { PoolClient } from 'pg';

/** Finalization owns an already-locked, retired generation with no data rows.
 * RI triggers issue their own prepared DELETEs: an empty application probe does
 * not prevent a stale generic FK plan from scanning unrelated generations.
 */
export async function prepareDirectoryFinalization(client: PoolClient, tables: readonly string[]): Promise<void> {
  // Scope planner policy to this transaction, including deferred FK checks at
  // COMMIT. force_custom_plan also bypasses a bad SPI plan cached by this pool
  // connection. Plain index scans also avoid index-only visibility-map probes
  // over the recently deleted range. No global setting, ANALYZE, timeout
  // increase or disabled FK. Index policy is not a substitute for the existing
  // statement/lock deadlines: storage stalls still roll back and retry.
  await client.query(`SELECT set_config('enable_seqscan','off',true),
    set_config('enable_bitmapscan','off',true),set_config('enable_indexscan','on',true),
    set_config('enable_indexonlyscan','off',true),set_config('plan_cache_mode','force_custom_plan',true),
    set_config('jit','off',true)`);
  const inherited = await client.query<{ name: string; parent: string }>(`SELECT child.relname AS name,parent.relname AS parent
    FROM pg_inherits inh JOIN pg_class child ON child.oid=inh.inhrelid
    JOIN pg_class parent ON parent.oid=inh.inhparent
    JOIN pg_namespace ns ON ns.oid=child.relnamespace
    WHERE ns.nspname='public'
      AND parent.oid IN ('public.snapshot_directory_nodes'::regclass,
        'public.snapshot_directory_edges'::regclass, 'public.snapshot_directory_evidence'::regclass,
        'public.snapshot_directory_evidence_links'::regclass)`);
  if (inherited.rows.some(row =>
    !/^snapshot_directory_(nodes|edges|evidence|evidence_links)_g[1-9][0-9]*$/.test(row.name)
    || !row.name.startsWith(row.parent + '_g'))) {
    throw Object.assign(new Error('directory_finalization_schema_mismatch'), { code: 'directory_finalization_schema_mismatch' });
  }
  const expected = [...tables.map(name => 'snapshot_directory_' + name),
    'snapshot_query_directories', 'snapshot_directory_reclamation',
    ...inherited.rows.map(row => row.name)];
  // A planner preference cannot manufacture an index. Fail closed if schema
  // drift adds an unreviewed cascade or removes a leading directory-ID index.
  const references = await client.query<{ name: string; indexed: boolean }>(`SELECT r.relname AS name,
    EXISTS(SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      JOIN pg_am am ON am.oid=ix.relam WHERE i.indrelid=r.oid AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indkey[0]=a.attnum) AND c.conkey[1]=a.attnum
    AND c.confkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='directory_id')
    AND ns.nspname='public' AND r.relkind='r' AS indexed
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=r.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname='directory_id' AND NOT a.attisdropped
    WHERE c.contype='f' AND c.confrelid='public.snapshot_directory_generations'::regclass`);
  const names = new Set(references.rows.map(row => row.name));
  if (references.rows.length !== expected.length || names.size !== expected.length
    || references.rows.some(row => !row.indexed || !expected.includes(row.name))) {
    throw Object.assign(new Error('directory_finalization_schema_mismatch'), { code: 'directory_finalization_schema_mismatch' });
  }
}
