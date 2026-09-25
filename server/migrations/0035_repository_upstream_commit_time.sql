BEGIN;

-- Commit time of the upstream head found by the last check, so the page can
-- say how recent the upstream code is rather than when we last looked.
ALTER TABLE canonical_public_repositories ADD COLUMN upstream_committed_at timestamptz;

INSERT INTO schema_migrations(version) VALUES ('0035_repository_upstream_commit_time');
COMMIT;
