BEGIN;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_manifest_integrity_ck;

ALTER TABLE canonical_public_repository_snapshots
    DROP COLUMN IF EXISTS manifest_storage_key,
    DROP COLUMN IF EXISTS manifest_sha256,
    DROP COLUMN IF EXISTS manifest_bytes,
    DROP COLUMN IF EXISTS view_sha256,
    DROP COLUMN IF EXISTS view_bytes,
    DROP COLUMN IF EXISTS analysis_sha256,
    DROP COLUMN IF EXISTS analysis_bytes;

DELETE FROM schema_migrations WHERE version = '0011_snapshot_manifest_integrity';

COMMIT;
