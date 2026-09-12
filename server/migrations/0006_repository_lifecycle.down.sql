BEGIN;

DROP TABLE IF EXISTS owner_merge_receipts;
DROP TABLE IF EXISTS repository_revision_redirects;
DROP TABLE IF EXISTS public_snapshot_language_overlays;
DROP TABLE IF EXISTS repository_analysis_update_projects;
DROP INDEX IF EXISTS analysis_jobs_repository_update_idx;
DROP INDEX IF EXISTS analysis_jobs_language_overlay_idx;
ALTER TABLE analysis_jobs
    DROP COLUMN IF EXISTS language_overlay_key,
    DROP COLUMN IF EXISTS execution_role,
    DROP COLUMN IF EXISTS repository_update_id;
DROP TABLE IF EXISTS repository_analysis_updates;
DROP TABLE IF EXISTS canonical_public_repository_heads;

DROP INDEX IF EXISTS canonical_public_repository_snapshots_purge_idx;
ALTER TABLE canonical_public_repository_snapshots
    DROP COLUMN IF EXISTS language_overlay_version,
    DROP COLUMN IF EXISTS payload_purged_at,
    DROP COLUMN IF EXISTS purge_after,
    DROP COLUMN IF EXISTS retired_at;

DROP INDEX IF EXISTS app_users_guest_retention_idx;
ALTER TABLE app_users
    DROP COLUMN IF EXISTS purge_after,
    DROP COLUMN IF EXISTS deleted_at,
    DROP COLUMN IF EXISTS last_seen_at;

DELETE FROM schema_migrations WHERE version = '0006_repository_lifecycle';

COMMIT;
