-- ============================================================================
-- 71 — VERIFY
-- ============================================================================
--
-- Sections A–F. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, so a section that is skipped is never mistaken for one that passed.
--
-- A  STRUCTURAL — seventeen auditor policies, and nothing else newly on PUBLIC
-- B  BEHAVIOURAL — become each auditing role and read a row from all seventeen
-- C  BEHAVIOURAL — 71 gives an ordinary logged-in user nothing it did not have
-- D  BEHAVIOURAL — the auditing roles read and still cannot write
-- E  the apply recorded itself in the ledger
-- F  the standing condition the predicate depends on
--
-- WHY SECTION B IS THE WHOLE POINT HERE, and why counting is not enough.
--
-- On these seventeen tables the DEFECT IS A ZERO. The auditing role was never
-- refused; it was told "nothing here" about tables that in two cases were not
-- empty. So a VERIFY that ran `SELECT count(*)` and checked for no error would
-- pass identically before and after this migration, and a VERIFY that checked
-- `count(*) = 0` would pass on a broken database and an empty one alike.
--
-- The only assertion that means anything is: a row that IS THERE must be
-- VISIBLE. So B writes one row into each of the seventeen and then requires
-- each auditing role to find that specific row. Nothing else would distinguish
-- a fixed table from an empty one.
--
-- WHY SECTION C EXISTS. 71 adds policies scoped `TO public`, and `public`
-- includes `authenticated`. If the predicate were ever loosened, the people it
-- would quietly let through are the application's own logged-in users. C pins
-- the exact visibility an ordinary non-admin user has across all seventeen
-- tables. Those expected values were measured, not assumed: the same probe was
-- run against this world with 71 applied and with 71 rolled back, and the two
-- results were byte-identical. C encodes that result so it cannot drift.
--
-- Note two of the expected values are 1, not 0, and that is correct rather than
-- a leak: `destination_rulesets` and `security_settings` already carry
-- `USING (true)` policies for `authenticated` from their own migrations. C
-- asserts those still read 1 — if they went to 0, 71 would have broken the
-- application rather than widened it, which is the failure in the other
-- direction and just as much worth catching.
--
-- Sections B, C and D build their own rows and unwind them via a caught
-- exception. They never touch a pre-existing row.
--
-- ── SECTIONS B AND D CANNOT RUN IN THE SUPABASE SQL EDITOR ──────────────────
--
-- Learned the hard way on 2026-08-12, after this file was handed to the owner
-- claiming they would. They fail with:
--
--     ERROR: permission denied to set role "ddp_ro"
--
-- PostgreSQL 16 split role membership into an INHERIT option and a SET option,
-- and on production `postgres` holds the first and not the second:
--
--     pg_has_role('postgres','ddp_ro','MEMBER') = true
--     pg_has_role('postgres','ddp_ro','SET')    = FALSE
--
-- The original check asked for MEMBER, saw true, and concluded SET ROLE would
-- work. MEMBER is not the question. If you are testing whether something can
-- SET ROLE, ask for 'SET'.
--
-- This file is unchanged for the disposable-PostgreSQL harness, where the roles
-- are created locally, the runner IS superuser, and B and D are the sections
-- that give this migration its meaning. To run it on PRODUCTION, either:
--
--   * run only A, C, E and F in the editor, and verify B and D from the
--     auditing role's OWN connection, which is stronger than a superuser
--     simulating it — that is how they were verified on 2026-08-12:
--       B: as ddp_ro, public_intake_attempts -> 14, security_settings -> 1
--          (both read 0 before this migration), and all 23 readable tables
--          agreed exactly with pg_stat_user_tables;
--       D: as ddp_ro, INSERT and UPDATE both -> permission denied; or
--
--   * run `GRANT ddp_ro, ddp_audit_reader TO postgres WITH SET TRUE;` first,
--     which grants no new data access — postgres is already BYPASSRLS — and
--     then run this file whole. That is a production permission change and
--     deserves to be a decision rather than a side effect.
--
-- `SET LOCAL ROLE authenticated` in section C is unaffected: set_option is
-- true for that role, so C runs in the editor as written.
-- ============================================================================

