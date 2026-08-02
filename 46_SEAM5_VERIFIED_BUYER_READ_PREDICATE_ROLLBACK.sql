-- =============================================================================
-- 46_SEAM5_VERIFIED_BUYER_READ_PREDICATE_ROLLBACK.sql
--
-- Restores migration 44's two buyer SELECT policies to the membership-only
-- predicate and drops the verified predicate.
--
-- ROLLING THIS BACK RE-OPENS THE SEAM 5 GAP: a suspended buyer regains read
-- access to their reservations. That is what "roll back" means here; it exists
-- so a failed apply can be undone, not because the previous state was correct.
--
-- The policies are restored VERBATIM from 44_RESERVATION_LEDGER_HARDENING.sql
-- §7, so that a database rolled back to this point is byte-identical in
-- behaviour to one that never had 46 applied.
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.reservations') IS NULL
     OR to_regclass('public.reservation_releases') IS NULL THEN
    RAISE EXCEPTION
      'Rollback 46 requires migration 44''s tables to exist. Roll back 44 instead.';
  END IF;
END
$precondition$;

DROP POLICY IF EXISTS reservations_select ON public.reservations;
CREATE POLICY reservations_select ON public.reservations
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_organisation_membership(buyer_organisation_id));

DROP POLICY IF EXISTS reservation_releases_select ON public.reservation_releases;
CREATE POLICY reservation_releases_select ON public.reservation_releases
  FOR SELECT TO authenticated
  USING (
    public.is_ddp_admin()
    OR EXISTS (SELECT 1 FROM public.reservations r
               WHERE r.id = reservation_id
                 AND public.has_organisation_membership(r.buyer_organisation_id))
  );

-- Dropped last: while a policy still referenced it, PostgreSQL would refuse.
DROP FUNCTION IF EXISTS public.has_verified_organisation_membership(uuid);

COMMIT;
