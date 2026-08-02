-- =============================================================================
-- Migration 39 — VERIFY: counterparty organisations
--
-- NOT READ-ONLY. This script inserts fixtures and is wrapped in an explicit
-- BEGIN … ROLLBACK, so it leaves nothing behind — but it must NOT be run
-- against Production under the change freeze. Use a disposable cluster or
-- staging.
--
-- SECTION E IS THE UNUSUAL ONE, AND THE IMPORTANT ONE.
-- Every other VERIFY in this repository runs entirely as the table owner, which
-- BYPASSES row level security — so a policy could be backwards and still verify
-- green. Section E switches to the `authenticated` role and re-queries, which is
-- the only way to observe what a real signed-in caller can see. The double-blind
-- brokerage rule is the platform's most consequential invariant, and reading the
-- policy text back to yourself is not evidence that it holds.
--
-- Sections:
--   A — tables, indexes and named constraints exist
--   B — profiles.role admits 'buyer' and still rejects an unknown role
--   C — RLS is enabled and the expected policies exist
--   D — the CHECK constraints reject the states they exist to reject
--   E — BEHAVIOURAL, as `authenticated`: the double-blind rule holds both ways
--   F — an audit event is emitted, and a verification change is distinguishable
--   G — anon holds no privilege on either table
--
-- Expected on success: seven PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_expected_constraints text[] := ARRAY[
    'organisations_farm_link_requires_farm_type',
    'organisations_verified_requires_evidence',
    'organisations_rejected_requires_basis'
  ];
  c text;
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    v_missing := array_append(v_missing, 'table public.organisations');
  END IF;
  IF to_regclass('public.organisation_memberships') IS NULL THEN
    v_missing := array_append(v_missing, 'table public.organisation_memberships');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_organisation_membership'
  ) THEN
    v_missing := array_append(v_missing, 'function public.has_organisation_membership(uuid)');
  END IF;

  IF to_regclass('public.organisations') IS NOT NULL THEN
    FOREACH c IN ARRAY v_expected_constraints LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = c AND conrelid = 'public.organisations'::regclass
      ) THEN
        v_missing := array_append(v_missing, 'constraint ' || c);
      END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_organisations_farm_id') THEN
      v_missing := array_append(v_missing, 'index uq_organisations_farm_id');
    END IF;
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: organisations, organisation_memberships, the membership predicate, all three coherence constraints and the farm-link unique index are present.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. The buyer role exists in the vocabulary
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_buyer_accepted  boolean := false;
  v_unknown_rejected boolean := false;
