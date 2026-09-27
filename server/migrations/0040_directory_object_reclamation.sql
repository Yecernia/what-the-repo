BEGIN;

-- A staging generation may fail before the canonical snapshot exists. Keep
-- deletion work independent of both rows so crashes cannot lose the object keys.
CREATE TABLE directory_object_deletions (
  object_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text
);
CREATE INDEX directory_object_deletions_ready_idx ON directory_object_deletions(next_attempt_at);
DO $$
DECLARE grant_row record; role_name text;
BEGIN
  FOR grant_row IN SELECT a.* FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='snapshot_directory_reclamation'::regclass LOOP
    role_name := CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END;
    EXECUTE format('GRANT %s ON directory_object_deletions TO %s%s',grant_row.privilege_type,role_name,
      CASE WHEN grant_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('0040_directory_object_reclamation');
COMMIT;
