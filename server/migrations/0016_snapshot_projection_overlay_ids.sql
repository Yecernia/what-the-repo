BEGIN;

ALTER TABLE snapshot_query_projection_nodes
    ADD COLUMN IF NOT EXISTS overlay_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE snapshot_query_projection_edges
    ADD COLUMN IF NOT EXISTS overlay_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS snapshot_query_projection_nodes_overlay_idx
    ON snapshot_query_projection_nodes(public_snapshot_key, projection_kind, overlay_ids);
CREATE INDEX IF NOT EXISTS snapshot_query_projection_edges_overlay_idx
    ON snapshot_query_projection_edges(public_snapshot_key, projection_kind, overlay_ids);

INSERT INTO schema_migrations(version)
VALUES ('0016_snapshot_projection_overlay_ids')
ON CONFLICT DO NOTHING;

COMMIT;
