-- =============================================================================
-- 57_BROKER_NOTES_OUT_OF_REACH_ROLLBACK.sql
--
-- Reverses 57_BROKER_NOTES_OUT_OF_REACH_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This puts DDP's private note back into a column every farmer can read. That is
-- the state migration 57 exists to end, and — like migrations 43, 54 and 55 —
-- nothing about the result looks wrong afterwards. The note is still there, the
-- admin screen still shows it, and the only difference is that the supplier it
-- concerns can now read it too.
--
-- Notes are copied back before the table is dropped, so no note is lost. What IS
-- lost is `updated_by` and `updated_at` — the old column never had them, so there
-- is nowhere to put them. If you need that history, export it first:
--
--   SELECT batch_id, note, updated_by, updated_at FROM public.batch_internal_notes;
-- =============================================================================

BEGIN;

-- The column comes back before the data does, and the trigger after both, so at
-- no point is there a BEFORE UPDATE trigger referring to a column that is absent.
ALTER TABLE public.inventory_batches ADD COLUMN IF NOT EXISTS owner_notes text;

UPDATE public.inventory_batches b
   SET owner_notes = n.note
  FROM public.batch_internal_notes n
 WHERE n.batch_id = b.id;

DROP POLICY IF EXISTS batch_internal_notes_admin_only ON public.batch_internal_notes;
DROP TABLE IF EXISTS public.batch_internal_notes;

-- Restored unconditionally because the substrate carries this trigger too — it
-- was added there precisely so this rollback would be symmetric in both worlds.
-- Before that, the test substrate had the FUNCTION but not the TRIGGER, so
-- migration 57's DROP was a no-op under test and this line would have ADDED a
-- trigger the pre-apply world never had: a correct rollback reported asymmetric.
DROP TRIGGER IF EXISTS trg_protect_owner_notes ON public.inventory_batches;
CREATE TRIGGER trg_protect_owner_notes
  BEFORE UPDATE ON public.inventory_batches
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_owner_notes();

DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.batch_internal_notes') IS NOT NULL THEN
    v_problems := array_append(v_problems, 'public.batch_internal_notes still exists');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches'
                   AND column_name='owner_notes') THEN
    v_problems := array_append(v_problems, 'inventory_batches.owner_notes was not restored');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE c.relname = 'inventory_batches'
                   AND t.tgname = 'trg_protect_owner_notes' AND NOT t.tgisinternal) THEN
    v_problems := array_append(v_problems,
      'trg_protect_owner_notes was not restored — farmers could then WRITE owner_notes, which is '
      'a wider hole than the one migration 57 closed');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 57 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'ROLLBACK 57: notes copied back to inventory_batches.owner_notes, batch_internal_notes dropped, trg_protect_owner_notes restored.';
END
$postcondition$;

COMMIT;
