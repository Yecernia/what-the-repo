BEGIN;
ALTER TABLE provider_usage_events DROP COLUMN settlement_evidence;
DELETE FROM schema_migrations WHERE version = '0028_provider_usage_settlement_evidence';
COMMIT;
