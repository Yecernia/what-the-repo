BEGIN;
ALTER TABLE provider_usage_events DROP COLUMN usage_known;
DELETE FROM schema_migrations WHERE version = '0019_provider_usage_known';
COMMIT;
