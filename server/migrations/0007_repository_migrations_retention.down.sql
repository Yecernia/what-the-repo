BEGIN;

DROP TABLE IF EXISTS repository_revision_links;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_source_location_ck,
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_view_location_ck,
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_analysis_location_ck;

UPDATE canonical_public_repository_snapshots
SET
    source_storage_key = COALESCE(source_storage_key, 'purged'),
    view_storage_key = COALESCE(view_storage_key, 'purged'),
    analysis_storage_key = COALESCE(analysis_storage_key, 'purged')
WHERE payload_purged_at IS NOT NULL;

ALTER TABLE canonical_public_repository_snapshots
    ALTER COLUMN source_storage_key SET NOT NULL,
    ADD CONSTRAINT canonical_public_snapshots_view_location_ck
        CHECK (view_payload IS NOT NULL OR view_storage_key IS NOT NULL),
    ADD CONSTRAINT canonical_public_snapshots_analysis_location_ck
        CHECK (analysis_payload IS NOT NULL OR analysis_storage_key IS NOT NULL);

DELETE FROM schema_migrations WHERE version = '0007_repository_migrations_retention';

COMMIT;
