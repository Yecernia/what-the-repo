BEGIN;

-- This pre-release format change requires an empty analysis store. Do not label
-- existing COS objects as purged or silently orphan them during schema migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM canonical_public_repository_snapshots) THEN
    RAISE EXCEPTION 'storage_format_reset_required: initialize a clean analysis database before applying the COS-first storage format';
  END IF;
END $$;

ALTER TABLE canonical_public_repository_snapshots
  DROP COLUMN view_payload,
  DROP COLUMN analysis_payload,
  ADD COLUMN conversation_summary_payload jsonb,
  ADD CONSTRAINT canonical_conversation_summary_byte_limit
    CHECK (conversation_summary_payload IS NULL
      OR octet_length(conversation_summary_payload::text) <= 32768);

INSERT INTO schema_migrations(version) VALUES ('0039_canonical_object_payloads');
COMMIT;
