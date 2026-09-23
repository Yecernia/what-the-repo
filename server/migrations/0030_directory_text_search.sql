BEGIN;

-- Building both indexes can take longer than the application query timeout.
-- A short lock timeout prevents the final name swap from waiting behind traffic.
SET LOCAL statement_timeout = '45min';
SET LOCAL lock_timeout = '5s';
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Every product text lookup also constrains directory_id. Keep the old indexes
-- available for reads while the replacements are built.
CREATE INDEX snapshot_directory_nodes_text_next_idx
  ON snapshot_directory_nodes USING gin (directory_id int8_ops, search_text gin_trgm_ops);
CREATE INDEX snapshot_directory_edges_text_next_idx
  ON snapshot_directory_edges USING gin (directory_id int8_ops, search_text gin_trgm_ops);

DROP INDEX snapshot_directory_nodes_text_idx;
ALTER INDEX snapshot_directory_nodes_text_next_idx RENAME TO snapshot_directory_nodes_text_idx;
DROP INDEX snapshot_directory_edges_text_idx;
ALTER INDEX snapshot_directory_edges_text_next_idx RENAME TO snapshot_directory_edges_text_idx;

INSERT INTO schema_migrations(version) VALUES ('0030_directory_text_search');
COMMIT;
