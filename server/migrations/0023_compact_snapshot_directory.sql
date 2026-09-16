BEGIN;
CREATE TEMP TABLE snapshot_directory_acl ON COMMIT DROP AS
  SELECT c.relname AS source_table,a.grantee,a.privilege_type,a.is_grantable
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE n.nspname=current_schema() AND c.relname LIKE 'snapshot_query_%' AND c.relkind='r';
-- Keep public IDs stable at the read boundary; store each snapshot identity once.
ALTER TABLE snapshot_query_directories ADD COLUMN directory_id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE snapshot_query_directories ADD CONSTRAINT snapshot_query_directories_id_key UNIQUE(directory_id);
DO $$
DECLARE old_name text; new_name text; cols text; source_cols text; idx record; has_snapshot boolean;
BEGIN
  FOREACH old_name IN ARRAY ARRAY['snapshot_query_nodes','snapshot_query_edges','snapshot_query_evidence','snapshot_query_evidence_links','snapshot_query_layers','snapshot_query_value_points','snapshot_query_overlay_memberships','snapshot_query_projection_nodes','snapshot_query_projection_edges'] LOOP
    new_name := replace(old_name,'snapshot_query_','snapshot_directory_');
    IF old_name <> 'snapshot_query_evidence_links' THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I s JOIN snapshot_query_directories d USING(public_snapshot_key) WHERE s.snapshot_id<>d.snapshot_id)',old_name) INTO has_snapshot;
      IF has_snapshot THEN RAISE EXCEPTION 'snapshot directory identity mismatch in %',old_name; END IF;
    END IF;
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),string_agg('s.'||quote_ident(attname),',' ORDER BY attnum)
      INTO cols,source_cols FROM pg_attribute WHERE attrelid=old_name::regclass AND attnum>0 AND NOT attisdropped AND attname NOT IN ('public_snapshot_key','snapshot_id');
    EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',new_name,old_name);
    EXECUTE format('ALTER TABLE %I DROP COLUMN public_snapshot_key, DROP COLUMN IF EXISTS snapshot_id, ADD COLUMN directory_id bigint NOT NULL REFERENCES snapshot_query_directories(directory_id) ON DELETE CASCADE',new_name);
    EXECUTE format('INSERT INTO %I(directory_id,%s) SELECT d.directory_id,%s FROM %I s JOIN snapshot_query_directories d USING(public_snapshot_key)',new_name,cols,source_cols,old_name);
    FOR idx IN SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=old_name LOOP
      -- No product query uses these trailing fields; required prefix access is covered by other indexes.
      IF idx.indexname IN ('snapshot_query_nodes_search_idx','snapshot_query_evidence_path_idx','snapshot_query_projection_nodes_overlay_idx','snapshot_query_projection_edges_overlay_idx') THEN CONTINUE; END IF;
      EXECUTE replace(replace(idx.indexdef,old_name,new_name),'public_snapshot_key','directory_id');
      IF idx.indexname=old_name||'_pkey' THEN EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY USING INDEX %I',new_name,new_name||'_pkey'); END IF;
    END LOOP;
  END LOOP;
  ALTER TABLE snapshot_directory_evidence_links ADD FOREIGN KEY(directory_id,evidence_id) REFERENCES snapshot_directory_evidence(directory_id,evidence_id) ON DELETE CASCADE;
END $$;
-- The copy/rebuild also physically removes the repeated columns, not just their schema names.
DROP TABLE snapshot_query_evidence_links;
DROP TABLE snapshot_query_nodes,snapshot_query_edges,snapshot_query_evidence,snapshot_query_layers,snapshot_query_value_points,snapshot_query_overlay_memberships,snapshot_query_projection_nodes,snapshot_query_projection_edges;
DO $$
DECLARE suffix text; cols text; identity_cols text;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['nodes','edges','evidence','evidence_links','layers','value_points','overlay_memberships','projection_nodes','projection_edges'] LOOP
    SELECT string_agg('s.'||quote_ident(attname),',' ORDER BY attnum) INTO cols
      FROM pg_attribute WHERE attrelid=('snapshot_directory_'||suffix)::regclass AND attnum>0 AND NOT attisdropped AND attname<>'directory_id';
    identity_cols := CASE WHEN suffix='evidence_links' THEN 'd.public_snapshot_key,' ELSE 'd.public_snapshot_key,d.snapshot_id,' END;
    EXECUTE format('CREATE VIEW %I AS SELECT %s%s FROM %I s JOIN snapshot_query_directories d USING(directory_id)','snapshot_query_'||suffix,identity_cols,cols,'snapshot_directory_'||suffix);
    EXECUTE format('ANALYZE %I','snapshot_directory_'||suffix);
  END LOOP;
END $$;
CREATE INDEX snapshot_directory_nodes_id_idx ON snapshot_directory_nodes(directory_id,node_id);
DO $$
DECLARE entry record; target text; grantee_name text;
BEGIN
  FOR entry IN SELECT * FROM snapshot_directory_acl WHERE source_table <> 'snapshot_query_directories' LOOP
    target := replace(entry.source_table,'snapshot_query_','snapshot_directory_');
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON TABLE %I TO %s%s',entry.privilege_type,target,grantee_name,CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    IF entry.privilege_type='SELECT' THEN EXECUTE format('GRANT SELECT ON TABLE %I TO %s%s',entry.source_table,grantee_name,CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END); END IF;
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('0023_compact_snapshot_directory');
COMMIT;
