BEGIN;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_source_manifest_integrity_ck;

ALTER TABLE canonical_public_repository_snapshots
    DROP COLUMN IF EXISTS source_manifest_sha256,
    DROP COLUMN IF EXISTS source_manifest_bytes,
    DROP COLUMN IF EXISTS source_file_count;

DELETE FROM schema_migrations WHERE version = '0012_source_snapshot_manifest';

COMMIT;
