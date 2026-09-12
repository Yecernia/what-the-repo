BEGIN;

ALTER TABLE provider_keys
    ADD COLUMN IF NOT EXISTS connection_id text NOT NULL DEFAULT 'legacy';

ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_pkey;
ALTER TABLE provider_keys ADD PRIMARY KEY (owner_id, connection_id);

INSERT INTO schema_migrations(version)
VALUES ('0003_provider_connections')
ON CONFLICT DO NOTHING;

COMMIT;