BEGIN
  -- THE auth.users ROWS MUST EXIST FIRST, AND THE UPSERT MUST BE `DO UPDATE`.
  --
  -- profiles.id is FK -> auth.users(id), so inserting a profile for an invented
  -- id raises foreign_key_violation, NOT check_violation — the handlers below do
  -- not catch it and the whole VERIFY dies before reaching any assertion. That is
  -- what happened on staging (2026-08-02): "insert or update on table profiles
  -- violates foreign key constraint profiles_id_fkey".
  --
  -- And on hosted Supabase, inserting the user FIRES `on_auth_user_created` ->
  -- handle_new_user(), which creates the profile row as 'pending' before this
  -- statement runs — so a plain INSERT would then raise unique_violation, and
  -- `ON CONFLICT DO NOTHING` would silently leave the role as 'pending' and
  -- assert nothing at all. `DO UPDATE` is correct in both environments: it sets
  -- the role whether the trigger pre-created the row or not, and still raises
  -- check_violation when the role is not in the vocabulary, which is the whole
  -- point of the test.
  INSERT INTO auth.users (id, email) VALUES
    ('00390000-0000-4000-a000-0000000000b1', 'b1@verify.test'),
    ('00390000-0000-4000-a000-0000000000b2', 'b2@verify.test')
  ON CONFLICT (id) DO NOTHING;

  BEGIN
    INSERT INTO public.profiles (id, email, role)
    VALUES ('00390000-0000-4000-a000-0000000000b1', 'b1@verify.test', 'buyer')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;
    v_buyer_accepted := true;
  EXCEPTION WHEN check_violation THEN
    v_buyer_accepted := false;
  END;

  -- Widening must not have degenerated into "anything goes". A role the system
  -- has no policy for is a role that would silently fall through every gate.
  BEGIN
    INSERT INTO public.profiles (id, email, role)
    VALUES ('00390000-0000-4000-a000-0000000000b2', 'b2@verify.test', 'auditor')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;
    v_unknown_rejected := false;
  EXCEPTION WHEN check_violation THEN
    v_unknown_rejected := true;
  END;

  IF NOT v_buyer_accepted THEN
    RAISE EXCEPTION 'VERIFY B FAILED: profiles_role_check rejects role = ''buyer''; migration 39 has not been applied to this database.';
  END IF;
  IF NOT v_unknown_rejected THEN
    RAISE EXCEPTION 'VERIFY B FAILED: profiles_role_check accepted an unknown role. The constraint has been widened to admit anything, not extended.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: profiles.role admits ''buyer'' and still rejects an unrecognised role.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. RLS posture
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_expected text[] := ARRAY[
    'organisations_select', 'organisations_insert', 'organisations_update',
    'organisations_delete', 'organisation_memberships_select', 'organisation_memberships_write'
  ];
  p text;
  v_anon_policies int;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organisations'::regclass) THEN
    v_problems := array_append(v_problems, 'RLS not enabled on organisations');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organisation_memberships'::regclass) THEN
    v_problems := array_append(v_problems, 'RLS not enabled on organisation_memberships');
  END IF;

  FOREACH p IN ARRAY v_expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname = p) THEN
      v_problems := array_append(v_problems, 'missing policy ' || p);
    END IF;
  END LOOP;

  -- Deny by default: no policy may name anon.
  SELECT count(*) INTO v_anon_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('organisations', 'organisation_memberships')
    AND 'anon' = ANY (roles);
  IF v_anon_policies > 0 THEN
    v_problems := array_append(v_problems, format('%s policy/policies grant anon a role', v_anon_policies));
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: RLS enabled on both tables, all six policies present, none naming anon.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. The constraints reject what they exist to reject
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_admitted text[] := ARRAY[]::text[];
  v_farm_id  uuid;
