BEGIN;

DELETE FROM provider_keys WHERE connection_id <> 'legacy';
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_pkey;
ALTER TABLE provider_keys ADD PRIMARY KEY (owner_id);
ALTER TABLE provider_keys DROP COLUMN IF EXISTS connection_id;

COMMIT;
