BEGIN;

ALTER TABLE canonical_public_repository_snapshots
    ADD COLUMN IF NOT EXISTS manifest_storage_key text,
    ADD COLUMN IF NOT EXISTS manifest_sha256 text,
    ADD COLUMN IF NOT EXISTS manifest_bytes bigint,
    ADD COLUMN IF NOT EXISTS view_sha256 text,
    ADD COLUMN IF NOT EXISTS view_bytes bigint,
    ADD COLUMN IF NOT EXISTS analysis_sha256 text,
    ADD COLUMN IF NOT EXISTS analysis_bytes bigint;

ALTER TABLE canonical_public_repository_snapshots
    DROP CONSTRAINT IF EXISTS canonical_public_snapshots_manifest_integrity_ck;

ALTER TABLE canonical_public_repository_snapshots
    ADD CONSTRAINT canonical_public_snapshots_manifest_integrity_ck
        CHECK (
            payload_purged_at IS NOT NULL
            OR (
                manifest_storage_key IS NULL
                AND manifest_sha256 IS NULL
                AND manifest_bytes IS NULL
                AND view_sha256 IS NULL
                AND view_bytes IS NULL
                AND analysis_sha256 IS NULL
                AND analysis_bytes IS NULL
            )
            OR (
                manifest_storage_key IS NOT NULL
                AND manifest_sha256 ~ '^[a-f0-9]{64}$'
                AND manifest_bytes >= 0
                AND view_sha256 ~ '^[a-f0-9]{64}$'
                AND view_bytes >= 0
                AND analysis_sha256 ~ '^[a-f0-9]{64}$'
                AND analysis_bytes >= 0
            )
        );

INSERT INTO schema_migrations(version)
VALUES ('0011_snapshot_manifest_integrity')
ON CONFLICT DO NOTHING;

COMMIT;
