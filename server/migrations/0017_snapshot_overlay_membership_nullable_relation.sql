BEGIN;

-- The original composite primary key makes relation_id NOT NULL in PostgreSQL.
-- The runtime role is intentionally not a table owner, so keep this migration
-- as a compatibility marker and encode member rows as an empty relation ID at
-- the persistence boundary. The in-memory/query contract remains NULL.

INSERT INTO schema_migrations(version)
VALUES ('0017_snapshot_overlay_membership_nullable_relation')
ON CONFLICT DO NOTHING;

COMMIT;
