BEGIN;
-- Stop the maintenance worker before rolling back; visible generations are untouched.
DROP TABLE snapshot_directory_reclamation;
DELETE FROM schema_migrations WHERE version='0027_directory_reclamation';
COMMIT;
