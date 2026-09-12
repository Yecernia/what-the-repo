BEGIN;
DROP TABLE IF EXISTS evolution_tasks;
DELETE FROM schema_migrations WHERE version = '0010_evolution_tasks';
COMMIT;
