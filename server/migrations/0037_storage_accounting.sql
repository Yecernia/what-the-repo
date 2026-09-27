BEGIN;

-- Metadata only: no fact-table scan or synchronous historical backfill.
ALTER TABLE canonical_public_repository_snapshots ADD COLUMN accounting_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE snapshot_directory_generations ADD COLUMN logical_counts jsonb;

CREATE FUNCTION invalidate_snapshot_storage_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE canonical_public_repository_snapshots SET accounting_revision=accounting_revision+1
      WHERE public_snapshot_key=OLD.public_snapshot_key;
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP='INSERT' OR NEW.public_snapshot_key IS DISTINCT FROM OLD.public_snapshot_key) THEN
    UPDATE canonical_public_repository_snapshots SET accounting_revision=accounting_revision+1
      WHERE public_snapshot_key=NEW.public_snapshot_key;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER generation_storage_accounting AFTER INSERT OR UPDATE OR DELETE ON snapshot_directory_generations
  FOR EACH ROW EXECUTE FUNCTION invalidate_snapshot_storage_accounting();
CREATE TRIGGER binding_storage_accounting AFTER INSERT OR UPDATE OR DELETE ON project_public_snapshot_bindings
  FOR EACH ROW EXECUTE FUNCTION invalidate_snapshot_storage_accounting();

CREATE FUNCTION record_directory_storage_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE canonical_public_repository_snapshots SET accounting_revision=accounting_revision+1
      WHERE public_snapshot_key=OLD.public_snapshot_key;
  ELSE
    UPDATE snapshot_directory_generations SET logical_counts=COALESCE(logical_counts,'{}'::jsonb) || jsonb_build_object(
      'nodes',NEW.node_count,'edges',NEW.edge_count,'evidence',NEW.evidence_count,
      'layers',NEW.layer_count,'value_points',NEW.value_point_count)
      WHERE directory_id=NEW.directory_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER directory_storage_accounting AFTER INSERT OR UPDATE OR DELETE ON snapshot_query_directories
  FOR EACH ROW EXECUTE FUNCTION record_directory_storage_accounting();

INSERT INTO schema_migrations(version) VALUES ('0037_storage_accounting');
COMMIT;
