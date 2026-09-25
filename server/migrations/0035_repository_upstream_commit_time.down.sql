BEGIN;
ALTER TABLE canonical_public_repositories DROP COLUMN IF EXISTS upstream_committed_at;
DELETE FROM schema_migrations WHERE version = '0035_repository_upstream_commit_time';
COMMIT;
