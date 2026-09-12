BEGIN;

-- NULL preserves the uncertainty of historical records; do not infer old bills.
ALTER TABLE provider_usage_events ADD COLUMN usage_known boolean;

INSERT INTO schema_migrations(version) VALUES ('0019_provider_usage_known');

COMMIT;
