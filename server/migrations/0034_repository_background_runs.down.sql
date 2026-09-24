BEGIN;
DROP TABLE IF EXISTS repository_background_runs;
ALTER TABLE repository_background_update_budget DROP COLUMN IF EXISTS settled_at;
DELETE FROM schema_migrations WHERE version = '0034_repository_background_runs';
COMMIT;
