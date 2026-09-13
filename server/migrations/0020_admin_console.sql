BEGIN;
ALTER TABLE analysis_jobs ADD COLUMN config_version integer;
ALTER TABLE evolution_tasks ADD COLUMN config_version integer;
CREATE TABLE admin_documents (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admin_audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE online_presence (
  owner_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('github','guest')),
  seen_at timestamptz NOT NULL
);
CREATE TABLE admin_evolution_commands (
  id text PRIMARY KEY, task_id text NOT NULL REFERENCES evolution_tasks(task_id),
  actor text NOT NULL, action text NOT NULL CHECK(action IN ('approve','reject','rollback')),
  reason text NOT NULL, candidate_version text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  result text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz
);
CREATE UNIQUE INDEX admin_evolution_pending ON admin_evolution_commands(task_id) WHERE status IN ('pending','running');
CREATE TABLE runtime_observations (
  instance_id text PRIMARY KEY,
  role text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
ALTER TABLE provider_usage_events
  ADD COLUMN business text NOT NULL DEFAULT 'historical_unclassified',
  ADD COLUMN payer text NOT NULL DEFAULT 'historical_unclassified',
  ADD COLUMN agent_role text,
  ADD COLUMN connection_id text,
  ADD COLUMN config_version integer,
  ADD COLUMN task_id text;
-- Owner lifecycle cleanup must never refund already-spent platform budget.
ALTER TABLE provider_usage_events DROP CONSTRAINT IF EXISTS provider_usage_events_owner_id_fkey;
CREATE INDEX provider_usage_business_day ON provider_usage_events(business,payer,started_at);
CREATE INDEX provider_usage_task ON provider_usage_events(task_id) WHERE task_id IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES ('0020_admin_console');
COMMIT;
