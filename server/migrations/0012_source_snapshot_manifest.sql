BEGIN;

ALTER TABLE canonical_public_repository_snapshots
    ADD COLUMN IF NOT EXISTS source_manifest_sha256 text,
    ADD COLUMN IF NOT EXISTS source_manifest_bytes bigint,
    ADD COLUMN IF NOT EXISTS source_file_count integer;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_source_manifest_integrity_ck;

ALTER TABLE canonical_public_repository_snapshots
    ADD CONSTRAINT canonical_public_snapshots_source_manifest_integrity_ck
        CHECK (
            payload_purged_at IS NOT NULL
            OR (
                source_manifest_sha256 IS NULL
                AND source_manifest_bytes IS NULL
                AND source_file_count IS NULL
            )
            OR (
                source_storage_key IS NOT NULL
                AND source_manifest_sha256 ~ '^[a-f0-9]{64}$'
                AND source_manifest_bytes >= 0
                AND source_file_count >= 0
            )
        );

INSERT INTO schema_migrations(version)
VALUES ('0012_source_snapshot_manifest')
ON CONFLICT DO NOTHING;

COMMIT;
