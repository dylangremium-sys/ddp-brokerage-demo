-- =============================================================================
-- 46_SEAM5_VERIFIED_BUYER_READ_PREDICATE_HARDENING.sql
--
-- Seam 5's remaining half: suspension takes effect on READ, immediately, with
-- no row deleted and no grant revoked.
--
-- Depends on migration 39 (organisations, organisation_memberships,
-- has_organisation_membership) and migration 44 (reservations,
-- reservation_releases).
--
--   • Rollback: 46_SEAM5_VERIFIED_BUYER_READ_PREDICATE_ROLLBACK.sql
--   • Verify:   46_SEAM5_VERIFIED_BUYER_READ_PREDICATE_VERIFY.sql
--
-- WHAT WAS WRONG
-- docs/OPTION_B_SEAM_CONTRACT.md Seam 5 requires that "approval must be a gate,
-- not a flag, and suspension must remove access immediately without touching a
-- grant row", and records what remains outstanding: "make every buyer-side read
-- predicate return true only for `verified`".
--
-- It was not done. `has_organisation_membership()` tests membership and nothing
-- else, so migration 44's buyer-side SELECT policies admitted a member of an
-- organisation in ANY verification state. Suspending a buyer changed a column
-- and changed no access. The write path was already correct — migration 44's
-- availability trigger refuses a reservation unless the buyer is 'verified' — so
-- a suspended buyer could not take NEW stock, but kept reading the reservations
-- they already held. Suspension was a flag, exactly as the seam says it must not
-- be.
--
-- WHAT THIS DOES
-- Adds `has_verified_organisation_membership()` — membership AND
-- `verification_state = 'verified'` — and re-points migration 44's two buyer
-- SELECT policies at it. Suspension now removes read access on the next
-- statement, because the predicate is evaluated per query and reads the
-- organisation row live.
--
-- This is also the primitive the buyer catalogue will need (MC-02, not built).
-- A future catalogue policy uses THIS function, not the membership one.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT CHANGE ─────────────────────────────────
--
-- Each of these uses has_organisation_membership() and each is left alone. They
-- are listed because "why didn't it change that one too?" is the first question
-- a reviewer will have, and because two of them would be actively harmful.
--
-- 1. `organisations_select` (migration 39) — a member reading their OWN
--    organisation row. Gating this on 'verified' would make onboarding
--    impossible: `verification_state` DEFAULTS to 'unverified', so a newly
--    created buyer organisation would be invisible to the very people who have
--    to complete its verification. Identity is not a privilege; trading is.
--
-- 2. Licence and permit reads (migration 40) — organisation-owned COMPLIANCE
--    records, and `org_type` admits farms, laboratories, carriers and brokers,
--    not just buyers. Seam 5 governs buyer-side reads. Gating these would remove
--    a farm's view of its own licences, which is neither asked for nor sensible:
--    an organisation under review needs to see the documents it is being
--    reviewed on.
--
-- 3. `reservations_insert` (migration 44) — already enforced, and better, by
--    `fn_enforce_reservation_availability()`, which raises
--    'buyer % is in verification state "%"; only a verified buyer may hold
--    stock'. Adding an RLS gate here would replace that precise message with a
--    generic "new row violates row-level security policy" and change no
--    outcome. A worse error for identical behaviour is not defence in depth.
--
-- 4. `reservation_releases_insert` (migration 44) — a buyer cancelling their own
--    hold. Cancelling FREES stock; there is no scenario where preventing a
--    suspended buyer from releasing a hold helps anyone. Blocking it would
--    strand held quantity until the 7-day expiry or an admin intervention, which
--    penalises the farm for the buyer's suspension.
--
-- Note the consequence of 1 and 4 together, which is intended: a suspended buyer
-- can still see who they are and can still release stock they hold. What they
-- lose is the ability to see or take stock.
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 39 (public.organisations)');
  END IF;
  IF to_regclass('public.organisation_memberships') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 39 (public.organisation_memberships)');
  END IF;
  IF to_regclass('public.reservations') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 44 (public.reservations)');
  END IF;
  IF to_regclass('public.reservation_releases') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 44 (public.reservation_releases)');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 46 requires: %.', array_to_string(v_missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. The predicate
--
-- SECURITY DEFINER, exactly like has_organisation_membership(), and for the same
-- reason: it reads organisation_memberships and organisations, both of which are
-- themselves under RLS. A predicate that had to satisfy the policies it exists to
-- evaluate would either recurse or silently return false.
--
-- STABLE, not IMMUTABLE: verification_state changes, and a plan that cached this
-- would keep a suspended buyer reading for the life of the plan — which is the
-- whole defect being fixed.
--
-- The state comparison is a literal 'verified' rather than a NOT IN list. A new
-- verification_state added later must be non-trading until somebody decides
-- otherwise; an exclusion list would silently admit it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_verified_organisation_membership(target_organisation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_memberships m
    JOIN public.organisations o ON o.id = m.organisation_id
    WHERE m.organisation_id = target_organisation_id
      AND m.user_id = auth.uid()
      AND o.verification_state = 'verified'
  )
$$;

REVOKE EXECUTE ON FUNCTION public.has_verified_organisation_membership(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_verified_organisation_membership(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.has_verified_organisation_membership(uuid) IS
  'Seam 5: membership AND verification_state = ''verified''. The predicate for '
  'buyer-side READS. Use has_organisation_membership() for identity and for '
  'compliance records an organisation must see while under review.';

-- -----------------------------------------------------------------------------
-- 2. Migration 44's buyer-side SELECT policies, re-pointed
--
-- Recreated in full rather than altered: a policy's USING expression cannot be
-- amended in place, and restating it keeps this file readable next to 44.
-- The admin arm is unchanged — DDP sees both sides regardless of counterparty
-- state, which is what makes suspension administrable at all.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS reservations_select ON public.reservations;
CREATE POLICY reservations_select ON public.reservations
  FOR SELECT TO authenticated
  USING (public.is_ddp_admin() OR public.has_verified_organisation_membership(buyer_organisation_id));

DROP POLICY IF EXISTS reservation_releases_select ON public.reservation_releases;
CREATE POLICY reservation_releases_select ON public.reservation_releases
  FOR SELECT TO authenticated
  USING (
    public.is_ddp_admin()
    OR EXISTS (SELECT 1 FROM public.reservations r
               WHERE r.id = reservation_id
                 AND public.has_verified_organisation_membership(r.buyer_organisation_id))
  );

COMMIT;
