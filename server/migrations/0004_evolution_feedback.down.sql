BEGIN;
DROP TABLE IF EXISTS evolution_feedback_requests;
DELETE FROM schema_migrations WHERE version = '0004_evolution_feedback';
COMMIT;
