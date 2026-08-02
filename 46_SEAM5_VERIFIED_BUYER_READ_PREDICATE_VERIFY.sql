-- =============================================================================
-- Migration 46 — VERIFY: suspension removes read access, immediately
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure and privilege: the predicate exists and anon cannot call it
--   B — both buyer SELECT policies use the VERIFIED predicate
--   C — BEHAVIOURAL: a verified buyer reads their own reservation and release
--   D — BEHAVIOURAL: suspending the organisation removes both reads on the very
--       next statement, AND THE ROWS STILL EXIST — no delete, no revoke
--   E — BEHAVIOURAL: re-verifying restores access, so this is a live gate and
--       not a one-way door
--   F — the deliberately excluded surfaces still work: a suspended member can
--       still see their own organisation row, so onboarding and appeal are
--       possible
--   G — DDP admin sees the reservation whatever the buyer's state, which is what
--       makes suspension administrable
--
-- Expected on success: seven PASSED notices and no exception.
--
-- Sections C–G impersonate `authenticated` via set_config('role', …) exactly as
-- migration 44's section H does. Structure alone would not catch this defect:
-- the ORIGINAL policies were also structurally valid, they just admitted the
-- wrong people.
--
-- NOTE: the Supabase dashboard SQL editor does not display RAISE NOTICE. Run
-- through psql, or a silent pass is indistinguishable from a silent skip.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE v46 (k text PRIMARY KEY, v uuid) ON COMMIT DROP;

