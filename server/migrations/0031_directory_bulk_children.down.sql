BEGIN;

-- Keep the parent inheritance and live generations intact. A code rollback can
-- leave this additive schema in place; removing it requires all child-backed
-- generations to be retired and reclaimed first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_inherits
    WHERE inhparent IN ('public.snapshot_directory_nodes'::regclass,
                        'public.snapshot_directory_edges'::regclass)
  ) THEN
    RAISE EXCEPTION 'directory child generations still exist';
  END IF;
END $$;

DROP FUNCTION public.drop_retired_snapshot_directory_child(bigint, text);
DROP FUNCTION public.finish_snapshot_directory_child(bigint, text, bigint);
DROP FUNCTION public.stage_snapshot_directory_child(bigint, text);
ALTER TABLE public.snapshot_directory_reclamation DROP COLUMN cleanup_observed_at;
DELETE FROM schema_migrations WHERE version = '0031_directory_bulk_children';

COMMIT;