-- A — structural.
DO $a$
DECLARE
  tables text[] := ARRAY['commercial_audit_log', 'destination_rulesets',
                         'export_eligibility_evaluations', 'export_gate_overrides',
                         'licences', 'organisation_memberships', 'organisations',
                         'permit_drawdowns', 'permits', 'procurement_decisions',
                         'public_intake_attempts', 'requirement_overrides',
                         'reservation_releases', 'reservations', 'risk_overrides',
                         'screening_checks', 'security_settings'];
  n int;
  stragglers text;
BEGIN
  SELECT count(*) INTO n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = ANY (tables)
     AND policyname LIKE '%: auditor read'
     AND permissive = 'PERMISSIVE'
     AND cmd = 'SELECT'
     AND roles::text = '{public}'
     AND qual LIKE '%ddp_ro%'
     AND qual LIKE '%ddp_audit_reader%';
  IF n <> 17 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: expected 17 auditor read policies naming both auditing roles, found %', n;
  END IF;

  -- 71 is purely additive: it must not have put anything ELSE on PUBLIC. If a
  -- future edit re-scoped one of these tables' own policies to PUBLIC, the
  -- plan-time EXECUTE trap that made migration 70 complicated would appear
  -- here too, and the auditor's read would start erroring instead of working.
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname)
    INTO stragglers
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = ANY (tables)
     AND cmd IN ('SELECT', 'ALL')
     AND roles::text = '{public}'
     AND policyname NOT LIKE '%: auditor read';
  IF stragglers IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: these policies are on PUBLIC and will be planned for the auditing roles — %',
      stragglers;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: seventeen auditor read policies exist on PUBLIC, and 71 put nothing else there.';
END
$a$;

-- B — behavioural. A row that is there must be visible to each auditing role.
DO $b$
DECLARE
  v_user  uuid := gen_random_uuid();
  v_farm  uuid; v_batch uuid; v_org uuid; v_buyer uuid;
  v_permit uuid; v_eval uuid; v_resv uuid;
  v_role  text;
  n       bigint;
