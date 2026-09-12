BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
    owner_id text PRIMARY KEY,
    login text NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS projects (
    project_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_messages (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id text NOT NULL UNIQUE,
    project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL,
    payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS project_messages_project_sequence_idx
    ON project_messages(project_id, sequence);

CREATE TABLE IF NOT EXISTS learner_profiles (
    owner_id text PRIMARY KEY REFERENCES app_users(owner_id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_settings (
    owner_id text PRIMARY KEY REFERENCES app_users(owner_id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_keys (
    owner_id text PRIMARY KEY REFERENCES app_users(owner_id) ON DELETE CASCADE,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    auth_tag bytea NOT NULL,
    key_version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_snapshots (
    project_id text PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    analysis_snapshot_id text NOT NULL,
    view_payload jsonb NOT NULL,
    analysis_payload jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canonical_public_repository_snapshots (
    public_snapshot_key text PRIMARY KEY,
    repository_identity text NOT NULL,
    commit_sha text NOT NULL,
    analyzer_bundle_version text NOT NULL,
    analysis_config_digest text NOT NULL,
    analysis_snapshot_id text NOT NULL,
    view_payload jsonb NOT NULL,
    analysis_payload jsonb NOT NULL,
    source_storage_key text NOT NULL,
    logical_bytes bigint NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
    reuse_count bigint NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    UNIQUE (repository_identity, commit_sha, analyzer_bundle_version, analysis_config_digest)
);
ALTER TABLE canonical_public_repository_snapshots
    ADD COLUMN IF NOT EXISTS logical_bytes bigint NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0);

CREATE TABLE IF NOT EXISTS project_public_snapshot_bindings (
    project_id text PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    public_snapshot_key text NOT NULL
        REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE RESTRICT,
    bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_public_snapshot_bindings_key_idx
    ON project_public_snapshot_bindings(public_snapshot_key);

CREATE TABLE IF NOT EXISTS analysis_jobs (
    job_id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    idempotency_key text NOT NULL UNIQUE,
    status text NOT NULL,
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    completed_at timestamptz,
    error text,
    error_code text
);
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS error_code text;
CREATE INDEX IF NOT EXISTS analysis_jobs_claim_idx
    ON analysis_jobs(status, available_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS analysis_jobs_project_idx
    ON analysis_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_quota_events (
    event_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    project_id text REFERENCES projects(project_id) ON DELETE SET NULL,
    event_kind text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_quota_events_owner_created_idx
    ON owner_quota_events(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS traces (
    event_id text PRIMARY KEY,
    trace_id text NOT NULL,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    project_id text REFERENCES projects(project_id) ON DELETE CASCADE,
    worker_run_id text,
    event_type text NOT NULL,
    created_at timestamptz NOT NULL,
    payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_trace_id_idx ON traces(trace_id);
CREATE INDEX IF NOT EXISTS traces_project_created_idx ON traces(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pi_memories (
    memory_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    scope text NOT NULL,
    memory_key text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (owner_id, memory_key)
);
CREATE INDEX IF NOT EXISTS pi_memories_owner_updated_idx ON pi_memories(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pi_sessions (
    session_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    snapshot_id text,
    skill_id text NOT NULL,
    skill_version text NOT NULL,
    metadata jsonb NOT NULL,
    lanes jsonb NOT NULL DEFAULT '{"main": null}'::jsonb,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    name text,
    next_seq bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pi_sessions_owner_project_idx ON pi_sessions(owner_id, project_id);

CREATE TABLE IF NOT EXISTS pi_session_log (
    session_id text NOT NULL REFERENCES pi_sessions(session_id) ON DELETE CASCADE,
    seq bigint NOT NULL,
    kind text NOT NULL,
    item_id text,
    item_type text,
    lane text,
    run_id text,
    operation_kind text,
    timestamp_ms bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS pi_session_log_item_idx ON pi_session_log(session_id, item_id);
CREATE INDEX IF NOT EXISTS pi_session_log_kind_type_idx ON pi_session_log(session_id, kind, item_type, seq);

INSERT INTO schema_migrations(version)
VALUES ('0001_product')
ON CONFLICT DO NOTHING;

COMMIT;
