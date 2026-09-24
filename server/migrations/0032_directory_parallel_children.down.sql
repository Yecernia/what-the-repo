BEGIN;

-- Restore the node/edge-only helpers. Evidence child generations must be
-- retired and reclaimed first; their parent tables and live data stay intact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_inherits
    WHERE inhparent IN ('public.snapshot_directory_evidence'::regclass,
                        'public.snapshot_directory_evidence_links'::regclass)
  ) THEN
    RAISE EXCEPTION 'directory evidence child generations still exist';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.stage_snapshot_directory_child(generation_id bigint, kind text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  parent_name text;
  child_name text;
  granted_role record;
BEGIN
  IF generation_id IS NULL OR generation_id <= 0 OR kind NOT IN ('nodes', 'edges') THEN
    RAISE EXCEPTION 'invalid directory child identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.snapshot_directory_generations g
    WHERE g.directory_id = generation_id
      AND NOT EXISTS (
        SELECT 1 FROM public.snapshot_query_directories d
        WHERE d.directory_id = g.directory_id
      )
  ) THEN
    RAISE EXCEPTION 'directory generation is not staging';
  END IF;
  parent_name := 'snapshot_directory_' || kind;
  child_name := parent_name || '_g' || generation_id::text;
  IF to_regclass(format('public.%I', child_name)) IS NOT NULL THEN
    RAISE EXCEPTION 'directory child already exists';
  END IF;
  EXECUTE format(
    'CREATE TABLE public.%I (CONSTRAINT %I CHECK (directory_id = %L::bigint)) INHERITS (public.%I)',
    child_name, child_name || '_directory_id_check', generation_id, parent_name
  );
  -- Inherited tables do not inherit table ACLs. Mirror the parent's explicit
  -- DML grantees without granting DDL or schema CREATE to the runtime role.
  FOR granted_role IN
    SELECT DISTINCT r.rolname
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE c.oid = format('public.%I', parent_name)::regclass
      AND acl.privilege_type = 'INSERT'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I',
      child_name, granted_role.rolname);
  END LOOP;
  RETURN child_name;
END $$;

CREATE OR REPLACE FUNCTION public.finish_snapshot_directory_child(generation_id bigint, kind text, expected_rows bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  parent_name text;
  child_name text;
  actual_rows bigint;
BEGIN
  IF generation_id IS NULL OR generation_id <= 0 OR kind NOT IN ('nodes', 'edges')
    OR expected_rows IS NULL OR expected_rows < 0 THEN
    RAISE EXCEPTION 'invalid directory child identity';
  END IF;
  parent_name := 'snapshot_directory_' || kind;
  child_name := parent_name || '_g' || generation_id::text;
  IF NOT EXISTS (
    SELECT 1 FROM pg_inherits
    WHERE inhrelid = format('public.%I', child_name)::regclass
      AND inhparent = format('public.%I', parent_name)::regclass
  ) THEN
    RAISE EXCEPTION 'directory child inheritance mismatch';
  END IF;
  EXECUTE format('SELECT count(*) FROM ONLY public.%I', child_name) INTO actual_rows;
  IF actual_rows <> expected_rows THEN
    RAISE EXCEPTION 'directory child row count mismatch: % <> %', actual_rows, expected_rows;
  END IF;
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (directory_id, %I)',
    child_name, child_name || '_pkey', CASE kind WHEN 'nodes' THEN 'node_key' ELSE 'edge_key' END);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (directory_id) REFERENCES public.snapshot_directory_generations(directory_id) ON DELETE CASCADE',
    child_name, child_name || '_generation_fk');
  IF kind = 'nodes' THEN
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, entity_kind, node_id)', child_name || '_entity_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, node_id)', child_name || '_id_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, language)', child_name || '_language_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, parent_entity_id, depth, node_key)', child_name || '_parent_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, path)', child_name || '_path_idx', child_name);
  ELSE
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, relation_kind, edge_key)', child_name || '_relation_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, source_node_key, edge_key)', child_name || '_source_idx', child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id, target_node_key, edge_key)', child_name || '_target_idx', child_name);
  END IF;
  EXECUTE format('CREATE INDEX %I ON public.%I USING gin (directory_id, search_text gin_trgm_ops)',
    child_name || '_text_idx', child_name);
  EXECUTE format('ANALYZE public.%I', child_name);
END $$;

CREATE OR REPLACE FUNCTION public.drop_retired_snapshot_directory_child(generation_id bigint, kind text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  parent_name text;
  child_name text;
  removed_rows bigint;
  observed_at timestamptz;
BEGIN
  IF generation_id IS NULL OR generation_id <= 0 OR kind NOT IN ('nodes', 'edges') THEN
    RAISE EXCEPTION 'invalid directory child identity';
  END IF;
  SELECT q.cleanup_observed_at INTO observed_at
    FROM public.snapshot_directory_reclamation q
    JOIN public.snapshot_directory_generations g USING (directory_id)
    WHERE q.directory_id = generation_id
      AND NOT EXISTS (
        SELECT 1 FROM public.snapshot_query_directories d
        WHERE d.directory_id = q.directory_id
      );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'directory child is not retired';
  END IF;
  parent_name := 'snapshot_directory_' || kind;
  child_name := parent_name || '_g' || generation_id::text;
  IF to_regclass(format('public.%I', child_name)) IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_inherits
    WHERE inhrelid = format('public.%I', child_name)::regclass
      AND inhparent = format('public.%I', parent_name)::regclass
  ) THEN
    RAISE EXCEPTION 'directory child inheritance mismatch';
  END IF;
  IF observed_at IS NULL OR EXISTS (
    SELECT 1 FROM pg_stat_activity a
    WHERE a.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND a.pid <> pg_backend_pid()
      AND a.xact_start <= observed_at
  ) THEN
    RETURN -1;
  END IF;
  EXECUTE format('SELECT count(*) FROM ONLY public.%I', child_name) INTO removed_rows;
  EXECUTE format('DROP TABLE public.%I', child_name);
  RETURN removed_rows;
END $$;

ALTER TABLE public.snapshot_directory_generations ADD CONSTRAINT snapshot_directory_generations_snapshot_fk
  FOREIGN KEY(public_snapshot_key) REFERENCES public.canonical_public_repository_snapshots(public_snapshot_key)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
DROP INDEX public.snapshot_directory_generations_staging_idx;
ALTER TABLE public.snapshot_directory_generations DROP COLUMN staging_expires_at;
DELETE FROM schema_migrations WHERE version = '0032_directory_parallel_children';

COMMIT;
