-- =============================================================================
-- 59_FARMER_POLICY_NULL_SAFE_ROLLBACK.sql
--
-- Reverses 59_FARMER_POLICY_NULL_SAFE_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This restores three predicates that refuse rows nobody meant to refuse. After
-- it runs, a farmer creating a batch without naming a `status` is rejected with
-- "new row violates row-level security policy", and a farmer editing a batch
-- whose `stock_status` is NULL gets 0 rows changed and NO error at all.
--
-- Nothing about the resulting state looks wrong. The policies exist, are named
-- correctly, and enforce something — just something stricter than intended, and
-- the strictness shows up as an app that silently fails to save.
--
-- Restored verbatim as measured on staging 2026-08-05, so that a rollback puts
-- back exactly what was there rather than someone's memory of it.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches
  FOR INSERT
  WITH CHECK (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (client_visible = false)
    AND (status <> 'Approved'::text)
    AND ((stock_status IS NULL)
         OR (stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text])))
  );

DROP POLICY IF EXISTS "inventory_batches: farmer update own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer update own"
  ON public.inventory_batches
  FOR UPDATE
  USING (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text]))
  )
  WITH CHECK (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (client_visible = false)
    AND (status <> 'Approved'::text)
    AND ((stock_status IS NULL)
         OR (stock_status <> ALL (ARRAY['approved_internal'::text, 'client_visible'::text,
                                        'reserved'::text, 'sold'::text])))
  );

-- Postcondition. A rollback that recreated the policies under the right names but
-- left the NULL branches in place would look identical to a correct one from the
-- catalogue's point of view — the names match, the commands match, the policies
-- are there. Assert the pre-59 predicate is genuinely back.
DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_ins      text;
  v_upd_u    text;
BEGIN
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  SELECT qual INTO v_upd_u FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer update own';

  IF v_ins IS NULL THEN
    v_problems := array_append(v_problems, 'INSERT policy was not restored');
  ELSIF v_ins LIKE '%status IS NULL OR%' THEN
    v_problems := array_append(v_problems, 'INSERT policy still carries migration 59''s NULL branch');
  END IF;

  IF v_upd_u IS NULL THEN
    v_problems := array_append(v_problems, 'UPDATE policy was not restored');
  ELSIF v_upd_u LIKE '%stock_status IS NULL%' THEN
    v_problems := array_append(v_problems, 'UPDATE policy USING still carries migration 59''s NULL branch');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 59 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'ROLLBACK 59: both farmer policies restored to their pre-59, NULL-unsafe form.';
END
$postcondition$;

COMMIT;