BEGIN
  INSERT INTO public.farms (id) VALUES ('00390000-0000-4000-a000-0000000000f1')
  ON CONFLICT DO NOTHING;
  v_farm_id := '00390000-0000-4000-a000-0000000000f1';

  -- A farm link on a non-farm organisation.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code, farm_id)
    VALUES ('buyer', 'Wrongly Linked Ltd', 'DE', v_farm_id);
    v_admitted := array_append(v_admitted, 'farm_id on a buyer organisation');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- "Verified" with nobody having verified it.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state)
    VALUES ('buyer', 'Self Certified GmbH', 'DE', 'verified');
    v_admitted := array_append(v_admitted, 'verification_state=verified with no verifier or timestamp');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- "Rejected" with no stated basis.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state)
    VALUES ('buyer', 'Unexplained SA', 'FR', 'rejected');
    v_admitted := array_append(v_admitted, 'verification_state=rejected with no basis');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Country code that will not resolve a destination ruleset.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('buyer', 'Lower Case Ltd', 'de');
    v_admitted := array_append(v_admitted, 'lower-case country_code');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- NaN ownership. In PostgreSQL NaN sorts ABOVE every real number, so a
  -- lower-bound-only CHECK would admit it. This asserts the upper bound is
  -- doing that job.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code, thai_ownership_pct)
    VALUES ('farm', 'Not A Number Co', 'TH', 'NaN'::numeric);
    v_admitted := array_append(v_admitted, 'thai_ownership_pct = NaN');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Out-of-range ownership.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code, thai_ownership_pct)
    VALUES ('farm', 'Over One Hundred Co', 'TH', 100.01);
    v_admitted := array_append(v_admitted, 'thai_ownership_pct > 100');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A blank legal name.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('buyer', '   ', 'DE');
    v_admitted := array_append(v_admitted, 'blank legal_name');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF array_length(v_admitted, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the database ADMITTED state it must reject: %',
      array_to_string(v_admitted, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: all seven invalid organisation states rejected, including NaN ownership.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. BEHAVIOURAL — the double-blind rule, observed as `authenticated`
--
-- This is the section that would catch a reversed policy. It builds one farm
-- organisation and one buyer organisation, gives each a member, and then asks
-- each member what it can see while actually running as that member.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_farm_user    uuid := '00390000-0000-4000-a000-0000000000e1';
  v_buyer_user   uuid := '00390000-0000-4000-a000-0000000000e2';
  v_admin_user   uuid := '00390000-0000-4000-a000-0000000000e3';
  v_farm_org     uuid;
  v_buyer_org    uuid;
  v_farm_id      uuid := '00390000-0000-4000-a000-0000000000f2';
  v_seen         bigint;
  v_seen_type    text;
  v_problems     text[] := ARRAY[]::text[];
  v_insert_blocked boolean := false;
BEGIN
  -- Fixtures, built as the owner.
  INSERT INTO auth.users (id, email) VALUES
    (v_farm_user,  'farm@verify.test'),
    (v_buyer_user, 'buyer@verify.test'),
    (v_admin_user, 'admin@verify.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, email, role) VALUES
    (v_farm_user,  'farm@verify.test',  'farmer'),
    (v_buyer_user, 'buyer@verify.test', 'buyer'),
    (v_admin_user, 'admin@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

  INSERT INTO public.farms (id) VALUES (v_farm_id) ON CONFLICT DO NOTHING;

  INSERT INTO public.organisations (org_type, legal_name, country_code, farm_id)
  VALUES ('farm', 'Chiang Mai Growers Co Ltd', 'TH', v_farm_id)
  RETURNING id INTO v_farm_org;

  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Frankfurt Import GmbH', 'DE')
  RETURNING id INTO v_buyer_org;

  INSERT INTO public.organisation_memberships (organisation_id, user_id, org_role) VALUES
    (v_farm_org,  v_farm_user,  'owner'),
    (v_buyer_org, v_buyer_user, 'owner');

  -- ── As the buyer ─────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.organisations;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems,
      format('buyer sees %s organisation(s), expected exactly 1 (its own)', v_seen));
  END IF;

  SELECT count(*) INTO v_seen FROM public.organisations WHERE org_type = 'farm';
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      format('DOUBLE-BLIND BREACH: buyer can see %s farm organisation(s)', v_seen));
  END IF;

  -- A buyer must not be able to create counterparties.
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('buyer', 'Self Registered Ltd', 'DE');
    v_insert_blocked := false;
  EXCEPTION WHEN insufficient_privilege THEN
    v_insert_blocked := true;
  END;
  IF NOT v_insert_blocked THEN
    v_problems := array_append(v_problems, 'buyer was able to INSERT an organisation');
  END IF;

  PERFORM set_config('role', 'none', true);

  -- ── As the farmer ────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_farm_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.organisations;
  IF v_seen <> 1 THEN
    v_problems := array_append(v_problems,
      format('farmer sees %s organisation(s), expected exactly 1 (its own)', v_seen));
  END IF;

  SELECT count(*) INTO v_seen FROM public.organisations WHERE org_type = 'buyer';
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      format('DOUBLE-BLIND BREACH: farmer can see %s buyer organisation(s)', v_seen));
  END IF;

  SELECT org_type INTO v_seen_type FROM public.organisations LIMIT 1;
  IF v_seen_type IS DISTINCT FROM 'farm' THEN
    v_problems := array_append(v_problems,
      format('farmer''s single visible organisation is of type %L, expected ''farm''', v_seen_type));
  END IF;

  PERFORM set_config('role', 'none', true);

  -- ── As a DDP admin ───────────────────────────────────────────────────────
  -- The broker is the one party that must see both sides. If this fails the
  -- policies are too tight and the platform cannot broker at all.
  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.organisations;
  IF v_seen < 2 THEN
    v_problems := array_append(v_problems,
      format('ddp_admin sees %s organisation(s), expected both sides', v_seen));
  END IF;

  PERFORM set_config('role', 'none', true);

  -- ── With no identity at all ──────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_seen FROM public.organisations;
  IF v_seen <> 0 THEN
    v_problems := array_append(v_problems,
      format('an authenticated caller with NO jwt subject sees %s organisation(s); the policies do not fail closed', v_seen));
  END IF;

  PERFORM set_config('role', 'none', true);

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: observed as role authenticated — buyer sees only its own organisation and zero farms, farmer sees only its own and zero buyers, ddp_admin sees both, an identity-less caller sees none, and a buyer cannot create an organisation.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. Audit
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_org        uuid;
  v_admin_user uuid := '00390000-0000-4000-a000-0000000000e3';
  v_created    bigint;
  v_verif      bigint;
  v_plain      bigint;
  v_split      boolean;
BEGIN
  -- WHICH LOG THE ADMINISTRATIVE EVENTS LAND IN DEPENDS ON MIGRATION 45.
  --
  -- Seam 7 (migration 45) moves organisation_created and organisation_updated
  -- out of compliance_audit_log and into commercial_audit_log, leaving only
  -- organisation_verification_changed behind. So this section must ask which
  -- regime the database is in rather than assume the pre-45 one — otherwise it
  -- reports "expected exactly 1 organisation_created audit row, found 0" on any
  -- database where 45 has been applied, which reads as a defect in migration 39.
  -- Measured on staging 2026-08-02, immediately after 45 was applied.
  --
  -- Detected from the vocabulary itself, not from a version number: if the
  -- compliance CHECK no longer admits 'organisation_created', 45 is applied. If
  -- 45 is applied then 44 is too, so commercial_audit_log necessarily exists.
  v_split := NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'compliance_audit_log_action_check'
      AND position('''organisation_created''' IN pg_get_constraintdef(c.oid)) > 0
  );

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('laboratory', 'Bangkok Analytical Services', 'TH')
  RETURNING id INTO v_org;

  IF v_split THEN
    SELECT count(*) INTO v_created FROM public.commercial_audit_log
     WHERE entity_type = 'organisation' AND entity_id = v_org::text AND action = 'organisation_created';
  ELSE
    SELECT count(*) INTO v_created FROM public.compliance_audit_log
     WHERE entity_type = 'organisation' AND entity_id = v_org::text AND action = 'organisation_created';
  END IF;
  IF v_created <> 1 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected exactly 1 organisation_created audit row in the % log, found %.',
      CASE WHEN v_split THEN 'commercial' ELSE 'compliance' END, v_created;
  END IF;

  -- A non-verification edit.
  UPDATE public.organisations SET display_name = 'BAS' WHERE id = v_org;
  IF v_split THEN
    SELECT count(*) INTO v_plain FROM public.commercial_audit_log
     WHERE entity_type = 'organisation' AND entity_id = v_org::text AND action = 'organisation_updated';
  ELSE
    SELECT count(*) INTO v_plain FROM public.compliance_audit_log
     WHERE entity_type = 'organisation' AND entity_id = v_org::text AND action = 'organisation_updated';
  END IF;
  IF v_plain <> 1 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected exactly 1 organisation_updated audit row in the % log, found %.',
      CASE WHEN v_split THEN 'commercial' ELSE 'compliance' END, v_plain;
  END IF;

  -- A verification change must be recorded as its own action, not folded into
  -- the generic update — it is the event an auditor searches for.
  UPDATE public.organisations
     SET verification_state = 'verified', verified_by = v_admin_user, verified_at = now(),
         verification_basis = 'Company registration and licence checked against DBD record'
   WHERE id = v_org;

  SELECT count(*) INTO v_verif FROM public.compliance_audit_log
   WHERE entity_type = 'organisation' AND entity_id = v_org::text
     AND action = 'organisation_verification_changed';
  IF v_verif <> 1 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected exactly 1 organisation_verification_changed audit row, found %.', v_verif;
  END IF;

  -- The actor must be the signed-in admin, not NULL and not 'system'.
  IF NOT EXISTS (
    SELECT 1 FROM public.compliance_audit_log
    WHERE entity_type = 'organisation' AND entity_id = v_org::text
      AND action = 'organisation_verification_changed'
      AND actor_id = v_admin_user AND actor_type = 'admin'
  ) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: the verification audit row does not name the acting admin.';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: create, update and verification-change each emit exactly one audit row, verification is a distinct action, and the acting admin is named.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_grants text[] := ARRAY[]::text[];
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisations', 'organisation_memberships'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', 'public.' || t, p) THEN
        v_grants := array_append(v_grants, format('anon has %s on %s', p, t));
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon', 'public.has_organisation_membership(uuid)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE has_organisation_membership');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: anon holds no table privilege on either table and cannot execute the membership predicate.';
END
$verify_g$;

ROLLBACK;
