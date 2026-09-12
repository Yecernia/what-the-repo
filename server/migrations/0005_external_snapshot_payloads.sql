BEGIN;

ALTER TABLE canonical_public_repository_snapshots
    ALTER COLUMN view_payload DROP NOT NULL,
    ALTER COLUMN analysis_payload DROP NOT NULL;

ALTER TABLE canonical_public_repository_snapshots
    ADD COLUMN IF NOT EXISTS view_storage_key text,
    ADD COLUMN IF NOT EXISTS analysis_storage_key text;

UPDATE canonical_public_repository_snapshots
SET
    view_storage_key = COALESCE(
        view_storage_key,
        'public-repository-snapshots/' || public_snapshot_key || '/view.json'
    ),
    analysis_storage_key = COALESCE(
        analysis_storage_key,
        'public-repository-snapshots/' || public_snapshot_key || '/analysis.json'
    );

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_view_location_ck,
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_analysis_location_ck;

ALTER TABLE canonical_public_repository_snapshots
    ADD CONSTRAINT canonical_public_snapshots_view_location_ck
        CHECK (view_payload IS NOT NULL OR view_storage_key IS NOT NULL),
    ADD CONSTRAINT canonical_public_snapshots_analysis_location_ck
        CHECK (analysis_payload IS NOT NULL OR analysis_storage_key IS NOT NULL);

INSERT INTO schema_migrations(version)
VALUES ('0005_external_snapshot_payloads')
ON CONFLICT DO NOTHING;

COMMIT;
