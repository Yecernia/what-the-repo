BEGIN;
DROP INDEX IF EXISTS project_messages_user_snapshot_created_idx;
DROP INDEX IF EXISTS analysis_jobs_admin_recent_idx;
DROP INDEX IF EXISTS projects_admin_recent_idx;
DELETE FROM schema_migrations WHERE version='0036_admin_conversation_lookup';
COMMIT;
