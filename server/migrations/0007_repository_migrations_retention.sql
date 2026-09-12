BEGIN;

CREATE TABLE IF NOT EXISTS repository_revision_links (
    repository_identity text NOT NULL,
    from_public_snapshot_key text NOT NULL,
    to_public_snapshot_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(from_public_snapshot_key, to_public_snapshot_key)
);

CREATE INDEX IF NOT EXISTS repository_revision_links_repository_idx
    ON repository_revision_links(repository_identity, created_at);

ALTER TABLE canonical_public_repository_snapshots
    ALTER COLUMN source_storage_key DROP NOT NULL;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_view_location_ck,
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_analysis_location_ck;

ALTER TABLE canonical_public_repository_snapshots
    ADD CONSTRAINT canonical_public_snapshots_view_location_ck
        CHECK (
            payload_purged_at IS NOT NULL
            OR view_payload IS NOT NULL
            OR view_storage_key IS NOT NULL
        ),
    ADD CONSTRAINT canonical_public_snapshots_analysis_location_ck
        CHECK (
            payload_purged_at IS NOT NULL
            OR analysis_payload IS NOT NULL
            OR analysis_storage_key IS NOT NULL
        ),
    ADD CONSTRAINT canonical_public_snapshots_source_location_ck
        CHECK (payload_purged_at IS NOT NULL OR source_storage_key IS NOT NULL);

INSERT INTO schema_migrations(version)
VALUES ('0007_repository_migrations_retention')
ON CONFLICT DO NOTHING;

COMMIT;
