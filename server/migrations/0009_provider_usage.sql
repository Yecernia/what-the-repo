BEGIN;

CREATE TABLE IF NOT EXISTS provider_usage_events (
    event_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'cancelled')),
    reserved_cost_usd numeric(18, 8) NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
    cost_usd numeric(18, 8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cached_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS provider_usage_owner_started_idx
    ON provider_usage_events(owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS provider_usage_owner_completed_idx
    ON provider_usage_events(owner_id, completed_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0009_provider_usage')
ON CONFLICT DO NOTHING;

COMMIT;
