BEGIN;

CREATE INDEX IF NOT EXISTS canonical_public_repository_snapshots_latest_idx
    ON canonical_public_repository_snapshots(
        repository_identity,
        analyzer_bundle_version,
        analysis_config_digest,
        created_at DESC
    );

INSERT INTO schema_migrations(version)
VALUES ('0002_incremental_analysis')
ON CONFLICT DO NOTHING;

COMMIT;
