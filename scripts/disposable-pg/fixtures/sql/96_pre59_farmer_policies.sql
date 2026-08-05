-- Pre-migration world for fixture 59.
--
-- The substrate does not carry the farmer INSERT/UPDATE policies: they are
-- created by FARMER_MVP_MIGRATION.sql and INVENTORY_BATCHES_INSERT_GUARDRAIL_FIX.sql,
-- two of the UNNUMBERED .sql files in the repo root. Migration 59 rewrites those
-- policies, so without this stage the fixture would test a rewrite of something
-- that was never there.
--
-- The substrate DOES define both policies, but far more permissively than
-- production: its INSERT check is only (ownership AND client_visible = false) --
-- no self-approval guard, no lifecycle guard -- and its UPDATE check is only
-- (client_visible = false). That divergence is why fixture 58's VERIFY section E
-- passes on a disposable cluster and FAILS against staging: on the substrate the
-- refusing predicate simply is not there. So these are DROPped and replaced
-- rather than created.
--
-- Reproduced VERBATIM as measured on staging (a 0-diff production copy) on
-- 2026-08-05, NULL-unsafe exactly as production has it, so that fixture 59
-- exercises the real before-state rather than a tidied-up one.
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
