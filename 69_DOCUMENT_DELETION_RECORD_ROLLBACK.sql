-- ============================================================================
-- 69 — ROLLBACK
-- ============================================================================
--
-- Removes exactly what 69 added and nothing else.
--
-- IT TOUCHES NO OTHER MIGRATION'S OBJECTS. This is stated because the first
-- draft of 68 did exactly that: it re-created migration 65's
-- fn_farmer_document_review_event under the guise of its own work, and the only
-- thing that caught it was a catalog hash in the fixture harness. Every
-- function and trigger dropped below is one that 69 itself created.
--
-- THE RECORDS ARE KEPT WHEN THERE ARE ANY. Dropping farmer_document_deletions
-- while it holds rows would destroy the only evidence that any document was
-- ever removed — the precise harm 69 exists to prevent, performed by the
-- migration meant to undo it. So a populated table survives a rollback unless
-- the operator explicitly asks otherwise:
--
--     SET ddp.rollback_69_destroy_records = 'yes I am destroying the deletion records';
--
-- Same opt-in shape the audit-critical rollbacks in this corpus already use.
--
-- AN EMPTY TABLE IS SIMPLY DROPPED, because protecting zero rows is not a
-- safety property — it is residue, and it would leave the database a different
-- shape from the one the operator rolled back to. The first draft kept the
-- table unconditionally; the rollback-symmetry check caught it and was right.
--
-- Note the append-only guards are NOT dropped up front: doing so would leave a
-- window in which the records were mutable, which is the state this migration
-- exists to prevent. They come off with the table itself or not at all.
--
-- THE LEDGER ROW IS AMENDED, NOT DELETED. Migration 67 refuses DELETE on
-- public.schema_migrations by trigger — deliberately, because a record of what
-- was applied is not improved by being erasable. A rolled-back migration was
-- still applied once, so the row stays and its evidence says what happened.
-- ============================================================================

BEGIN;

-- ── The gate on farmer_documents ────────────────────────────────────────────
DROP TRIGGER IF EXISTS farmer_documents_record_deletion ON public.farmer_documents;
DROP TRIGGER IF EXISTS farmer_documents_no_truncate     ON public.farmer_documents;
DROP FUNCTION IF EXISTS public.record_document_deletion();
DROP FUNCTION IF EXISTS public.refuse_document_truncate();

-- ── The records themselves ──────────────────────────────────────────────────
DO $records$
DECLARE
  opt_in text := coalesce(current_setting('ddp.rollback_69_destroy_records', true), '');
  held   bigint;
BEGIN
  IF to_regclass('public.farmer_document_deletions') IS NULL THEN
    RAISE NOTICE '69 rollback: no deletion record table present; nothing to keep or destroy.';
    RETURN;
  END IF;

  SELECT count(*) INTO held FROM public.farmer_document_deletions;

  -- AN EMPTY TABLE PROTECTS NOTHING, and keeping it makes the rollback
  -- asymmetric for no benefit — the database would not return to its pre-apply
  -- shape, which is the property the harness checks and the property an
  -- operator undoing a bad apply is entitled to. So the record survives a
  -- rollback only when there is actually something recorded in it.
  --
  -- (The first draft kept it unconditionally. The rollback-symmetry check
  -- caught that, correctly: protecting zero rows is not a safety property, it
  -- is residue.)
  IF held = 0 OR opt_in = 'yes I am destroying the deletion records' THEN
    -- DROP TABLE removes the table's own triggers with it; they are never
    -- dropped separately, so the records are immutable right up to the moment
    -- they cease to exist.
    -- Written as a plain statement, not EXECUTE: the static rollback-symmetry
    -- gate reads this file as text, and a DROP hidden inside a string literal
    -- is invisible to it. A check that cannot see the drop reports the object
    -- as never reversed — correctly, since it has no way to know otherwise.
    DROP TABLE public.farmer_document_deletions;
    DROP FUNCTION IF EXISTS public.refuse_document_deletion_mutation();
    IF held = 0 THEN
      RAISE NOTICE '69 rollback: deletion record table removed (it held no records).';
    ELSE
      RAISE NOTICE '69 rollback: % deletion record(s) DESTROYED at operator request.', held;
    END IF;
  ELSE
    RAISE NOTICE
      '69 rollback: the gate is removed; % deletion record(s) KEPT, still append-only. '
      'Destroying the only evidence that documents were removed is the harm this '
      'migration exists to prevent, so it needs an explicit opt-in: '
      'SET ddp.rollback_69_destroy_records = ''yes I am destroying the deletion records'';', held;
  END IF;
END
$records$;

-- ── The ledger keeps telling the truth about this database ──────────────────
-- Amended rather than removed: 67 refuses DELETE here, and a migration that was
-- applied and then rolled back is not the same thing as one that never ran.
UPDATE public.schema_migrations
   SET evidence = 'rolled back ' || to_char(now(), 'YYYY-MM-DD') || ' by ' || current_user
       || ' — was applied, then reversed by 69_DOCUMENT_DELETION_RECORD_ROLLBACK.sql'
 WHERE number = 69;

COMMIT;
