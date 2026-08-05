-- =============================================================================
-- 59_FARMER_POLICY_NULL_SAFE_HARDENING.sql
--
-- Makes the farmer INSERT and UPDATE policies on inventory_batches NULL-safe.
--
-- WHAT IS WRONG TODAY
-- Three predicates refuse a row they were never meant to refuse, because a
-- comparison against NULL yields NULL and RLS treats anything that is not TRUE
-- as a refusal:
--
--   farmer insert own  WITH CHECK  ... AND (status <> 'Approved')
--   farmer update own  USING       ... AND (stock_status = ANY (ARRAY[...]))
--   farmer update own  WITH CHECK  ... AND (status <> 'Approved')
--
-- `status` is nullable and has NO DEFAULT. So a farmer creating a batch without
-- naming a status is refused outright:
--
--   new row violates row-level security policy for table "inventory_batches"
--
-- MEASURED ON STAGING (a 0-diff production copy), 2026-08-05:
--   insert relying on defaults                 -> REFUSED
--   insert with status set, stock_status NULL  -> OK
--   insert with stock_status set, status NULL  -> REFUSED
--   update of an own batch whose stock_status is NULL -> 0 rows
--
-- The last one is the quiet one: the batch is VISIBLE to its owner and simply
-- cannot be edited. No error reaches the user, the UPDATE just affects nothing.
--
-- WHY THIS IS AN OVERSIGHT AND NOT A RULE
-- INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql states the intent in its own header:
--
--   • status NOT IN ('Approved')   (farmer cannot self-approve)
--
-- and asserts that "the stricter WITH CHECK below does not break the app's
-- normal farmer submission path". A batch with no status is not an approved
-- batch, so refusing it serves no stated purpose — and the claim about the
-- submission path is false wherever `status` is left unset.
--
-- The strongest evidence that this is an oversight is the file's own
-- inconsistency: the SAME predicate already spells the NULL case out for the
-- other column, twice —
--
--   (stock_status IS NULL OR stock_status = ANY (ARRAY[...]))
--
-- The idiom was known and applied to `stock_status`; it was simply never applied
-- to `status`, and was omitted from the UPDATE policy's USING clause.
--
-- WHAT THIS CHANGES, PRECISELY
-- Each predicate gains an explicit NULL branch. Nothing else moves: the same
-- ownership test, the same client_visible test, the same lifecycle lists, the
-- same policy names, commands and roles. What was refused for a REASON is still
-- refused — a farmer still cannot self-approve, still cannot publish to buyers,
-- and still cannot push a batch into an admin-only lifecycle state.
--
-- WHY NOT DEFAULT `status` INSTEAD
-- Giving `status` a default would also close the INSERT case and would NOT close
-- the UPDATE case, which turns on `stock_status`. It would also invent a value
-- for every existing row's future writes on a column whose vocabulary is set by
-- the application, not by this migration. Fixing the predicate fixes the actual
-- defect; defaulting the column would paper over one symptom of it.
--
--   • Rollback: 59_FARMER_POLICY_NULL_SAFE_ROLLBACK.sql
--   • Verify:   59_FARMER_POLICY_NULL_SAFE_VERIFY.sql
-- =============================================================================

BEGIN;

-- Precondition. These policies are RECREATED below, not amended — PostgreSQL has
-- no ALTER POLICY that edits one conjunct. If what is deployed is not what this
-- migration expects, recreating would silently install a DIFFERENT rule than the
-- one reviewed, so refuse and say so.
DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL THEN
    RAISE EXCEPTION 'Migration 59 requires public.inventory_batches.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='inventory_batches'
                 AND policyname='inventory_batches: farmer insert own') THEN
    v_missing := array_append(v_missing, 'policy "inventory_batches: farmer insert own"');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='inventory_batches'
                 AND policyname='inventory_batches: farmer update own') THEN
    v_missing := array_append(v_missing, 'policy "inventory_batches: farmer update own"');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Migration 59 rewrites two existing policies and cannot create them from nothing. Missing: %. '
      'Apply INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql / FARMER_MVP_MIGRATION.sql first.',
      array_to_string(v_missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. INSERT — a batch with no status is not an approved batch
-- -----------------------------------------------------------------------------
DROP POLICY "inventory_batches: farmer insert own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches
  FOR INSERT
  WITH CHECK (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (client_visible = false)
    AND (status IS NULL OR status <> 'Approved')
    AND (stock_status IS NULL
         OR stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text]))
  );

-- -----------------------------------------------------------------------------
-- 2. UPDATE — a batch that never entered the lifecycle is still the owner's
--
-- USING decides which EXISTING rows may be updated. A NULL stock_status is not
-- one of the admin-only states this clause exists to protect; it is a batch that
-- has not been put into the lifecycle at all. Refusing those made a row its owner
-- can see but cannot edit, and it failed silently — UPDATE reported 0 rows.
-- -----------------------------------------------------------------------------
DROP POLICY "inventory_batches: farmer update own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer update own"
  ON public.inventory_batches
  FOR UPDATE
  USING (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (stock_status IS NULL
         OR stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text]))
  )
  WITH CHECK (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (client_visible = false)
    AND (status IS NULL OR status <> 'Approved')
    AND (stock_status IS NULL
         OR stock_status <> ALL (ARRAY['approved_internal'::text, 'client_visible'::text,
                                       'reserved'::text, 'sold'::text]))
  );

-- Postcondition. A CREATE POLICY that ran cannot be assumed to have installed the
-- predicate intended — a typo in a conjunct produces a policy that exists, is
-- named correctly, and enforces something else. Assert the NULL branches are
-- actually present in what the catalogue now holds.
DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_ins      text;
  v_upd_u    text;
  v_upd_c    text;
BEGIN
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  SELECT qual, with_check INTO v_upd_u, v_upd_c FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer update own';

  IF v_ins IS NULL OR v_ins NOT LIKE '%status IS NULL%' THEN
    v_problems := array_append(v_problems, 'INSERT policy has no NULL branch for status');
  END IF;
  IF v_upd_u IS NULL OR v_upd_u NOT LIKE '%stock_status IS NULL%' THEN
    v_problems := array_append(v_problems, 'UPDATE policy USING has no NULL branch for stock_status');
  END IF;
  IF v_upd_c IS NULL OR v_upd_c NOT LIKE '%status IS NULL%' THEN
    v_problems := array_append(v_problems, 'UPDATE policy WITH CHECK has no NULL branch for status');
  END IF;
  -- The guards must SURVIVE, not merely the NULL branches be added.
  IF v_ins NOT LIKE '%client_visible = false%' THEN
    v_problems := array_append(v_problems, 'INSERT policy lost the client_visible guard');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'MIGRATION 59 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'MIGRATION 59: both farmer policies are NULL-safe; every guardrail retained.';
END
$postcondition$;

COMMIT;