BEGIN
  BEGIN
    -- Only (id, email): the disposable substrate's auth.users has exactly id,
    -- email and raw_user_meta_data.
    INSERT INTO auth.users (id, email) VALUES (v_user, 'auditor-71-b@example.invalid');
    INSERT INTO public.profiles (id, email, display_name, role)
    VALUES (v_user, 'auditor-71-b@example.invalid', 'Auditor 71 B', 'ddp_admin')
    ON CONFLICT (id) DO UPDATE SET role = 'ddp_admin';

    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Auditor 71 Farm', 'Approved') RETURNING id INTO v_farm;

    -- client_visible, because a reservation refuses an unpublished batch.
    INSERT INTO public.inventory_batches (id, farm_id, product_name, quantity_kg, client_visible)
    VALUES (gen_random_uuid(), v_farm, 'Auditor 71 Batch', 50.000, true) RETURNING id INTO v_batch;

    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('farm', 'P71 Exporter Ltd', 'TH') RETURNING id INTO v_org;

    -- Verified, and with the evidence the CHECK demands: only a verified buyer
    -- may hold stock, so an unverified one cannot reach the reservation ledger.
    INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state, verified_by, verified_at)
    VALUES ('buyer', 'P71 Buyer GmbH', 'DE', 'verified', v_user, now()) RETURNING id INTO v_buyer;

    INSERT INTO public.organisation_memberships (organisation_id, user_id, org_role)
    VALUES (v_org, v_user, 'owner');

    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'P71-LIC-1',
      current_date - 30, date_part('year', current_date - 30)::int + 543,
      current_date + 90, date_part('year', current_date + 90)::int + 543, 'vault://p71-lic');

    INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
    VALUES (v_buyer, 'import', 'controlled_herb', 'DE', 'P71-IMP-1',
      current_date - 10, date_part('year', current_date - 10)::int + 543,
      current_date + 90, date_part('year', current_date + 90)::int + 543,
      100.000, 'vault://p71-imp') RETURNING id INTO v_permit;

    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit, 10.000, 'P71-CONS-1', 'probe row for 71 VERIFY');

    INSERT INTO public.screening_checks (organisation_id, provider, result, valid_until, evidence_ref)
    VALUES (v_buyer, 'manual', 'clear', current_date + 180, 'vault://p71-screen');

    INSERT INTO public.destination_rulesets (country_code, regime, version, effective_from, source_reference)
    VALUES ('DE', 'controlled_herb', 1, current_date - 365, 'vault://p71-rules');

    -- Blocked, with the failing condition named: the gate refuses an override
    -- of an evaluation that passed, and refuses waiving a condition it never
    -- evaluated. Both refusals are correct, and both had to be satisfied to get
    -- a row into export_gate_overrides at all.
    INSERT INTO public.export_eligibility_evaluations (consignment_ref, buyer_organisation_id,
      exporter_organisation_id, regime, destination_country, quantity_kg, evaluated_as_of,
      outcome, conditions, blocking_reasons)
    VALUES ('P71-CONS-1', v_buyer, v_org, 'controlled_herb', 'DE', 5.000, current_date,
      'blocked', '{"probe_condition":{"pass":false}}'::jsonb, ARRAY['probe blocking reason'])
    RETURNING id INTO v_eval;

    INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
    VALUES (v_eval, v_user, 'probe row written by 71 VERIFY section B', ARRAY['probe_condition']);

    INSERT INTO public.reservations (inventory_batch_id, buyer_organisation_id, quantity_kg)
    VALUES (v_batch, v_buyer, 1.000) RETURNING id INTO v_resv;

    INSERT INTO public.reservation_releases (reservation_id, kind, reason)
    VALUES (v_resv, 'cancelled', 'probe row for 71 VERIFY');

    -- NOT inserted by hand: migration 44's reservation ledger writes
    -- commercial_audit_log itself, by trigger, on both the reservation and its
    -- release. Adding a row here as well produced three and broke an exact
    -- count -- which is why the assertion below is ">= 1" rather than "= 1".
    INSERT INTO public.procurement_decisions (batch_id, decision, reason, decided_by)
    VALUES ('P71-B1', 'progress', 'probe row for 71 VERIFY', v_user);

    INSERT INTO public.requirement_overrides (farm_id, requirement_type, status, reason, decided_by)
    VALUES (v_farm::text, 'coa', 'verified', 'probe row for 71 VERIFY', v_user);

    INSERT INTO public.risk_overrides (risk_id, status, reason, decided_by)
    VALUES ('P71-RISK-1', 'accepted', 'probe row for 71 VERIFY', v_user);

    INSERT INTO public.public_intake_attempts (bucket_key) VALUES ('p71-probe-bucket');

    INSERT INTO public.security_settings (key, enabled, note, changed_by)
    VALUES ('p71_probe_setting', true, 'probe row for 71 VERIFY', v_user);

    -- ── Now become each auditing role and find every one of those rows ──────
    FOREACH v_role IN ARRAY ARRAY['ddp_ro', 'ddp_audit_reader'] LOOP
      EXECUTE format('SET LOCAL ROLE %I', v_role);

      -- >= 1 deliberately: the reservation ledger writes these rows by trigger
      -- and the exact number is 44's business, not this migration's. What 71
      -- claims is that the auditing role can SEE them, and zero would mean it
      -- cannot.
      EXECUTE 'SELECT count(*) FROM public.commercial_audit_log WHERE entity_id = $1' INTO n USING v_resv::text;
      IF n < 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw no rows of commercial_audit_log, expected at least 1', v_role; END IF;

      EXECUTE 'SELECT count(*) FROM public.destination_rulesets WHERE source_reference = $1' INTO n USING 'vault://p71-rules';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of destination_rulesets, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.export_eligibility_evaluations WHERE consignment_ref = $1' INTO n USING 'P71-CONS-1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of export_eligibility_evaluations, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.export_gate_overrides WHERE evaluation_id = $1' INTO n USING v_eval;
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of export_gate_overrides, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.licences WHERE licence_number = $1' INTO n USING 'P71-LIC-1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of licences, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.organisation_memberships WHERE user_id = $1' INTO n USING v_user;
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of organisation_memberships, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.organisations WHERE id IN ($1, $2)' INTO n USING v_org, v_buyer;
      IF n <> 2 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of organisations, expected 2', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.permit_drawdowns WHERE consignment_ref = $1' INTO n USING 'P71-CONS-1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of permit_drawdowns, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.permits WHERE permit_number = $1' INTO n USING 'P71-IMP-1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of permits, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.procurement_decisions WHERE batch_id = $1' INTO n USING 'P71-B1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of procurement_decisions, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.public_intake_attempts WHERE bucket_key = $1' INTO n USING 'p71-probe-bucket';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of public_intake_attempts, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.requirement_overrides WHERE farm_id = $1' INTO n USING v_farm::text;
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of requirement_overrides, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.reservation_releases WHERE reservation_id = $1' INTO n USING v_resv;
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of reservation_releases, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.reservations WHERE id = $1' INTO n USING v_resv;
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of reservations, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.risk_overrides WHERE risk_id = $1' INTO n USING 'P71-RISK-1';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of risk_overrides, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.screening_checks WHERE evidence_ref = $1' INTO n USING 'vault://p71-screen';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of screening_checks, expected 1', v_role, n; END IF;

      EXECUTE 'SELECT count(*) FROM public.security_settings WHERE key = $1' INTO n USING 'p71_probe_setting';
      IF n <> 1 THEN RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of security_settings, expected 1', v_role, n; END IF;

      RESET ROLE;
    END LOOP;

    RAISE EXCEPTION 'VERIFY_B_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: an auditing role was refused outright — %. 71 assumes the SELECT grants are already held.',
        SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM <> 'VERIFY_B_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY B PASSED: ddp_ro and ddp_audit_reader each found the probe row in all seventeen tables — the silent zero is closed (on rows this section built and then unwound).';
