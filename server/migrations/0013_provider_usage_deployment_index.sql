BEGIN;

CREATE INDEX IF NOT EXISTS provider_usage_started_idx
    ON provider_usage_events(started_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0013_provider_usage_deployment_index')
ON CONFLICT DO NOTHING;

COMMIT;
