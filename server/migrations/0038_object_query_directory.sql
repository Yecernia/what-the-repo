BEGIN;

-- Deliberate format break. The operator must explicitly reset development
-- storage before upgrading; do not discard old object ownership implicitly.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM canonical_public_repository_snapshots)
    OR EXISTS(SELECT 1 FROM snapshot_directory_generations) THEN
    RAISE EXCEPTION 'storage_format_reset_required';
  END IF;
END $$;
DELETE FROM snapshot_query_directories;
CREATE TEMP TABLE directory_table_grants ON COMMIT DROP AS
SELECT c.relname, a.privilege_type, a.grantee, a.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
WHERE c.oid IN ('snapshot_directory_nodes'::regclass,'snapshot_directory_edges'::regclass,
  'snapshot_directory_evidence'::regclass,'snapshot_directory_evidence_links'::regclass);
DROP TABLE snapshot_directory_evidence_links CASCADE;
DROP TABLE snapshot_directory_evidence CASCADE;
DROP TABLE snapshot_directory_edges CASCADE;
DROP TABLE snapshot_directory_nodes CASCADE;
DELETE FROM snapshot_directory_generations;
ALTER TABLE snapshot_directory_generations ADD COLUMN object_manifest jsonb;

CREATE TABLE snapshot_directory_nodes (
  directory_id bigint NOT NULL REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  row_no integer NOT NULL CHECK(row_no>=0),
  node_key text NOT NULL,
  parent_no integer,
  entity_kind text NOT NULL,
  depth integer NOT NULL,
  path text,
  language text,
  search_text text NOT NULL,
  projection_kinds text[] NOT NULL,
  PRIMARY KEY(directory_id,row_no)
);
CREATE TABLE snapshot_directory_edges (
  directory_id bigint NOT NULL REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  row_no integer NOT NULL CHECK(row_no>=0),
  edge_key text NOT NULL,
  source_no integer NOT NULL,
  target_no integer NOT NULL,
  source_missing text,
  target_missing text,
  relation_kind text NOT NULL,
  weight double precision NOT NULL,
  search_text text NOT NULL,
  PRIMARY KEY(directory_id,row_no)
);
CREATE TABLE snapshot_directory_evidence (
  directory_id bigint NOT NULL REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  row_no integer NOT NULL CHECK(row_no>=0),
  evidence_id text NOT NULL,
  PRIMARY KEY(directory_id,row_no)
);
CREATE TABLE snapshot_directory_evidence_links (
  directory_id bigint NOT NULL REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  owner_kind smallint NOT NULL CHECK(owner_kind IN (0,1)),
  owner_no integer NOT NULL CHECK(owner_no>=0),
  evidence_no integer NOT NULL CHECK(evidence_no>=0),
  role smallint NOT NULL CHECK(role IN (0,1)),
  PRIMARY KEY(directory_id,owner_kind,owner_no,evidence_no,role)
);

DO $$ DECLARE entry record; grantee_name text; BEGIN
  FOR entry IN SELECT * FROM directory_table_grants LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON %I TO %s%s',entry.privilege_type,entry.relname,grantee_name,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.finish_snapshot_directory_child(generation_id bigint, kind text, expected_rows bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent_name text; child_name text; actual_rows bigint; evidence_child text;
BEGIN
  IF generation_id IS NULL OR generation_id<=0 OR kind NOT IN ('nodes','edges','evidence','evidence_links')
    OR expected_rows IS NULL OR expected_rows<0 THEN RAISE EXCEPTION 'invalid directory child identity'; END IF;
  parent_name := 'snapshot_directory_' || kind;
  child_name := parent_name || '_g' || generation_id::text;
  IF NOT EXISTS (SELECT 1 FROM pg_inherits
    WHERE inhrelid=format('public.%I',child_name)::regclass AND inhparent=format('public.%I',parent_name)::regclass)
    THEN RAISE EXCEPTION 'directory child inheritance mismatch'; END IF;
  EXECUTE format('SELECT count(*) FROM ONLY public.%I',child_name) INTO actual_rows;
  IF actual_rows<>expected_rows THEN RAISE EXCEPTION 'directory child row count mismatch'; END IF;
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (%s)',child_name,child_name||'_pkey',
    CASE WHEN kind='evidence_links' THEN 'directory_id,owner_kind,owner_no,evidence_no,role' ELSE 'directory_id,row_no' END);
  IF kind='nodes' THEN
    EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (directory_id,node_key)',child_name||'_key_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,(substr(node_key,strpos(node_key,'':'' )+1)))',child_name||'_id_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,parent_no)',child_name||'_parent_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,entity_kind)',child_name||'_entity_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,language)',child_name||'_language_idx',child_name);
  ELSIF kind='edges' THEN
    EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (directory_id,edge_key)',child_name||'_key_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,source_no)',child_name||'_source_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,target_no)',child_name||'_target_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,relation_kind)',child_name||'_relation_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,source_missing) WHERE source_missing IS NOT NULL',child_name||'_missing_source_idx',child_name);
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,target_missing) WHERE target_missing IS NOT NULL',child_name||'_missing_target_idx',child_name);
  ELSIF kind='evidence' THEN
    EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (directory_id,evidence_id)',child_name||'_id_idx',child_name);
  ELSE
    EXECUTE format('CREATE INDEX %I ON public.%I (directory_id,evidence_no)',child_name||'_evidence_idx',child_name);
  END IF;
  IF kind IN ('nodes','edges') THEN
    EXECUTE format('CREATE INDEX %I ON public.%I USING gin (search_text gin_trgm_ops)',child_name||'_text_idx',child_name);
  END IF;
  EXECUTE format('ANALYZE public.%I',child_name);
  IF kind='evidence_links' THEN
    evidence_child := 'snapshot_directory_evidence_g'||generation_id::text;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (directory_id,evidence_no) REFERENCES public.%I(directory_id,row_no)',
      child_name,child_name||'_evidence_fk',evidence_child);
  END IF;
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (directory_id) REFERENCES public.snapshot_directory_generations(directory_id) ON DELETE CASCADE',
    child_name,child_name||'_generation_fk');
END $$;

INSERT INTO schema_migrations(version) VALUES ('0038_object_query_directory');
COMMIT;
