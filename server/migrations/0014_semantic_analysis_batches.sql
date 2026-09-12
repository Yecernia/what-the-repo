BEGIN;

CREATE TABLE IF NOT EXISTS semantic_batches (
    job_id text NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE,
    batch_id text NOT NULL,
    snapshot_id text NOT NULL,
    phase text NOT NULL CHECK (phase IN (
        'architecture_components', 'architecture_repair', 'architecture_layers', 'value_discovery'
    )),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    input_digest text NOT NULL,
    output_digest text,
    status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    attempt integer NOT NULL CHECK (attempt >= 0),
    lease_owner text,
    lease_expires_at timestamptz,
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    output jsonb,
    error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    PRIMARY KEY (job_id, batch_id)
);

CREATE INDEX IF NOT EXISTS semantic_batches_order_idx
    ON semantic_batches(job_id, ordinal, batch_id);
CREATE INDEX IF NOT EXISTS semantic_batches_status_idx
    ON semantic_batches(job_id, status, updated_at);

INSERT INTO schema_migrations(version)
VALUES ('0014_semantic_analysis_batches')
ON CONFLICT DO NOTHING;

COMMIT;