-- -----------------------------------------------------------------------------
-- A. Structure and privilege
-- -----------------------------------------------------------------------------
DO $verify_a$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND p.proname = 'has_verified_organisation_membership') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: public.has_verified_organisation_membership(uuid) is missing.';
  END IF;

  -- The membership predicate must SURVIVE. Identity and compliance reads still
  -- depend on it; migration 46 adds a predicate, it does not replace one.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'has_organisation_membership') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: has_organisation_membership was removed; 39 and 40 depend on it.';
  END IF;

  IF has_function_privilege('anon', 'public.has_verified_organisation_membership(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: anon can EXECUTE has_verified_organisation_membership.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.has_verified_organisation_membership(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: authenticated cannot EXECUTE has_verified_organisation_membership.';
  END IF;

  -- STABLE, not IMMUTABLE: an immutable predicate could be folded into a cached
  -- plan and keep a suspended buyer reading.
  IF (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='has_verified_organisation_membership') <> 's' THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the predicate must be STABLE.';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: predicate exists, is STABLE, anon cannot call it, and the membership predicate survives.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. Both buyer SELECT policies use the VERIFIED predicate
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_res text;
  v_rel text;
BEGIN
  SELECT qual INTO v_res FROM pg_policies
   WHERE schemaname='public' AND tablename='reservations' AND policyname='reservations_select';
  SELECT qual INTO v_rel FROM pg_policies
   WHERE schemaname='public' AND tablename='reservation_releases' AND policyname='reservation_releases_select';

  IF v_res IS NULL OR v_rel IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a buyer SELECT policy is missing (reservations=%, releases=%).',
      v_res IS NOT NULL, v_rel IS NOT NULL;
  END IF;

  IF position('has_verified_organisation_membership' IN v_res) = 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: reservations_select does not use the verified predicate: %', v_res;
  END IF;
  IF position('has_verified_organisation_membership' IN v_rel) = 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: reservation_releases_select does not use the verified predicate: %', v_rel;
  END IF;

  -- And must no longer fall back to the membership-only one, which would make
  -- the new predicate decorative: `a OR b` is true whenever the looser arm is.
  IF v_res ~ 'has_organisation_membership\(' THEN
    RAISE EXCEPTION 'VERIFY B FAILED: reservations_select still admits membership alone: %', v_res;
  END IF;
  IF v_rel ~ 'has_organisation_membership\(' THEN
    RAISE EXCEPTION 'VERIFY B FAILED: reservation_releases_select still admits membership alone: %', v_rel;
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: both buyer SELECT policies gate on verified membership only.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C–G. Behavioural
-- -----------------------------------------------------------------------------
DO $verify_behaviour$
DECLARE
  v_admin_user uuid := '00460000-0000-4000-a000-00000000e001';
  v_buyer_user uuid := '00460000-0000-4000-a000-00000000e002';
  v_farm       uuid;
  v_batch      uuid;
  v_buyer_org  uuid;
  v_res        uuid;
  v_seen       bigint;
  v_problems   text[] := ARRAY[]::text[];
BEGIN
  -- ── Fixtures ─────────────────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_admin_user, 'admin46@verify.test'), (v_buyer_user, 'buyer46@verify.test')
  ON CONFLICT (id) DO NOTHING;
  -- DO UPDATE, NOT DO NOTHING — this is load-bearing and cost an hour to find.
  --
  -- auth.users carries `on_auth_user_created` -> `handle_new_user()` (migration
  -- 21's controlled provisioning), which has ALREADY created a profile row with
  -- role 'pending' by the time this statement runs. `ON CONFLICT DO NOTHING`
  -- therefore does nothing at all, silently, and the fixture keeps role
  -- 'pending' while appearing to ask for 'ddp_admin'.
  --
  -- The failure that follows is maximally misleading: is_ddp_admin() returns
  -- false, the admin arm of the policy never fires, and the test reports
  -- "DDP admin cannot see the reservation" — which reads as a defect in the
  -- migration rather than in the fixture.
  INSERT INTO public.profiles (id, email, role) VALUES
    (v_admin_user, 'admin46@verify.test', 'ddp_admin'),
    (v_buyer_user, 'buyer46@verify.test', 'buyer')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

  INSERT INTO public.farms (farm_name, province, status)
  VALUES ('Verify46 Farm', 'Chiang Mai', 'active') RETURNING id INTO v_farm;

  INSERT INTO public.inventory_batches
    (farm_id, product_name, batch_number, quantity_kg, client_visible, status)
  VALUES (v_farm, 'Verify46 longan', 'V46-1', 1000, true, 'approved')
  RETURNING id INTO v_batch;

  INSERT INTO public.organisations
    (org_type, legal_name, country_code, verification_state, verified_by, verified_at)
  VALUES ('buyer', 'Verify46 Buyer', 'TH', 'verified', v_admin_user, now())
  RETURNING id INTO v_buyer_org;

  INSERT INTO public.organisation_memberships (organisation_id, user_id, org_role)
  VALUES (v_buyer_org, v_buyer_user, 'owner');

  INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
  VALUES (v_batch, v_buyer_org, 100) RETURNING id INTO v_res;

  -- `reason` is NOT NULL with CHECK (length(btrim(reason)) > 0) — migration 44
  -- requires every release to say why, so a blank string fails too.
  INSERT INTO public.reservation_releases (reservation_id, kind, reason)
  VALUES (v_res, 'cancelled', 'VERIFY 46 fixture');

  INSERT INTO v46 VALUES ('res', v_res), ('org', v_buyer_org);

  -- ── C. Verified buyer can read ───────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations WHERE id = v_res;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems, 'a VERIFIED buyer cannot read their own reservation');
  END IF;
  SELECT count(*) INTO v_seen FROM public.reservation_releases WHERE reservation_id = v_res;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems, 'a VERIFIED buyer cannot read their own release');
  END IF;

  PERFORM set_config('role', 'none', true);
  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: a verified buyer reads their own reservation and release.';

  -- ── D. Suspension removes both reads, and deletes nothing ────────────────
  UPDATE public.organisations SET verification_state = 'suspended',
         verification_basis = 'VERIFY 46' WHERE id = v_buyer_org;

  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations WHERE id = v_res;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      'A SUSPENDED BUYER CAN STILL READ THEIR RESERVATION — this is the Seam 5 defect');
  END IF;
  SELECT count(*) INTO v_seen FROM public.reservation_releases WHERE reservation_id = v_res;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems, 'a suspended buyer can still read their release');
  END IF;

  PERFORM set_config('role', 'none', true);

  -- The whole point of a gate rather than a delete: the evidence is untouched.
  SELECT count(*) INTO v_seen FROM public.reservations WHERE id = v_res;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems,
      'the reservation row was DESTROYED, not hidden — suspension must not delete');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organisation_memberships
                 WHERE organisation_id = v_buyer_org AND user_id = v_buyer_user) THEN
    v_problems := array_append(v_problems, 'the membership grant was removed — suspension must not revoke');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: suspension removed both reads on the next statement; row and grant intact.';

  -- ── E. Re-verifying restores access ──────────────────────────────────────
  UPDATE public.organisations SET verification_state = 'verified',
         verified_by = v_admin_user, verified_at = now() WHERE id = v_buyer_org;

  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations WHERE id = v_res;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems, 're-verifying did NOT restore read access');
  END IF;

  PERFORM set_config('role', 'none', true);
  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: re-verifying restores access, so the gate is live in both directions.';

  -- ── F. Identity survives suspension ──────────────────────────────────────
  -- Gating organisations_select would make onboarding and appeal impossible,
  -- because verification_state DEFAULTS to 'unverified'.
  UPDATE public.organisations SET verification_state = 'suspended',
         verification_basis = 'VERIFY 46' WHERE id = v_buyer_org;

  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.organisations WHERE id = v_buyer_org;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems,
      'a suspended member cannot see their OWN organisation — onboarding and appeal are now impossible');
  END IF;

  PERFORM set_config('role', 'none', true);
  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: a suspended member still sees their own organisation row.';

  -- ── G. Admin is unaffected ───────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.reservations WHERE id = v_res;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems,
      'DDP admin cannot see a suspended buyer''s reservation — suspension would be unadministrable');
  END IF;

  PERFORM set_config('role', 'none', true);
  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY G PASSED: DDP admin still sees the reservation of a suspended buyer.';
END
$verify_behaviour$;

ROLLBACK;
