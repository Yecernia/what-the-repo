BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Materialize normalization once at publication, rather than stringify every
-- payload on each chat tool call. Keep these internal columns out of the views.
ALTER TABLE snapshot_directory_nodes ADD COLUMN search_text text GENERATED ALWAYS AS (
  lower(
    CASE WHEN node_key <> '' THEN node_key || ' ' ELSE '' END ||
    CASE WHEN node_id <> '' THEN node_id || ' ' ELSE '' END ||
    CASE WHEN name <> '' THEN name || ' ' ELSE '' END ||
    CASE WHEN label <> '' THEN label || ' ' ELSE '' END ||
    CASE WHEN responsibility <> '' THEN responsibility || ' ' ELSE '' END ||
    CASE WHEN path <> '' THEN path || ' ' ELSE '' END || payload::text
  )
) STORED;
ALTER TABLE snapshot_directory_edges ADD COLUMN search_text text GENERATED ALWAYS AS (
  lower(edge_key || ' ' || edge_id || ' ' || relation_kind || ' ' || label || ' ' ||
    description || ' ' || source_node_key || ' ' || target_node_key)
) STORED;
CREATE INDEX snapshot_directory_nodes_text_idx ON snapshot_directory_nodes USING gin(search_text gin_trgm_ops);
CREATE INDEX snapshot_directory_edges_text_idx ON snapshot_directory_edges USING gin(search_text gin_trgm_ops);
ANALYZE snapshot_directory_nodes;
ANALYZE snapshot_directory_edges;
INSERT INTO schema_migrations(version) VALUES ('0024_snapshot_text_search');
COMMIT;
