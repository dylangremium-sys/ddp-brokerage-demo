-- =============================================================================
-- 57_BROKER_NOTES_OUT_OF_REACH_HARDENING.sql
--
-- Moves DDP's private note about a batch out of a column the supplier can read.
--
-- WHAT IS WRONG TODAY
-- `inventory_batches.owner_notes` is DDP's internal note. The admin screen labels
-- it "Internal:" (src/pages/admin/DDPInventoryReview.tsx). A trigger,
-- `trg_protect_owner_notes`, exists specifically to stop a farmer WRITING it.
--
-- Nothing stops a farmer READING it. Measured on staging, 2026-08-05: a farmer
-- selecting their own batch gets the note back in full. `batchRowToInventoryItem`
-- maps it into the client model and the fetch is `select('*')`, so it travels to
-- the browser on every load — and even if no farmer screen rendered it, a farmer
-- holding the anon key can ask for the column directly.
--
-- A field the platform goes to the trouble of protecting from a farmer's writes,
-- and labels Internal, being fully legible to that same farmer is the asymmetry
-- this migration closes.
--
-- WHY IT CANNOT BE FIXED WITH COLUMN PRIVILEGES
-- The obvious fix — `REVOKE SELECT (owner_notes) ... FROM authenticated` — cannot
-- work here, and the reason is worth stating because it will come up again.
--
-- PostgreSQL privileges are granted to ROLES. In this system a DDP admin and a
-- farmer are the SAME PostgreSQL role: `authenticated`. What distinguishes them
-- is `is_ddp_admin()`, evaluated inside a row-level policy. So any control that
-- operates at the privilege layer hits admins and farmers identically, and the
-- only mechanism in this database that can tell the two apart is RLS.
--
-- RLS is row-level. Therefore a secret that must be visible to one kind of user
-- and not another has to live in its OWN ROW, in a table with its own policy.
-- That is the whole design here — not a preference.
--
-- WHAT ABOUT THE TRIGGER AND ITS FUNCTION
-- `trg_protect_owner_notes` is DROPPED, because it fires `BEFORE UPDATE` and its
-- body assigns `NEW.owner_notes := OLD.owner_notes`. With the column gone that
-- raises at runtime on every single batch update — a migration that removes a
-- column and leaves this trigger in place breaks writes to the busiest table in
-- the platform.
--
-- `fn_protect_owner_notes()` itself is deliberately LEFT IN PLACE, orphaned. Its
-- body is NOT the same in both worlds: production carries the real pin, and the
-- test substrate carries a stub that returns NEW unchanged. A rollback that
-- re-created the function would have to pick one body and would be wrong in the
-- other world. Migration 12 owns this function's privileges, and this migration
-- does not touch them. Recorded as a deliberate leftover, not an oversight: it
-- is dead code until something re-attaches it.
--
-- DATA
-- Existing notes are copied across before the column is dropped. Blank and
-- whitespace-only notes are NOT copied — an empty note is an absent note, and
-- the new table's CHECK says so.
--
--   • Rollback: 57_BROKER_NOTES_OUT_OF_REACH_ROLLBACK.sql
--   • Verify:   57_BROKER_NOTES_OUT_OF_REACH_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL THEN
    RAISE EXCEPTION 'Migration 57 requires public.inventory_batches, which does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                   AND column_name = 'owner_notes') THEN
    RAISE EXCEPTION
      'Migration 57 requires inventory_batches.owner_notes. It is absent, so there is nothing to '
      'move and this migration would silently do nothing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin') THEN
    RAISE EXCEPTION
      'Migration 57 requires public.is_ddp_admin(): it is the ONLY thing that distinguishes an '
      'admin from a farmer, and the new table''s policy is built on it.';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. The note gets its own row
--
-- One row per batch, so `batch_id` is the primary key rather than a surrogate:
-- two internal notes on one batch is not a state this platform has, and a
-- surrogate key would permit it silently.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.batch_internal_notes (
  batch_id   uuid PRIMARY KEY REFERENCES public.inventory_batches(id) ON DELETE CASCADE,
  -- A blank note is an absent note. Without this a farmer-visible "there is a
  -- note on your batch" signal could be created by writing whitespace.
  note       text NOT NULL CHECK (length(btrim(note)) > 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.batch_internal_notes IS
  'DDP''s private note about a batch. Readable and writable by ddp_admin ONLY, '
  'enforced by RLS because a DDP admin and a farmer are the same PostgreSQL role '
  '(authenticated) and no privilege-level control can separate them. Moved out of '
  'inventory_batches.owner_notes by migration 57, where every farmer could read it.';

-- -----------------------------------------------------------------------------
-- 2. Carry the existing notes across
-- -----------------------------------------------------------------------------
INSERT INTO public.batch_internal_notes (batch_id, note)
SELECT id, btrim(owner_notes)
  FROM public.inventory_batches
 WHERE owner_notes IS NOT NULL AND btrim(owner_notes) <> ''
ON CONFLICT (batch_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. The lock
--
-- ONE policy, FOR ALL, admin only. Not four policies per verb: every extra
-- policy is another chance to write a predicate that is permissive in one verb,
-- and there is no case here where read and write differ.
-- -----------------------------------------------------------------------------
ALTER TABLE public.batch_internal_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS batch_internal_notes_admin_only ON public.batch_internal_notes;
CREATE POLICY batch_internal_notes_admin_only
  ON public.batch_internal_notes FOR ALL
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- `authenticated` holds the table privileges; the policy above is what narrows
-- them to admins. anon is revoked explicitly rather than merely not granted,
-- because a default privilege could have granted it before this ran.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.batch_internal_notes TO authenticated;
REVOKE ALL ON public.batch_internal_notes FROM anon;

-- -----------------------------------------------------------------------------
-- 4. Remove the readable copy
--
-- The trigger goes FIRST. It fires BEFORE UPDATE and its body assigns
-- NEW.owner_notes, so dropping the column while it is still attached would raise
-- on every subsequent batch update.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_protect_owner_notes ON public.inventory_batches;

ALTER TABLE public.inventory_batches DROP COLUMN owner_notes;

COMMIT;
