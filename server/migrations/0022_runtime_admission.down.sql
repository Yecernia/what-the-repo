BEGIN;
DROP INDEX IF EXISTS analysis_jobs_active_scheduling;
DROP TABLE IF EXISTS analysis_participants;
DROP TABLE IF EXISTS analysis_scheduler_owners;
DROP TABLE IF EXISTS runtime_permits;
-- Drain active different-version jobs before downgrading; never delete queued work.
DROP INDEX repository_analysis_updates_active_idx;
CREATE UNIQUE INDEX repository_analysis_updates_active_idx
  ON repository_analysis_updates(repository_identity, analyzer_bundle_version, analysis_config_digest)
  WHERE status IN ('queued','running');
DELETE FROM schema_migrations WHERE version='0022_runtime_admission';
COMMIT;
