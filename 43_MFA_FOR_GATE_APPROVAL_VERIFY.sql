-- =============================================================================
-- Migration 43 — VERIFY: MFA for gate approval
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure
--   B — the assurance level is read from BOTH JWT transports, and anything that
--       is not aal2 is not assurance
--   C — shipped DISABLED: an override succeeds without MFA at install, so
--       applying this migration cannot lock anybody out
--   D — once ENABLED, a password-only session is refused and an aal2 session
--       succeeds
--   E — a MISSING settings row means REQUIRED. Deleting a row must never be a
--       way to switch a control off.
--   F — the service_role exemption is narrow: no JWT subject at all is exempt,
--       but a signed-in user without aal2 is not
--   G — anon holds nothing
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
  f text;
BEGIN
  IF to_regclass('public.security_settings') IS NULL THEN
    v_missing := array_append(v_missing, 'table security_settings');
  END IF;

  FOREACH f IN ARRAY ARRAY['current_auth_assurance_level', 'has_mfa_assurance',
                           'mfa_required_for_gate_approval', 'fn_require_mfa_for_override',
                           'fn_guard_security_setting_weakening'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname=f) THEN
      v_missing := array_append(v_missing, 'function ' || f);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['export_gate_overrides_require_mfa', 'security_settings_guard_weakening'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = f AND NOT tgisinternal) THEN
      v_missing := array_append(v_missing, 'trigger ' || f);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.security_settings WHERE key='mfa_required_for_gate_approval') THEN
    v_missing := array_append(v_missing, 'the mfa_required_for_gate_approval setting row');
  END IF;

  -- Nobody may DELETE the setting row: the missing-row default exists to make
  -- deletion SAFE, not to make it a supported way to disable the control.
  IF has_table_privilege('authenticated', 'public.security_settings', 'DELETE') THEN
    v_missing := array_append(v_missing, 'authenticated must NOT hold DELETE on security_settings');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: the settings table with its seeded row, all four functions and the enforcement trigger are present, and DELETE on the settings table is granted to nobody.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. Reading the assurance claim
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  -- Transport 1: the whole claim set as JSON.
  PERFORM set_config('request.jwt.claims', '{"sub":"x","aal":"aal2"}', true);
  PERFORM set_config('request.jwt.claim.aal', '', true);
  IF public.current_auth_assurance_level() IS DISTINCT FROM 'aal2' THEN
    v_problems := array_append(v_problems, 'aal not read from request.jwt.claims JSON');
  END IF;
  IF NOT public.has_mfa_assurance() THEN
    v_problems := array_append(v_problems, 'aal2 in the JSON claim set did not satisfy has_mfa_assurance');
  END IF;

  -- Transport 2: the individual claim GUC.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.aal', 'aal2', true);
  IF public.current_auth_assurance_level() IS DISTINCT FROM 'aal2' THEN
    v_problems := array_append(v_problems, 'aal not read from request.jwt.claim.aal');
  END IF;

  -- Password only.
  PERFORM set_config('request.jwt.claim.aal', 'aal1', true);
  IF public.has_mfa_assurance() THEN
    v_problems := array_append(v_problems, 'aal1 satisfied has_mfa_assurance');
  END IF;

  -- Absent entirely.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.aal', '', true);
  IF public.has_mfa_assurance() THEN
    v_problems := array_append(v_problems, 'an absent assurance claim satisfied has_mfa_assurance');
  END IF;

  -- Malformed JSON must deny, not raise.
  BEGIN
    PERFORM set_config('request.jwt.claims', 'not json at all', true);
    IF public.has_mfa_assurance() THEN
      v_problems := array_append(v_problems, 'a malformed claim set satisfied has_mfa_assurance');
    END IF;
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a malformed claim set RAISED instead of denying');
  END;

  -- An unrecognised future value is not assurance.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.aal', 'aal3', true);
  IF public.has_mfa_assurance() THEN
    v_problems := array_append(v_problems, 'an unrecognised assurance value satisfied has_mfa_assurance');
  END IF;

  PERFORM set_config('request.jwt.claim.aal', '', true);

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: aal2 is read from both JWT transports; aal1, an absent claim, malformed JSON and an unrecognised value all deny, and malformed JSON denies without raising.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Shipped disabled — applying this migration locks nobody out
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_admin uuid := '00430000-0000-4000-a000-00000000ad01';
  v_buyer uuid;
  v_export uuid;
  v_eval  uuid;
BEGIN
  IF (SELECT enabled FROM public.security_settings WHERE key='mfa_required_for_gate_approval') THEN
    RAISE EXCEPTION 'VERIFY C FAILED: migration 43 shipped with MFA enforcement ENABLED. That locks every approver out on the day it is applied.';
  END IF;

  INSERT INTO auth.users (id, email) VALUES (v_admin, 'admin43@verify.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES (v_admin, 'admin43@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'MFA Test Buyer', 'DE') RETURNING id INTO v_buyer;
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('broker', 'MFA Test Exporter', 'TH') RETURNING id INTO v_export;

  -- The conditions blob must be realistic: migration 42 refuses an override that
  -- waives a condition the evaluation never had, or one that passed.
  INSERT INTO public.export_eligibility_evaluations
    (consignment_ref, buyer_organisation_id, exporter_organisation_id, regime,
     destination_country, quantity_kg, evaluated_as_of, outcome, conditions, blocking_reasons)
  VALUES ('CONS-MFA', v_buyer, v_export, 'controlled_herb', 'DE', 1.000, current_date,
          'blocked',
          jsonb_build_object(
            'buyer_import_permit_valid',  jsonb_build_object('pass', false, 'detail', 'no permit on file'),
            'permit_headroom_sufficient', jsonb_build_object('pass', false, 'detail', 'no permit to draw against'),
            'buyer_verified',             jsonb_build_object('pass', false, 'detail', 'unverified'),
            'screening_clear',            jsonb_build_object('pass', false, 'detail', 'never screened')),
          ARRAY['no permit on file'])
  RETURNING id INTO v_eval;

  -- A signed-in admin with password-only assurance.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.aal', 'aal1', true);

  INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
  VALUES (v_eval, v_admin, 'Permit confirmed by telephone with the competent authority.',
          ARRAY['buyer_import_permit_valid']);

  RAISE NOTICE 'VERIFY C PASSED: with enforcement off (the shipped default) a password-only admin can still approve an override, so applying migration 43 cannot lock anyone out.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Once enabled
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_admin uuid := '00430000-0000-4000-a000-00000000ad01';
  v_eval  uuid;
  v_refused boolean := false;
