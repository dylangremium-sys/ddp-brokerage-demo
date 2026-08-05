-- =============================================================================
-- 60_BATCH_MUST_BELONG_TO_YOUR_FARM_ROLLBACK.sql
--
-- Reverses 60_BATCH_MUST_BELONG_TO_YOUR_FARM_HARDENING.sql, returning both
-- policies to their migration-59 form.
--
-- READ THIS BEFORE RUNNING IT.
--
-- After this runs, a farmer can once again attach a batch to a farm that is not
-- theirs, by naming themselves as `created_by`. Nothing errors, nothing is
-- logged, and the rival farm's members simply start seeing stock they did not
-- create. The database will look entirely healthy.
--
-- Drops has_farm_claim() only if no policy still references it, so a partial
-- rollback cannot leave a policy pointing at a function that no longer exists.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

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

DROP POLICY IF EXISTS "inventory_batches: farmer update own" ON public.inventory_batches;

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

DO $drop_fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND (coalesce(qual,'') LIKE '%has_farm_claim%'
                                        OR coalesce(with_check,'') LIKE '%has_farm_claim%')) THEN
    RAISE NOTICE 'ROLLBACK 60: has_farm_claim() KEPT — a policy still references it.';
  ELSE
    DROP FUNCTION IF EXISTS public.has_farm_claim(uuid);
  END IF;
END
$drop_fn$;

DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_ins text;
BEGIN
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  IF v_ins IS NULL THEN
    v_problems := array_append(v_problems, 'INSERT policy was not restored');
  ELSE
    IF v_ins LIKE '%has_farm_claim%' THEN
      v_problems := array_append(v_problems, 'INSERT policy still references has_farm_claim');
    END IF;
    IF v_ins NOT LIKE '%created_by = auth.uid()%' THEN
      v_problems := array_append(v_problems, 'INSERT policy did not get its pre-60 branch back');
    END IF;
    IF v_ins NOT LIKE '%status IS NULL%' THEN
      v_problems := array_append(v_problems, 'rollback destroyed migration 59''s NULL branch');
    END IF;
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 60 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'ROLLBACK 60: both policies back to their migration-59 form; 59''s NULL branches intact.';
END
$postcondition$;

COMMIT;
