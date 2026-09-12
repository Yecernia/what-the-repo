BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM canonical_public_repository_snapshots
        WHERE view_payload IS NULL OR analysis_payload IS NULL
    ) THEN
        RAISE EXCEPTION 'restore external snapshot payloads before rolling back 0005';
    END IF;
END $$;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_view_location_ck,
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_analysis_location_ck;

ALTER TABLE canonical_public_repository_snapshots
    ALTER COLUMN view_payload SET NOT NULL,
    ALTER COLUMN analysis_payload SET NOT NULL,
    DROP COLUMN IF EXISTS view_storage_key,
    DROP COLUMN IF EXISTS analysis_storage_key;

DELETE FROM schema_migrations
WHERE version = '0005_external_snapshot_payloads';

COMMIT;
