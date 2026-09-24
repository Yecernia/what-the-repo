BEGIN;

-- The old head table is retained as migration input and compatibility cache.
-- A repository has one authoritative current snapshot across analyzer versions.
CREATE TABLE canonical_public_repositories (
  repository_identity text PRIMARY KEY,
  current_public_snapshot_key text REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE SET NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  published_at timestamptz,
  last_real_use_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  upstream_commit_sha text,
  behind_commits integer CHECK (behind_commits >= 0),
  head_relation text NOT NULL DEFAULT 'unknown'
    CHECK (head_relation IN ('same','ahead','diverged','rewound','unknown')),
  head_check_status text NOT NULL DEFAULT 'idle'
    CHECK (head_check_status IN ('idle','checking','ok','failed')),
  head_error_code text,
  last_background_started_at timestamptz,
  suppressed_target_sha text,
  suppressed_analyzer_bundle_version text,
  suppressed_analysis_config_digest text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repository_current_conflicts (
  repository_identity text PRIMARY KEY REFERENCES canonical_public_repositories(repository_identity) ON DELETE CASCADE,
  candidate_public_snapshot_keys text[] NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- Several legacy heads (one per analyzer/config) may disagree. Keep the newest
-- readable one current so no repository loses its usable view; the conflict
-- table below records the alternatives for maintainer review.
INSERT INTO canonical_public_repositories(repository_identity, current_public_snapshot_key, generation, published_at, last_checked_at)
SELECT DISTINCT ON (head.repository_identity)
       head.repository_identity, head.current_public_snapshot_key, 1, snapshot.created_at,
       max(head.last_checked_at) OVER (PARTITION BY head.repository_identity)
FROM canonical_public_repository_heads AS head
JOIN canonical_public_repository_snapshots AS snapshot
  ON snapshot.public_snapshot_key = head.current_public_snapshot_key AND snapshot.payload_purged_at IS NULL
ORDER BY head.repository_identity, snapshot.created_at DESC, head.current_public_snapshot_key;

INSERT INTO repository_current_conflicts(repository_identity, candidate_public_snapshot_keys)
SELECT repository_identity, array_agg(DISTINCT current_public_snapshot_key ORDER BY current_public_snapshot_key)
FROM canonical_public_repository_heads
WHERE current_public_snapshot_key IS NOT NULL
GROUP BY repository_identity
HAVING count(DISTINCT current_public_snapshot_key) > 1;

-- A repository may also have published snapshots without a legacy head.
INSERT INTO canonical_public_repositories(repository_identity)
SELECT DISTINCT repository_identity FROM canonical_public_repository_snapshots
ON CONFLICT DO NOTHING;

-- Legacy retired snapshots received no grace period. Give still-readable rows
-- one transition window without changing their original retirement timestamp.
UPDATE canonical_public_repository_snapshots
SET purge_after = now() + interval '24 hours'
WHERE retired_at IS NOT NULL AND payload_purged_at IS NULL
  AND (purge_after IS NULL OR purge_after < now() + interval '24 hours');

-- Deployment must drain old active tasks before this stronger uniqueness rule.
ALTER TABLE repository_analysis_updates
  ADD COLUMN base_generation bigint,
  ADD COLUMN base_public_snapshot_key text
    REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE SET NULL,
  ADD COLUMN update_trigger text NOT NULL DEFAULT 'manual'
    CHECK (update_trigger IN ('initial','manual','background'));
DROP INDEX repository_analysis_updates_active_idx;
CREATE UNIQUE INDEX repository_analysis_updates_active_idx
  ON repository_analysis_updates(repository_identity)
  WHERE status IN ('queued','running');
CREATE INDEX canonical_public_repositories_background_due_idx
  ON canonical_public_repositories(next_check_at, last_real_use_at)
  WHERE current_public_snapshot_key IS NOT NULL;

CREATE TABLE repository_background_daily_usage (
  usage_date date PRIMARY KEY,
  starts integer NOT NULL DEFAULT 0 CHECK (starts >= 0),
  reserved_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0)
);

CREATE TABLE repository_background_update_budget (
  update_id text PRIMARY KEY REFERENCES repository_analysis_updates(update_id) ON DELETE CASCADE,
  usage_date date NOT NULL REFERENCES repository_background_daily_usage(usage_date),
  reserved_usd numeric(14,6) NOT NULL CHECK (reserved_usd >= 0),
  spent_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_read_leases (
  lease_id text PRIMARY KEY,
  public_snapshot_key text NOT NULL REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX snapshot_read_leases_active_idx ON snapshot_read_leases(public_snapshot_key, expires_at);

-- Work is committed before object deletion. A retry can resume after a crash.
CREATE TABLE snapshot_payload_deletions (
  public_snapshot_key text NOT NULL REFERENCES canonical_public_repository_snapshots(public_snapshot_key) ON DELETE CASCADE,
  object_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  last_error text,
  PRIMARY KEY(public_snapshot_key, object_key)
);
CREATE INDEX snapshot_payload_deletions_pending_idx
  ON snapshot_payload_deletions(next_attempt_at)
  WHERE deleted_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('0033_repository_current_and_retired_cleanup');
COMMIT;
