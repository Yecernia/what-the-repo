BEGIN;

CREATE TABLE IF NOT EXISTS evolution_tasks (
    task_id text PRIMARY KEY,
    skill_id text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    task_payload jsonb NOT NULL,
    ledger_payload jsonb NOT NULL,
    candidate_payload jsonb,
    review_decision_payload jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS evolution_tasks_status_created_idx
    ON evolution_tasks(status, created_at, task_id);
CREATE INDEX IF NOT EXISTS evolution_tasks_skill_updated_idx
    ON evolution_tasks(skill_id, updated_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0010_evolution_tasks')
ON CONFLICT DO NOTHING;

COMMIT;
