BEGIN;

ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
    ADD COLUMN IF NOT EXISTS purge_after timestamptz;

CREATE INDEX IF NOT EXISTS app_users_guest_retention_idx
    ON app_users(last_seen_at, purge_after)
    WHERE owner_id LIKE 'guest:%';

CREATE TABLE IF NOT EXISTS canonical_public_repository_heads (
    repository_identity text NOT NULL,
    analyzer_bundle_version text NOT NULL,
    analysis_config_digest text NOT NULL,
    current_public_snapshot_key text
        REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE SET NULL,
    current_commit_sha text,
    last_checked_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(repository_identity, analyzer_bundle_version, analysis_config_digest)
);

CREATE TABLE IF NOT EXISTS repository_analysis_updates (
    update_id text PRIMARY KEY,
    repository_identity text NOT NULL,
    analyzer_bundle_version text NOT NULL,
    analysis_config_digest text NOT NULL,
    target_commit_sha text,
    status text NOT NULL,
    leader_project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    result_public_snapshot_key text
        REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE SET NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS repository_analysis_updates_active_idx
    ON repository_analysis_updates(repository_identity, analyzer_bundle_version, analysis_config_digest)
    WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS repository_analysis_update_projects (
    update_id text NOT NULL REFERENCES repository_analysis_updates(update_id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(update_id, project_id)
);

CREATE INDEX IF NOT EXISTS repository_analysis_update_projects_project_idx
    ON repository_analysis_update_projects(project_id, created_at DESC);

ALTER TABLE analysis_jobs
    ADD COLUMN IF NOT EXISTS repository_update_id text
        REFERENCES repository_analysis_updates(update_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS execution_role text NOT NULL DEFAULT 'standalone',
    ADD COLUMN IF NOT EXISTS language_overlay_key text;

CREATE INDEX IF NOT EXISTS analysis_jobs_repository_update_idx
    ON analysis_jobs(repository_update_id, execution_role, status);

CREATE INDEX IF NOT EXISTS analysis_jobs_language_overlay_idx
    ON analysis_jobs(language_overlay_key, execution_role, status);

CREATE TABLE IF NOT EXISTS public_snapshot_language_overlays (
    public_snapshot_key text NOT NULL
        REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE CASCADE,
    language text NOT NULL,
    status text NOT NULL,
    payload jsonb,
    generated_at timestamptz,
    error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(public_snapshot_key, language)
);

CREATE TABLE IF NOT EXISTS repository_revision_redirects (
    repository_identity text NOT NULL,
    from_public_snapshot_key text NOT NULL,
    to_public_snapshot_key text NOT NULL,
    old_path text NOT NULL,
    old_stable_id text NOT NULL DEFAULT '',
    redirect_kind text NOT NULL,
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(from_public_snapshot_key, to_public_snapshot_key, old_path, old_stable_id)
);

CREATE INDEX IF NOT EXISTS repository_revision_redirects_lookup_idx
    ON repository_revision_redirects(from_public_snapshot_key, to_public_snapshot_key, old_path);

ALTER TABLE canonical_public_repository_snapshots
    ADD COLUMN IF NOT EXISTS retired_at timestamptz,
    ADD COLUMN IF NOT EXISTS purge_after timestamptz,
    ADD COLUMN IF NOT EXISTS payload_purged_at timestamptz,
    ADD COLUMN IF NOT EXISTS language_overlay_version text;

CREATE INDEX IF NOT EXISTS canonical_public_repository_snapshots_purge_idx
    ON canonical_public_repository_snapshots(purge_after)
    WHERE payload_purged_at IS NULL;

CREATE TABLE IF NOT EXISTS owner_merge_receipts (
    receipt_id text PRIMARY KEY,
    target_owner_id text NOT NULL REFERENCES app_users(owner_id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz
);

INSERT INTO schema_migrations(version)
VALUES ('0006_repository_lifecycle')
ON CONFLICT DO NOTHING;

COMMIT;
