BEGIN;

SET LOCAL statement_timeout = '45min';
SET LOCAL lock_timeout = '5s';

-- Restore the original single-column indexes before removing the composite
-- versions. btree_gin may be shared by other objects, so leave it installed.
CREATE INDEX snapshot_directory_nodes_text_single_idx
  ON snapshot_directory_nodes USING gin (search_text gin_trgm_ops);
CREATE INDEX snapshot_directory_edges_text_single_idx
  ON snapshot_directory_edges USING gin (search_text gin_trgm_ops);

DROP INDEX snapshot_directory_nodes_text_idx;
ALTER INDEX snapshot_directory_nodes_text_single_idx RENAME TO snapshot_directory_nodes_text_idx;
DROP INDEX snapshot_directory_edges_text_idx;
ALTER INDEX snapshot_directory_edges_text_single_idx RENAME TO snapshot_directory_edges_text_idx;

DELETE FROM schema_migrations WHERE version='0030_directory_text_search';
COMMIT;
