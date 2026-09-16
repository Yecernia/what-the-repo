BEGIN;
CREATE TEMP TABLE snapshot_directory_acl ON COMMIT DROP AS
  SELECT replace(c.relname,'snapshot_directory_','snapshot_query_') AS target_table,a.grantee,a.privilege_type,a.is_grantable
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE n.nspname=current_schema() AND c.relname LIKE 'snapshot_directory_%' AND c.relkind='r';
DROP VIEW snapshot_query_nodes,snapshot_query_edges,snapshot_query_evidence,snapshot_query_evidence_links,snapshot_query_layers,snapshot_query_value_points,snapshot_query_overlay_memberships,snapshot_query_projection_nodes,snapshot_query_projection_edges;
DO $$
DECLARE suffix text; physical text; restored text; cols text; source_cols text; identity_cols text; identity_values text; idx record;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['nodes','edges','evidence','evidence_links','layers','value_points','overlay_memberships','projection_nodes','projection_edges'] LOOP
    physical:='snapshot_directory_'||suffix; restored:='snapshot_query_'||suffix;
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),string_agg('s.'||quote_ident(attname),',' ORDER BY attnum) INTO cols,source_cols
      FROM pg_attribute WHERE attrelid=physical::regclass AND attnum>0 AND NOT attisdropped AND attname<>'directory_id';
    EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',restored,physical);
    EXECUTE format('ALTER TABLE %I DROP COLUMN directory_id, ADD COLUMN public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE',restored);
    identity_cols:='public_snapshot_key';identity_values:='d.public_snapshot_key';
    IF suffix<>'evidence_links' THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN snapshot_id text NOT NULL',restored);
      identity_cols:=identity_cols||',snapshot_id';identity_values:=identity_values||',d.snapshot_id';
    END IF;
    EXECUTE format('INSERT INTO %I(%s,%s) SELECT %s,%s FROM %I s JOIN snapshot_query_directories d USING(directory_id)',restored,identity_cols,cols,identity_values,source_cols,physical);
    FOR idx IN SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=physical LOOP
      IF idx.indexname='snapshot_directory_nodes_id_idx' THEN CONTINUE; END IF;
      EXECUTE replace(replace(idx.indexdef,physical,restored),'directory_id','public_snapshot_key');
      IF idx.indexname=physical||'_pkey' THEN EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY USING INDEX %I',restored,restored||'_pkey'); END IF;
    END LOOP;
    EXECUTE format('ANALYZE %I',restored);
  END LOOP;
  ALTER TABLE snapshot_query_evidence_links ADD FOREIGN KEY(public_snapshot_key,evidence_id) REFERENCES snapshot_query_evidence(public_snapshot_key,evidence_id) ON DELETE CASCADE;
END $$;
DROP TABLE snapshot_directory_evidence_links;
DROP TABLE snapshot_directory_nodes,snapshot_directory_edges,snapshot_directory_evidence,snapshot_directory_layers,snapshot_directory_value_points,snapshot_directory_overlay_memberships,snapshot_directory_projection_nodes,snapshot_directory_projection_edges;
ALTER TABLE snapshot_query_directories DROP COLUMN directory_id;
CREATE INDEX snapshot_query_nodes_search_idx ON snapshot_query_nodes(public_snapshot_key,node_kind,node_key);
CREATE INDEX snapshot_query_evidence_path_idx ON snapshot_query_evidence(public_snapshot_key,path,evidence_id);
CREATE INDEX snapshot_query_projection_nodes_overlay_idx ON snapshot_query_projection_nodes(public_snapshot_key,projection_kind,overlay_ids);
CREATE INDEX snapshot_query_projection_edges_overlay_idx ON snapshot_query_projection_edges(public_snapshot_key,projection_kind,overlay_ids);
DO $$
DECLARE entry record; grantee_name text;
BEGIN
  FOR entry IN SELECT * FROM snapshot_directory_acl LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON TABLE %I TO %s%s',entry.privilege_type,entry.target_table,grantee_name,CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
DELETE FROM schema_migrations WHERE version='0023_compact_snapshot_directory';
COMMIT;
