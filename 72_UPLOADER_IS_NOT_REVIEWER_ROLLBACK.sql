-- ============================================================================
-- 72 — ROLLBACK
-- ============================================================================
--
-- Removes exactly what 72 added and nothing else.
--
-- IT TOUCHES NO OTHER MIGRATION'S OBJECTS. Stated because the first draft of 68
-- re-created migration 65's fn_farmer_document_review_event under the guise of
-- its own work, and only a catalog hash caught it. In particular this rollback
-- does NOT touch fn_farmer_documents_set_reviewer, enforce_evidence_decision_gate
-- or record_document_deletion — 72 created none of them. The one thing it does
-- to another migration's object is drop the column IT added to
-- farmer_document_deletions, which is 72's column on 69's table.
--
-- THE ATTRIBUTIONS ARE KEPT WHEN THERE ARE ANY. Once 72 has been live, every
-- document uploaded since carries a real person in `uploaded_by`. Dropping the
-- column discards that permanently and silently — there is no second copy, and
-- unlike a deleted document nothing anywhere else records who uploaded it. That
-- is the same class of harm 69's rollback guards against, so it takes the same
-- shape: a populated column survives a rollback unless the operator says
-- otherwise, in the same transaction:
--
--     SET ddp.rollback_72_destroy_attributions = 'yes I am destroying the uploader attributions';
--
-- AN ALL-NULL COLUMN IS SIMPLY DROPPED, because protecting zero attributions is
-- not a safety property — it is residue, and it would leave the database a
-- different shape from the one the operator rolled back to. That asymmetry is
-- exactly what the rollback-symmetry check exists to catch, and it caught the
-- equivalent mistake in 69.
--
-- IT IS ALL ONE TRANSACTION, WHICH IS WHY A REFUSAL COSTS NOTHING. The file
-- opens with BEGIN and the refusal below is a RAISE, so the whole thing unwinds:
-- a rollback that stops on populated attributions leaves the constraint, the
-- trigger, the columns and the ledger row exactly as they were, still enforcing.
-- Verified on a disposable cluster — after a refused run the constraint and
-- trigger are both still present and the ledger still reads self-recorded. An
-- earlier draft of this file said the opposite in its error message, which would
-- have told an operator the separation had been dropped when it had not.
--
-- Order within the transaction is still constraint, trigger, function, column —
-- the dependency order, so nothing is dropped out from under something that
-- refers to it.
--
-- THE LEDGER ROW IS AMENDED, NOT DELETED. Migration 67 refuses DELETE on
-- public.schema_migrations by trigger — deliberately, because a record of what
-- was applied is not improved by being erasable. A rolled-back migration was
-- still applied once, so the row stays and its evidence says what happened.
-- ============================================================================

BEGIN;

-- ── 1. The separation constraint ────────────────────────────────────────────
ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS document_uploader_is_not_reviewer;

-- ── 2. The stamp ────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS farmer_documents_set_uploaded_by ON public.farmer_documents;
DROP FUNCTION IF EXISTS public.set_document_uploaded_by();

-- ── 3. The columns, if they hold nothing ────────────────────────────────────
DO $attributions$
DECLARE
  opt_in    text := coalesce(current_setting('ddp.rollback_72_destroy_attributions', true), '');
  stamped   bigint := 0;
  on_deaths bigint := 0;
BEGIN
  IF to_regclass('public.farmer_documents') IS NULL THEN
    RAISE NOTICE '72 rollback: farmer_documents is not present; nothing to keep or destroy.';
    RETURN;
  END IF;

  -- Count only if the column is actually there, so a rollback run twice is not
  -- an error.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'farmer_documents'
       AND column_name = 'uploaded_by'
  ) THEN
    EXECUTE 'SELECT count(uploaded_by) FROM public.farmer_documents' INTO stamped;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'farmer_document_deletions'
       AND column_name = 'uploaded_by'
  ) THEN
    EXECUTE 'SELECT count(uploaded_by) FROM public.farmer_document_deletions' INTO on_deaths;
  END IF;

  IF stamped = 0 AND on_deaths = 0 THEN
    ALTER TABLE public.farmer_documents          DROP COLUMN IF EXISTS uploaded_by;
    ALTER TABLE public.farmer_document_deletions DROP COLUMN IF EXISTS uploaded_by;
    RAISE NOTICE
      '72 rollback: no uploader was ever stamped; both columns dropped and the schema is back to its pre-apply shape.';

  ELSIF opt_in = 'yes I am destroying the uploader attributions' THEN
    ALTER TABLE public.farmer_documents          DROP COLUMN IF EXISTS uploaded_by;
    ALTER TABLE public.farmer_document_deletions DROP COLUMN IF EXISTS uploaded_by;
    RAISE WARNING
      '72 rollback: DESTROYED % uploader attribution(s) on farmer_documents and % on farmer_document_deletions, on explicit instruction.',
      stamped, on_deaths;

  ELSE
    RAISE EXCEPTION
      E'72 rollback refused: % document(s) and % deletion record(s) carry a real uploader, and nothing else in the database records who uploaded them.\n'
      'NOTHING HAS CHANGED — this file is one transaction, so the constraint, the trigger and the columns are all still in place and the separation is still enforced.\n'
      'To roll back anyway and discard those attributions, re-run with:\n'
      '    SET ddp.rollback_72_destroy_attributions = ''yes I am destroying the uploader attributions'';',
      stamped, on_deaths
      USING ERRCODE = 'check_violation';
  END IF;
END
$attributions$;

-- ── 4. The ledger says what happened ────────────────────────────────────────
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '72 rollback: no ledger present; nothing to amend.';
    RETURN;
  END IF;

  -- Amended, never deleted — 67's trigger refuses a DELETE here, and rightly:
  -- this migration was applied, and that remains true after it is undone.
  UPDATE public.schema_migrations
     SET evidence = 'rolled back ' || to_char(now(), 'YYYY-MM-DD') || '; was: ' || evidence
   WHERE number = 72
     AND evidence NOT LIKE 'rolled back%';
END
$ledger$;

COMMIT;
