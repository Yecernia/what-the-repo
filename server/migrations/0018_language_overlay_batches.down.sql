BEGIN;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM semantic_batches WHERE phase = 'language_overlay') THEN
        RAISE EXCEPTION 'Cannot roll back while language overlay batches exist; preserve them and resolve explicitly';
    END IF;
END $$;
ALTER TABLE semantic_batches DROP CONSTRAINT semantic_batches_phase_check;
ALTER TABLE semantic_batches ADD CONSTRAINT semantic_batches_phase_check CHECK (phase IN (
    'architecture_components', 'architecture_repair', 'architecture_layers', 'value_discovery'
));

DELETE FROM schema_migrations WHERE version = '0018_language_overlay_batches';
COMMIT;
