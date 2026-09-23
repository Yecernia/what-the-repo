BEGIN;

-- Only reservations created with a PostgreSQL model permit can be recovered
-- from an expired permit. Historical and local reservations remain unbound.
ALTER TABLE provider_usage_events
  ADD COLUMN lease_namespace text,
  ADD COLUMN lease_id text;

CREATE INDEX provider_usage_reserved_lease_idx
  ON provider_usage_events(started_at, event_id)
  WHERE status='reserved' AND lease_namespace IS NOT NULL AND lease_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('0029_provider_usage_lease');
COMMIT;
