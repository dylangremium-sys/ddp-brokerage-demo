-- =============================================================================
-- Migration 34 — VERIFY (farmer access requests)
-- Production-safe: one transaction, ends in ROLLBACK.
-- =============================================================================
BEGIN;

-- VERIFY A — table, RLS, trigger and reviewer-stamp function exist.
DO $verify_a$
DECLARE missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.farmer_access_requests') IS NULL THEN
    missing := missing || 'table farmer_access_requests';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='farmer_access_requests' AND c.relrowsecurity) THEN
    missing := missing || 'RLS not enabled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='farmer_access_requests_stamp_review') THEN
    missing := missing || 'trigger farmer_access_requests_stamp_review';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='stamp_farmer_access_request_review'
      AND p.prosecdef
      AND array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') ILIKE '%search_path=public%'
  ) THEN
    missing := missing || 'stamp function missing or not SECURITY DEFINER with pinned search_path';
  END IF;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: table with RLS, stamp trigger and hardened function all present.';
END
$verify_a$;

-- VERIFY B — a valid public submission is accepted.
DO $verify_b$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.farmer_access_requests (full_name, email, phone, province, position, preferred_language)
  VALUES ('Somchai Verify', 'somchai.verify@example.com', '+66 81 234 5678', 'Buriram', 'Farmer', 'th')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RAISE EXCEPTION 'VERIFY B FAILED: a valid request was not stored'; END IF;
  PERFORM set_config('v34.req', v_id::text, true);
  RAISE NOTICE 'VERIFY B PASSED: a valid access request is accepted.';
END
$verify_b$;

-- VERIFY C — malformed input is refused (the public surface is untrusted).
DO $verify_c$
DECLARE bad_email boolean := false; long_note boolean := false; empty_name boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.farmer_access_requests (full_name, email, phone)
    VALUES ('X', 'not-an-email', '+66 81 000 0000');
  EXCEPTION WHEN check_violation THEN bad_email := true;
  END;

  BEGIN
    INSERT INTO public.farmer_access_requests (full_name, email, phone, note)
    VALUES ('X', 'x@example.com', '+66 81 000 0000', repeat('a', 2001));
  EXCEPTION WHEN check_violation THEN long_note := true;
  END;

  BEGIN
    INSERT INTO public.farmer_access_requests (full_name, email, phone)
    VALUES ('   ', 'x@example.com', '+66 81 000 0000');
  EXCEPTION WHEN check_violation THEN empty_name := true;
  END;

  IF NOT bad_email  THEN RAISE EXCEPTION 'VERIFY C FAILED: a malformed email was accepted'; END IF;
  IF NOT long_note  THEN RAISE EXCEPTION 'VERIFY C FAILED: an oversized note was accepted'; END IF;
  IF NOT empty_name THEN RAISE EXCEPTION 'VERIFY C FAILED: a blank name was accepted'; END IF;

  RAISE NOTICE 'VERIFY C PASSED: malformed email, oversized note and blank name are all refused.';
END
$verify_c$;

-- VERIFY D — a request cannot arrive pre-approved.
DO $verify_d$
DECLARE blocked boolean := false;
BEGIN
  -- The INSERT policy pins status='new' with no reviewer. Owner connections
  -- bypass RLS, so assert the POLICY TEXT carries the restriction.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='farmer_access_requests'
      AND cmd='INSERT'
      AND with_check LIKE '%new%'
      AND with_check LIKE '%reviewed_by IS NULL%'
  ) THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the submit policy does not pin status=new with no reviewer';
  END IF;

  -- And the table-level constraint blocks a decided-but-unreviewed row.
  BEGIN
    INSERT INTO public.farmer_access_requests (full_name, email, phone, status)
    VALUES ('Pre Approved', 'pre@example.com', '+66 81 000 0001', 'invited');
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a request was stored as decided with no reviewer';
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: a submission cannot arrive pre-approved or name a reviewer.';
END
$verify_d$;

-- VERIFY E — triage is refused when there is no authenticated actor.
--
-- An owner/SQL connection has no auth.uid(), so this asserts the guard rather
-- than the happy path. The authenticated-admin path is covered by the staging
-- integration test, which triages as a real administrator.
DO $verify_e$
DECLARE v_id uuid := current_setting('v34.req')::uuid; refused boolean := false; msg text;
BEGIN
  BEGIN
    UPDATE public.farmer_access_requests SET status = 'contacted' WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    refused := true; GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;

  IF NOT refused THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a status change was recorded with no named reviewer';
  END IF;
  IF msg NOT ILIKE '%named reviewer%' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: unexpected refusal message: %', msg;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: triage without an authenticated administrator is refused.';
END
$verify_e$;

-- VERIFY F — the public may submit but must never read, and nobody may delete.
DO $verify_f$
DECLARE offending text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='farmer_access_requests'
      AND cmd='SELECT' AND coalesce(qual,'') NOT LIKE '%is_ddp_admin%'
  ) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a SELECT policy does not require is_ddp_admin()';
  END IF;

  SELECT string_agg(policyname, ', ') INTO offending
  FROM pg_policies
  WHERE schemaname='public' AND tablename='farmer_access_requests' AND cmd='DELETE';

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a DELETE policy exists (%)', offending;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: reads are admin-only and no delete path is exposed.';
END
$verify_f$;

ROLLBACK;
