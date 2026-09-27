BEGIN;
CREATE TABLE memory_work (
  project_id text PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
  requested bigint NOT NULL DEFAULT 1,
  completed bigint NOT NULL DEFAULT 0,
  processed jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX memory_work_pending_idx ON memory_work(available_at) WHERE requested > completed;
DO $$ DECLARE entry record; grantee_name text; BEGIN
  FOR entry IN SELECT a.* FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='pi_memories'::regclass LOOP
    grantee_name := CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END;
    EXECUTE format('GRANT %s ON memory_work TO %s%s',entry.privilege_type,grantee_name,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('0043_memory_work');
COMMIT;
