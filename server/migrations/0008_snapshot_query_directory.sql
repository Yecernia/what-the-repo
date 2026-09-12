BEGIN;

CREATE TABLE IF NOT EXISTS snapshot_query_directories (
    public_snapshot_key text PRIMARY KEY
        REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    directory_digest text NOT NULL,
    node_count integer NOT NULL CHECK (node_count >= 0),
    edge_count integer NOT NULL CHECK (edge_count >= 0),
    evidence_count integer NOT NULL CHECK (evidence_count >= 0),
    layer_count integer NOT NULL CHECK (layer_count >= 0),
    value_point_count integer NOT NULL CHECK (value_point_count >= 0),
    ready_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshot_query_nodes (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    node_key text NOT NULL,
    node_id text NOT NULL,
    node_kind text NOT NULL,
    label text NOT NULL,
    name text NOT NULL,
    responsibility text NOT NULL,
    path text,
    language text,
    layer_id text,
    layer_name text,
    certainty text NOT NULL,
    lifecycle_status text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, node_key)
);
CREATE INDEX IF NOT EXISTS snapshot_query_nodes_search_idx
    ON snapshot_query_nodes(public_snapshot_key, node_kind, node_key);
CREATE INDEX IF NOT EXISTS snapshot_query_nodes_path_idx
    ON snapshot_query_nodes(public_snapshot_key, path);
CREATE INDEX IF NOT EXISTS snapshot_query_nodes_language_idx
    ON snapshot_query_nodes(public_snapshot_key, language);

CREATE TABLE IF NOT EXISTS snapshot_query_edges (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    edge_key text NOT NULL,
    edge_id text NOT NULL,
    edge_kind text NOT NULL,
    source_node_key text NOT NULL,
    target_node_key text NOT NULL,
    relation_kind text NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    certainty text NOT NULL,
    weight double precision NOT NULL DEFAULT 1,
    lifecycle_status text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, edge_key)
);
CREATE INDEX IF NOT EXISTS snapshot_query_edges_source_idx
    ON snapshot_query_edges(public_snapshot_key, source_node_key, edge_key);
CREATE INDEX IF NOT EXISTS snapshot_query_edges_target_idx
    ON snapshot_query_edges(public_snapshot_key, target_node_key, edge_key);
CREATE INDEX IF NOT EXISTS snapshot_query_edges_relation_idx
    ON snapshot_query_edges(public_snapshot_key, relation_kind, edge_key);

CREATE TABLE IF NOT EXISTS snapshot_query_evidence (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    evidence_id text NOT NULL,
    label text NOT NULL,
    path text NOT NULL,
    start_line integer,
    end_line integer,
    kind text NOT NULL,
    source_id text,
    target_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, evidence_id)
);
CREATE INDEX IF NOT EXISTS snapshot_query_evidence_path_idx
    ON snapshot_query_evidence(public_snapshot_key, path, evidence_id);

CREATE TABLE IF NOT EXISTS snapshot_query_evidence_links (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    evidence_id text NOT NULL,
    owner_kind text NOT NULL,
    owner_key text NOT NULL,
    role text NOT NULL,
    PRIMARY KEY (public_snapshot_key, evidence_id, owner_kind, owner_key, role),
    FOREIGN KEY (public_snapshot_key, evidence_id)
        REFERENCES snapshot_query_evidence(public_snapshot_key, evidence_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS snapshot_query_evidence_links_owner_idx
    ON snapshot_query_evidence_links(public_snapshot_key, owner_kind, owner_key);

CREATE TABLE IF NOT EXISTS snapshot_query_layers (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    layer_id text NOT NULL,
    name text NOT NULL,
    responsibility text NOT NULL,
    certainty text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, layer_id)
);

CREATE TABLE IF NOT EXISTS snapshot_query_value_points (
    public_snapshot_key text NOT NULL REFERENCES snapshot_query_directories(public_snapshot_key) ON DELETE CASCADE,
    snapshot_id text NOT NULL,
    value_point_id text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    claim text NOT NULL,
    certainty text NOT NULL,
    connectivity double precision NOT NULL DEFAULT 0,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (public_snapshot_key, value_point_id)
);

INSERT INTO schema_migrations(version)
VALUES ('0008_snapshot_query_directory')
ON CONFLICT DO NOTHING;

COMMIT;
