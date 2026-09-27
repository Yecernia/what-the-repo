BEGIN;

-- One small durable intent per object avoids rewriting an ever-growing JSON
-- manifest before every PUT. Successful staging writes the full manifest once.
CREATE TABLE snapshot_directory_object_intents (
  directory_id bigint NOT NULL REFERENCES snapshot_directory_generations(directory_id) ON DELETE CASCADE,
  object_key text NOT NULL,
  PRIMARY KEY(directory_id,object_key)
);
DO $$ DECLARE entry record; grantee_name text; BEGIN
  FOR entry IN SELECT a.* FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='snapshot_directory_generations'::regclass LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON snapshot_directory_object_intents TO %s%s',entry.privilege_type,grantee_name,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES ('0042_directory_upload_intents');
COMMIT;
