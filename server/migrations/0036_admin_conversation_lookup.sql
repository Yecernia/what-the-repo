BEGIN;

-- Storage's last-use lookup probes a bounded set of snapshot IDs. Keep that
-- lookup independent of the total number of conversation messages.
CREATE INDEX project_messages_user_snapshot_created_idx
  ON project_messages ((payload->>'analysis_snapshot_id'), created_at DESC)
  WHERE role='user' AND payload ? 'analysis_snapshot_id';

CREATE INDEX analysis_jobs_admin_recent_idx ON analysis_jobs(created_at DESC);
CREATE INDEX projects_admin_recent_idx ON projects(updated_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0036_admin_conversation_lookup');
COMMIT;