END
$b$;

-- C — behavioural. 71 must give an ordinary logged-in user nothing new.
DO $c$
DECLARE
  v_other uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_farm  uuid; v_org uuid;
  n       bigint;
  denied  boolean;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (v_other, 'auditor-71-c-other@example.invalid'),
      (v_admin, 'auditor-71-c-admin@example.invalid');
    INSERT INTO public.profiles (id, email, display_name, role) VALUES
      (v_other, 'auditor-71-c-other@example.invalid', 'Verify 71 C Other', 'pending'),
      (v_admin, 'auditor-71-c-admin@example.invalid', 'Verify 71 C Admin', 'ddp_admin')
    ON CONFLICT (id) DO UPDATE SET role = excluded.role;

    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Verify 71 C Farm', 'Approved') RETURNING id INTO v_farm;

    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('buyer', 'P71C Buyer Ltd', 'DE') RETURNING id INTO v_org;

    INSERT INTO public.destination_rulesets (country_code, regime, version, effective_from, source_reference)
    VALUES ('FR', 'controlled_herb', 1, current_date - 200, 'vault://p71c-rules');

    INSERT INTO public.security_settings (key, enabled, note, changed_by)
    VALUES ('p71c_probe_setting', true, 'probe row for 71 VERIFY section C', v_admin);

    INSERT INTO public.risk_overrides (risk_id, status, reason, decided_by)
    VALUES ('P71C-RISK', 'accepted', 'probe row for 71 VERIFY section C', v_admin);

    INSERT INTO public.public_intake_attempts (bucket_key) VALUES ('p71c-probe-bucket');

    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- 1. An ordinary non-admin sees NOTHING it did not see before. These
    --    expected values were measured against this same world with 71 applied
    --    and with 71 rolled back; the two runs were identical.
    EXECUTE 'SELECT count(*) FROM public.organisations WHERE id = $1' INTO n USING v_org;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin saw an organisation (% rows) — 71 widened access', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.risk_overrides WHERE risk_id = $1' INTO n USING 'P71C-RISK';
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin saw a risk override (% rows) — 71 widened access', n; END IF;

    -- 2. public_intake_attempts is service_role only: authenticated holds NO
    --    grant at all and must still be refused at the privilege layer, which
    --    a policy on PUBLIC cannot and must not change.
    denied := false;
    BEGIN
      EXECUTE 'SELECT count(*) FROM public.public_intake_attempts' INTO n;
    EXCEPTION WHEN insufficient_privilege THEN denied := true;
    END;
    IF NOT denied THEN
      RAISE EXCEPTION 'VERIFY C FAILED: an ordinary logged-in user can now read public_intake_attempts';
    END IF;

    -- 3. THE OTHER DIRECTION. These two tables carry `USING (true)` policies for
    --    authenticated from their own migrations. If 71 had disturbed them they
    --    would read 0 here, which would be 71 breaking the application rather
    --    than widening it — just as much worth catching.
    EXECUTE 'SELECT count(*) FROM public.destination_rulesets WHERE source_reference = $1' INTO n USING 'vault://p71c-rules';
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: a logged-in user can no longer read destination_rulesets (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.security_settings WHERE key = $1' INTO n USING 'p71c_probe_setting';
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: a logged-in user can no longer read security_settings (saw %)', n; END IF;

    -- 4. An admin still reads the admin-gated tables.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXECUTE 'SELECT count(*) FROM public.organisations WHERE id = $1' INTO n USING v_org;
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read organisations (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.risk_overrides WHERE risk_id = $1' INTO n USING 'P71C-RISK';
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read risk_overrides (saw %)', n; END IF;

    RESET ROLE;

    RAISE EXCEPTION 'VERIFY_C_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'VERIFY_C_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY C PASSED: an ordinary logged-in user gained nothing from 71, is still refused public_intake_attempts outright, still reads the two deliberately-open tables, and an admin still reads the admin-gated ones.';
END
$c$;

-- D — behavioural. The auditing roles read. They must not write.
DO $d$
DECLARE
  v_org    uuid;
  v_failed boolean;
BEGIN
  BEGIN
    INSERT INTO public.organisations (org_type, legal_name, country_code)
    VALUES ('buyer', 'P71D Buyer Ltd', 'DE') RETURNING id INTO v_org;

    EXECUTE 'SET LOCAL ROLE ddp_ro';

    v_failed := false;
    BEGIN
      EXECUTE 'INSERT INTO public.organisations (org_type, legal_name, country_code) VALUES (''buyer'', ''Forged Ltd'', ''DE'')';
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'VERIFY D FAILED: the auditing role INSERTed into organisations'; END IF;

    v_failed := false;
    BEGIN
      EXECUTE format('UPDATE public.organisations SET legal_name = ''Forged'' WHERE id = %L', v_org);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'VERIFY D FAILED: the auditing role UPDATEd organisations'; END IF;

    v_failed := false;
    BEGIN
      EXECUTE format('DELETE FROM public.organisations WHERE id = %L', v_org);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN RAISE EXCEPTION 'VERIFY D FAILED: the auditing role DELETEd from organisations'; END IF;

    RESET ROLE;

    RAISE EXCEPTION 'VERIFY_D_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VERIFY_D_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY D PASSED: the auditing role could not INSERT, UPDATE or DELETE — what 71 granted is a read and nothing more.';
END
$d$;

-- E — an apply that leaves no record is the failure 67 exists to close.
DO $e$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: no migrations ledger — apply 67 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 71 AND evidence = 'self-recorded' AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: 71 did not record its own apply in the ledger';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: 71 recorded its own apply in the ledger.';
END
$e$;

-- F — the standing condition, re-asserted because 71 widens its reach.
--
-- `current_user IN ('ddp_ro','ddp_audit_reader')` is safe only while nothing
-- else can make current_user one of those names. A SECURITY DEFINER function
-- OWNED by either role would do exactly that: every caller would run as the
-- auditing role and inherit this read across all seventeen tables as well as
-- migration 70's five. Measured as zero on production on 2026-08-12.
DO $f$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname || ' owned by ' || pg_get_userbyid(p.proowner), ', ')
    INTO bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND pg_get_userbyid(p.proowner) IN ('ddp_ro', 'ddp_audit_reader');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: a SECURITY DEFINER function is owned by an auditing role, so any caller runs as that role and inherits its read — %',
      bad;
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: neither auditing role owns a SECURITY DEFINER function.';
END
$f$;
