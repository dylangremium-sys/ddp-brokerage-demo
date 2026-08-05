-- =============================================================================
-- 60_BATCH_MUST_BELONG_TO_YOUR_FARM_HARDENING.sql
--
-- Stops a farmer attaching stock to a farm that is not theirs.
--
-- Depends on migration 59 (it rewrites the policies 59 leaves in place).
--
-- WHAT IS WRONG TODAY
-- Both farmer policies decide ownership with:
--
--   (created_by = auth.uid()) OR has_farm_membership(farm_id)
--
-- The first branch tests a column ON THE ROW BEING WRITTEN, and the writer
-- chooses that column's value. Naming yourself as `created_by` satisfies it
-- whatever `farm_id` says, so the farm test never has to be reached:
--
--   INSERT INTO inventory_batches (farm_id, created_by, ...)
--   VALUES (<a rival's farm>, <me>, ...);        -- admitted
--
-- Measured on staging (a 0-diff production copy) 2026-08-05 by
-- 59_..._VERIFY.sql section F, which was written to pin the gap rather than
-- describe it. The rival's real members then see stock on their farm that they
-- did not put there — and on a brokerage, stock attribution is the product.
--
-- A self-referential predicate is not a permission check. It asks the caller to
-- vouch for themselves.
--
-- WHAT REPLACES IT, AND WHY THIS SHAPE
-- A farmer may place a batch on a farm they are a MEMBER of, or on a farm they
-- CREATED. Both branches are necessary:
--
--   * membership alone would lock out the creator of a brand-new farm. NOTHING
--     in this system creates a farm_memberships row — not a trigger, not a
--     SECURITY DEFINER function, not the application (`grep -rn
--     "from('farm_memberships')" src api` finds one call site and it is a
--     SELECT). Requiring membership would refuse a farmer's first batch on the
--     farm they had just registered.
--   * creator alone would lock out every co-worker added to an existing farm.
--
-- This is not a new idea invented here. It is the definition the application
-- ALREADY uses to decide which farms a farmer can see — `getFarmerScope` in
-- src/lib/db.ts reads `farm_memberships` and `farms.created_by` and unions them.
-- The policy was simply testing something else. Now the database and the
-- application agree on what "your farm" means.
--
-- WHY A SECURITY DEFINER FUNCTION AND NOT AN INLINE EXISTS
-- An inline `EXISTS (SELECT 1 FROM public.farms ...)` inside a policy runs with
-- the CALLER's privileges, so RLS on `farms` applies to it. A farmer who cannot
-- SELECT a farm row would get EXISTS = false and be refused a batch on their own
-- farm — the lockout this migration exists to avoid, reintroduced through the
-- back door. `has_farm_membership()` is SECURITY DEFINER for exactly this
-- reason; the new function follows it.
--
-- WHAT IS NOT CHANGED
-- The USING clauses, which decide WHICH EXISTING ROWS a farmer may touch, keep
-- their `created_by = auth.uid()` branch. A farmer who legitimately holds a row
-- does not lose it. The hole was never about reading or editing rows you already
-- have — it was about which farm a row may be attached TO, and that is decided
-- by WITH CHECK, on both INSERT and UPDATE. Narrowing USING as well would revoke
-- access to existing rows and close nothing extra.
--
--   • Rollback: 60_BATCH_MUST_BELONG_TO_YOUR_FARM_ROLLBACK.sql
--   • Verify:   60_BATCH_MUST_BELONG_TO_YOUR_FARM_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.farm_memberships') IS NULL OR to_regclass('public.farms') IS NULL THEN
    RAISE EXCEPTION 'Migration 60 requires public.farms and public.farm_memberships.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='inventory_batches'
                 AND policyname='inventory_batches: farmer insert own'
                 AND with_check LIKE '%status IS NULL%') THEN
    RAISE EXCEPTION
      'Migration 60 rewrites the policies migration 59 produced, and the INSERT policy does not '
      'carry 59''s NULL branch. Apply migration 59 first.';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. What "your farm" means, in one place
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_farm_claim(p_farm_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.farm_memberships
                  WHERE farm_id = p_farm_id AND user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.farms
                  WHERE id = p_farm_id AND created_by = auth.uid());
$$;

COMMENT ON FUNCTION public.has_farm_claim(uuid) IS
  'True when the caller is a member of the farm OR created it. The union the '
  'application already uses (getFarmerScope). Unlike a test on the row being '
  'written, the caller cannot satisfy this by choosing a column value.';

-- Match the privilege shape of the sibling predicates. anon must not be able to
-- probe farm ownership, and PUBLIC EXECUTE on a SECURITY DEFINER function is the
-- finding several migrations in this repository exist to prevent.
REVOKE EXECUTE ON FUNCTION public.has_farm_claim(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_farm_claim(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. The two WITH CHECK clauses
-- -----------------------------------------------------------------------------
DROP POLICY "inventory_batches: farmer insert own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches
  FOR INSERT
  WITH CHECK (
    has_farm_claim(farm_id)
    AND (client_visible = false)
    AND (status IS NULL OR status <> 'Approved')
    AND (stock_status IS NULL
         OR stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text]))
  );

DROP POLICY "inventory_batches: farmer update own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer update own"
  ON public.inventory_batches
  FOR UPDATE
  -- USING is deliberately unchanged from migration 59. See the header.
  USING (
    ((created_by = auth.uid()) OR has_farm_membership(farm_id))
    AND (stock_status IS NULL
         OR stock_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'needs_changes'::text]))
  )
  WITH CHECK (
    has_farm_claim(farm_id)
    AND (client_visible = false)
    AND (status IS NULL OR status <> 'Approved')
    AND (stock_status IS NULL
         OR stock_status <> ALL (ARRAY['approved_internal'::text, 'client_visible'::text,
                                       'reserved'::text, 'sold'::text]))
  );

DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_ins text; v_upd_c text;
BEGIN
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  SELECT with_check INTO v_upd_c FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer update own';

  IF v_ins   NOT LIKE '%has_farm_claim%' THEN v_problems := array_append(v_problems, 'INSERT WITH CHECK does not use has_farm_claim'); END IF;
  IF v_upd_c NOT LIKE '%has_farm_claim%' THEN v_problems := array_append(v_problems, 'UPDATE WITH CHECK does not use has_farm_claim'); END IF;
  -- The self-referential branch must be GONE from WITH CHECK, or the hole is
  -- still open through the disjunction that replaced it.
  IF v_ins   LIKE '%created_by = auth.uid()%' THEN v_problems := array_append(v_problems, 'INSERT WITH CHECK still trusts created_by'); END IF;
  IF v_upd_c LIKE '%created_by = auth.uid()%' THEN v_problems := array_append(v_problems, 'UPDATE WITH CHECK still trusts created_by'); END IF;
  -- 59's work must survive.
  IF v_ins   NOT LIKE '%status IS NULL%' THEN v_problems := array_append(v_problems, 'INSERT lost migration 59''s NULL branch'); END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='has_farm_claim' AND NOT p.prosecdef) THEN
    v_problems := array_append(v_problems, 'has_farm_claim is not SECURITY DEFINER');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'MIGRATION 60 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'MIGRATION 60: a batch may only be attached to a farm the caller is a member of or created.';
END
$postcondition$;

COMMIT;
