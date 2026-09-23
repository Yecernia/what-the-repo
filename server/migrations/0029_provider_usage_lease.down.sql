BEGIN;
DROP INDEX provider_usage_reserved_lease_idx;
ALTER TABLE provider_usage_events
  DROP COLUMN lease_namespace,
  DROP COLUMN lease_id;
DELETE FROM schema_migrations WHERE version='0029_provider_usage_lease';
COMMIT;
