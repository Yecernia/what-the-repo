BEGIN;
-- A work item names exactly one retired generation; no user or credential data.
CREATE TABLE snapshot_directory_reclamation (
  directory_id bigint PRIMARY KEY REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_index integer NOT NULL DEFAULT 0 CHECK (table_index BETWEEN 0 AND 9),
  cursor_values text[],
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  rows_deleted bigint NOT NULL DEFAULT 0 CHECK (rows_deleted >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX snapshot_directory_reclamation_ready_idx ON snapshot_directory_reclamation(available_at,directory_id);
-- Enqueue already-detached committed versions, including cleanup failures before this release.
INSERT INTO snapshot_directory_reclamation(directory_id)
  SELECT g.directory_id FROM snapshot_directory_generations g
  WHERE NOT EXISTS (SELECT 1 FROM snapshot_query_directories d WHERE d.directory_id=g.directory_id);
DO $$
DECLARE entry record; grantee_name text;
BEGIN
  FOR entry IN SELECT a.* FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='snapshot_directory_generations'::regclass LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON snapshot_directory_reclamation TO %s%s',entry.privilege_type,grantee_name,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('0027_directory_reclamation');
COMMIT;