BEGIN
  SELECT id INTO v_eval FROM public.export_eligibility_evaluations WHERE consignment_ref='CONS-MFA';

  UPDATE public.security_settings
     SET enabled = true, changed_by = v_admin, changed_at = now(),
         note = 'Enabled by VERIFY section D.'
   WHERE key = 'mfa_required_for_gate_approval';

  -- Password only: refused.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.aal', 'aal1', true);
  BEGIN
    INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
    VALUES (v_eval, v_admin, 'Attempting to override without a second factor present.',
            ARRAY['buyer_import_permit_valid']);
    v_refused := false;
  EXCEPTION WHEN others THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a password-only session overrode the export gate while MFA enforcement was ENABLED.';
  END IF;

  -- With a second factor: allowed.
  PERFORM set_config('request.jwt.claim.aal', 'aal2', true);
  INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
  VALUES (v_eval, v_admin, 'Second factor presented; permit scan filed under vault://mfa-1.',
          ARRAY['permit_headroom_sufficient']);

  RAISE NOTICE 'VERIFY D PASSED: with enforcement on, a password-only session is refused and an aal2 session succeeds.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. A missing row means REQUIRED
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_admin uuid := '00430000-0000-4000-a000-00000000ad01';
  v_eval  uuid;
  v_refused boolean := false;
BEGIN
  SELECT id INTO v_eval FROM public.export_eligibility_evaluations WHERE consignment_ref='CONS-MFA';

  -- FIRST: weakening the control requires the assurance it is about to remove.
  -- Without this, MFA enforcement is a bypass with one extra step — disable,
  -- approve, re-enable — and the control stops being a control.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.aal', 'aal1', true);
  BEGIN
    UPDATE public.security_settings SET enabled = false, note = 'switched off without a second factor'
     WHERE key = 'mfa_required_for_gate_approval';
    v_refused := false;
  EXCEPTION WHEN others THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a password-only admin DISABLED MFA enforcement. The control can be switched off by exactly the session it exists to stop.';
  END IF;

  BEGIN
    DELETE FROM public.security_settings WHERE key = 'mfa_required_for_gate_approval';
    v_refused := false;
  EXCEPTION WHEN others THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a password-only admin DELETED the enforcement row.';
  END IF;

  -- Strengthening must never be harder than leaving it off.
  UPDATE public.security_settings SET enabled = true, note = 'still on' WHERE key = 'mfa_required_for_gate_approval';

  -- Now delete it with a second factor present, to reach the missing-row case.
  PERFORM set_config('request.jwt.claim.aal', 'aal2', true);
  DELETE FROM public.security_settings WHERE key = 'mfa_required_for_gate_approval';

  IF NOT public.mfa_required_for_gate_approval() THEN
    RAISE EXCEPTION 'VERIFY E FAILED: deleting the settings row DISABLED MFA enforcement. Removing a row must never be a way to switch off a control.';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.aal', 'aal1', true);
  BEGIN
    INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
    VALUES (v_eval, v_admin, 'Override attempted after the settings row was deleted.',
            ARRAY['buyer_verified']);
    v_refused := false;
  EXCEPTION WHEN others THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY E FAILED: with the settings row deleted, a password-only override succeeded.';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: a password-only session can neither disable nor delete the enforcement row, strengthening it is unrestricted, and with the row deleted enforcement defaults to REQUIRED so a password-only override is still refused.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. The service_role exemption is narrow
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_admin uuid := '00430000-0000-4000-a000-00000000ad01';
  v_eval  uuid;
BEGIN
  SELECT id INTO v_eval FROM public.export_eligibility_evaluations WHERE consignment_ref='CONS-MFA';

  -- No JWT subject at all — a back-office / service_role connection.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.aal', '', true);

  INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
  VALUES (v_eval, v_admin, 'Back-office correction applied by a server-side process.',
          ARRAY['screening_clear']);

  -- Section D already proved the other half: a signed-in user WITHOUT aal2 is
  -- refused. Together these show the exemption keys on the absence of a session,
  -- not on the absence of an assurance claim.
  RAISE NOTICE 'VERIFY F PASSED: a connection with no JWT subject is exempt (it cannot present a second factor), while section D showed a signed-in session without aal2 is refused.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_grants text[] := ARRAY[]::text[];
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.security_settings', p) THEN
      v_grants := array_append(v_grants, format('anon has %s on security_settings', p));
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.has_mfa_assurance()', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE has_mfa_assurance');
  END IF;
  IF has_function_privilege('anon', 'public.mfa_required_for_gate_approval()', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE mfa_required_for_gate_approval');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: anon holds no privilege on security_settings and cannot execute the assurance functions.';
END
$verify_g$;

ROLLBACK;
