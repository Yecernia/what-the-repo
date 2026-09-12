BEGIN;
DROP TABLE IF EXISTS snapshot_query_projection_edges;
DROP TABLE IF EXISTS snapshot_query_projection_nodes;
DROP TABLE IF EXISTS snapshot_query_overlay_memberships;
DROP INDEX IF EXISTS snapshot_query_nodes_parent_idx;
DROP INDEX IF EXISTS snapshot_query_nodes_entity_idx;
ALTER TABLE snapshot_query_nodes
    DROP COLUMN IF EXISTS depth,
    DROP COLUMN IF EXISTS parent_entity_id,
    DROP COLUMN IF EXISTS entity_kind;
COMMIT;
