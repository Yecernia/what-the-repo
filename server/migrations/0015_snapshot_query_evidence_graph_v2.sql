BEGIN;

ALTER TABLE snapshot_query_nodes
    ADD COLUMN IF NOT EXISTS entity_kind text NOT NULL DEFAULT 'component',
    ADD COLUMN IF NOT EXISTS parent_entity_id text,
    ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0);

CREATE INDEX IF NOT EXISTS snapshot_query_nodes_entity_idx
    ON snapshot_query_nodes(public_snapshot_key, entity_kind, node_id);
CREATE INDEX IF NOT EXISTS snapshot_query_nodes_parent_idx
    ON snapshot_query_nodes(public_snapshot_key, parent_entity_id, depth, node_key);

CREATE TABLE IF NOT EXISTS snapshot_query_overlay_memberships (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    overlay_id text NOT NULL,
    overlay_kind text NOT NULL,
    entity_id text NOT NULL DEFAULT '',
    relation_id text,
    role text NOT NULL CHECK (role IN ('member', 'relation')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, overlay_id, entity_id, relation_id, role)
);
CREATE INDEX IF NOT EXISTS snapshot_query_overlay_memberships_entity_idx
    ON snapshot_query_overlay_memberships(public_snapshot_key, entity_id, overlay_kind);
CREATE INDEX IF NOT EXISTS snapshot_query_overlay_memberships_overlay_idx
    ON snapshot_query_overlay_memberships(public_snapshot_key, overlay_id, role);

CREATE TABLE IF NOT EXISTS snapshot_query_projection_nodes (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    projection_kind text NOT NULL CHECK (projection_kind IN ('human', 'agent')),
    projection_node_id text NOT NULL,
    entity_id text NOT NULL,
    parent_projection_node_id text,
    depth integer NOT NULL CHECK (depth >= 0),
    aggregate_member_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, projection_kind, projection_node_id)
);
CREATE INDEX IF NOT EXISTS snapshot_query_projection_nodes_entity_idx
    ON snapshot_query_projection_nodes(public_snapshot_key, projection_kind, entity_id, depth);

CREATE TABLE IF NOT EXISTS snapshot_query_projection_edges (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    projection_kind text NOT NULL CHECK (projection_kind IN ('human', 'agent')),
    projection_edge_id text NOT NULL,
    relation_id text,
    source_projection_node_id text NOT NULL,
    target_projection_node_id text NOT NULL,
    source_entity_id text NOT NULL,
    target_entity_id text NOT NULL,
    aggregate_relation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, projection_kind, projection_edge_id)
);
CREATE INDEX IF NOT EXISTS snapshot_query_projection_edges_entity_idx
    ON snapshot_query_projection_edges(public_snapshot_key, projection_kind, source_entity_id, target_entity_id);

INSERT INTO schema_migrations(version)
VALUES ('0015_snapshot_query_evidence_graph_v2')
ON CONFLICT DO NOTHING;

COMMIT;
