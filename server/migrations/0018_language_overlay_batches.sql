BEGIN;

ALTER TABLE semantic_batches DROP CONSTRAINT semantic_batches_phase_check;
ALTER TABLE semantic_batches ADD CONSTRAINT semantic_batches_phase_check CHECK (phase IN (
    'architecture_components', 'architecture_repair', 'architecture_layers', 'value_discovery', 'language_overlay'
));

INSERT INTO schema_migrations(version) VALUES ('0018_language_overlay_batches') ON CONFLICT DO NOTHING;
COMMIT;
