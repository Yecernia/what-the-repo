BEGIN;

DROP INDEX IF EXISTS canonical_public_repository_snapshots_latest_idx;
DELETE FROM schema_migrations WHERE version = '0002_incremental_analysis';

COMMIT;
