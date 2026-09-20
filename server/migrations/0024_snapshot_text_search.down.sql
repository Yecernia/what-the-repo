BEGIN;
ALTER TABLE snapshot_directory_nodes DROP COLUMN search_text;
ALTER TABLE snapshot_directory_edges DROP COLUMN search_text;
-- pg_trgm may be shared by other application indexes; do not remove it.
DELETE FROM schema_migrations WHERE version='0024_snapshot_text_search';
COMMIT;
