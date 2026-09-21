BEGIN;
-- Run only with writers drained; remove unpublished historical generations.
DELETE FROM snapshot_directory_generations g WHERE NOT EXISTS
  (SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id);
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE snapshot_query_directories DROP CONSTRAINT snapshot_directory_published_generation_fk;
DO $$
DECLARE suffix text;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['nodes','edges','evidence','evidence_links','layers','value_points','overlay_memberships','projection_nodes','projection_edges'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I','snapshot_directory_'||suffix,'snapshot_directory_'||suffix||'_generation_fk');
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(directory_id) REFERENCES snapshot_query_directories(directory_id) ON DELETE CASCADE','snapshot_directory_'||suffix);
  END LOOP;
END $$;
DROP TABLE snapshot_directory_generations;
ALTER TABLE snapshot_query_directories ALTER COLUMN directory_id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('snapshot_query_directories','directory_id'),
  GREATEST(COALESCE((SELECT max(directory_id) FROM snapshot_query_directories),0),1),
  EXISTS(SELECT 1 FROM snapshot_query_directories));
DO $$
DECLARE entry record; grantee_name text;
BEGIN
  FOR entry IN SELECT a.grantee FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='snapshot_query_directories'::regclass AND a.privilege_type='INSERT' LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %s',pg_get_serial_sequence('snapshot_query_directories','directory_id'),grantee_name);
  END LOOP;
END $$;
DELETE FROM schema_migrations WHERE version='0025_snapshot_directory_generations';
COMMIT;
