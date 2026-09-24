BEGIN;
DROP TABLE IF EXISTS snapshot_payload_deletions;
DROP TABLE IF EXISTS snapshot_read_leases;
DROP TABLE IF EXISTS repository_background_update_budget;
DROP TABLE IF EXISTS repository_background_daily_usage;
DROP INDEX IF EXISTS canonical_public_repositories_background_due_idx;
DROP INDEX IF EXISTS repository_analysis_updates_active_idx;
ALTER TABLE repository_analysis_updates
  DROP COLUMN IF EXISTS base_generation,
  DROP COLUMN IF EXISTS base_public_snapshot_key,
  DROP COLUMN IF EXISTS update_trigger;
CREATE UNIQUE INDEX repository_analysis_updates_active_idx
  ON repository_analysis_updates(repository_identity, analyzer_bundle_version,
    analysis_config_digest, COALESCE(target_commit_sha,''))
  WHERE status IN ('queued','running');
DROP TABLE IF EXISTS repository_current_conflicts;
DROP TABLE IF EXISTS canonical_public_repositories;
DELETE FROM schema_migrations WHERE version = '0033_repository_current_and_retired_cleanup';
COMMIT;
