-- Pre-migration world for fixture 62.
--
-- The substrate creates the status_history TABLE and nothing else — no
-- policies, no grants. Production's policies come from two places: the
-- permissive pair from the unnumbered farmer/admin migrations, and the
-- RESTRICTIVE overlay from migration 22.
--
-- Migration 22 itself is not applied here on purpose. It rewrites storage
-- policies as well, pulling storage.objects into a fixture that has nothing to
-- do with storage — the harness correctly refuses that as an undeclared symbol,
-- and declaring it would widen the fixture's substrate to buy nothing.
--
-- So this stage reproduces the three policies and the grant EXACTLY as measured
-- on production on 2026-08-07:
--
--   status_history: admin all                     PERMISSIVE  ALL
--   status_history: farmer select own             PERMISSIVE  SELECT
--   status_history: operational farmer or admin   RESTRICTIVE ALL
--   authenticated = arwd
--
-- The RESTRICTIVE one is the whole reason fixture 62 exists in this shape. If
-- it were reproduced as PERMISSIVE here, migration 62's section G would pass
-- against a world that does not exist, and the fixture would be asserting
-- against a tidied-up straw man rather than the real before-state.

ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "status_history: admin all" ON public.status_history;
CREATE POLICY "status_history: admin all"
  ON public.status_history
  FOR ALL
  USING (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;
CREATE POLICY "status_history: farmer select own"
  ON public.status_history
  FOR SELECT
  USING (
    ((entity_type = 'farm') AND public.has_farm_membership(entity_id))
    OR ((entity_type = 'inventory_batch') AND (EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = status_history.entity_id
        AND ((ib.created_by = auth.uid()) OR public.has_farm_membership(ib.farm_id))
    )))
  );

-- RESTRICTIVE, exactly as migration 22 creates it. Narrows access; grants none.
DROP POLICY IF EXISTS "status_history: operational farmer or admin" ON public.status_history;
CREATE POLICY "status_history: operational farmer or admin"
  ON public.status_history
  AS RESTRICTIVE FOR ALL
  USING (public.has_operational_farmer_access() OR public.is_ddp_admin())
  WITH CHECK (public.has_operational_farmer_access() OR public.is_ddp_admin());

-- The pre-62 grant. Broader than the RLS can actually use — which is the point
-- migration 62's header is careful about, and what its section E revokes.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.status_history TO authenticated;
