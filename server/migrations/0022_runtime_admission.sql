BEGIN;
-- Short transactions own capacity; model/tool execution never pins a connection.
CREATE TABLE runtime_permits (
  namespace text NOT NULL,
  permit_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(namespace, permit_id)
);
CREATE TABLE analysis_scheduler_owners (
  owner_id text PRIMARY KEY,
  last_served bigint NOT NULL DEFAULT 0
);
CREATE TABLE analysis_participants (
  job_id text PRIMARY KEY REFERENCES analysis_jobs(job_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'running'))
);
CREATE INDEX analysis_jobs_active_scheduling ON analysis_jobs(status, created_at)
  WHERE status IN ('queued', 'running');

-- Unknown targets share only with unknown targets; known commits remain distinct.
DROP INDEX repository_analysis_updates_active_idx;
CREATE UNIQUE INDEX repository_analysis_updates_active_idx
  ON repository_analysis_updates(repository_identity, analyzer_bundle_version,
    analysis_config_digest, COALESCE(target_commit_sha,''))
  WHERE status IN ('queued','running');
INSERT INTO schema_migrations(version) VALUES ('0022_runtime_admission');
COMMIT;
