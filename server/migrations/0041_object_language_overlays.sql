BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public_snapshot_language_overlays) THEN
    RAISE EXCEPTION 'storage_format_reset_required: initialize a clean analysis database before applying object-backed language overlays';
  END IF;
END $$;

ALTER TABLE public_snapshot_language_overlays
  DROP COLUMN payload,
  ADD COLUMN object_key text,
  ADD COLUMN object_sha256 text,
  ADD COLUMN object_bytes bigint,
  ADD COLUMN schema_version text,
  ADD COLUMN conversation_summary_payload jsonb,
  ADD CONSTRAINT language_overlay_object_descriptor CHECK (
    (object_key IS NULL AND object_sha256 IS NULL AND object_bytes IS NULL AND schema_version IS NULL)
    OR (object_key IS NOT NULL AND object_sha256 IS NOT NULL AND object_sha256 ~ '^[a-f0-9]{64}$'
      AND object_bytes IS NOT NULL AND object_bytes > 0
      AND schema_version IS NOT NULL AND schema_version = 'snapshot-language-overlay-v1')),
  ADD CONSTRAINT language_overlay_summary_byte_limit CHECK (
    conversation_summary_payload IS NULL OR octet_length(conversation_summary_payload::text) <= 32768);

CREATE FUNCTION account_language_overlay_object_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_key text; previous_bytes bigint := 0; next_bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    target_key := OLD.public_snapshot_key;
    previous_bytes := COALESCE(OLD.object_bytes, 0);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    target_key := NEW.public_snapshot_key;
    next_bytes := COALESCE(NEW.object_bytes, 0);
  END IF;
  UPDATE canonical_public_repository_snapshots
    SET logical_bytes = GREATEST(0, logical_bytes + next_bytes - previous_bytes)
    WHERE public_snapshot_key = target_key;
  RETURN NULL;
END $$;
CREATE TRIGGER language_overlay_object_accounting
  AFTER INSERT OR UPDATE OF object_bytes OR DELETE ON public_snapshot_language_overlays
  FOR EACH ROW EXECUTE FUNCTION account_language_overlay_object_bytes();

INSERT INTO schema_migrations(version) VALUES ('0041_object_language_overlays');
COMMIT;
