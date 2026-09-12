BEGIN;

CREATE TABLE IF NOT EXISTS evolution_feedback_requests (
    request_id text PRIMARY KEY,
    dedupe_key text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS evolution_feedback_requests_status_created_idx
    ON evolution_feedback_requests(status, created_at);
CREATE INDEX IF NOT EXISTS evolution_feedback_requests_dedupe_idx
    ON evolution_feedback_requests(dedupe_key, status);

INSERT INTO schema_migrations(version)
VALUES ('0004_evolution_feedback')
ON CONFLICT DO NOTHING;

COMMIT;
