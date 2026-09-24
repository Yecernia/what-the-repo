BEGIN;

-- An uncapped background update reserves nothing, so settlement needs its own
-- marker instead of a positive reservation. Rows already at zero are settled.
ALTER TABLE repository_background_update_budget ADD COLUMN settled_at timestamptz;
UPDATE repository_background_update_budget SET settled_at=created_at WHERE reserved_usd=0;

-- One row per background scheduler pass, kept for a week, so operators can see
-- which repositories were examined and why nothing started.
CREATE TABLE repository_background_runs (
  run_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome jsonb NOT NULL,
  error text
);
CREATE INDEX repository_background_runs_started_idx ON repository_background_runs(started_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0034_repository_background_runs');
COMMIT;
