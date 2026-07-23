-- 21_DDP_CONTROLLED_FARMER_PROVISIONING_VERIFY.sql
-- =============================================================================
-- Behavioural proof that migration 21 enforces DDP-only farmer provisioning.
-- Run against a database AFTER applying the hardening migration. It is fully
-- transactional and ends in ROLLBACK, so it leaves NO residue (mirrors the
-- pattern of 19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql).
--
-- Covers:
--   A. A brand-new auth user is auto-provisioned as 'pending', NOT 'farmer'.
--   B. The role CHECK now admits 'pending' and still rejects invalid roles.
--   C. RLS is enabled on profiles and the three role-guard policies exist
--      (the "admin update role" policy is the only role-change path).
--
-- The full request-context RLS proof (a non-admin JWT cannot self-promote) is
-- exercised by scripts/run-staging-security-tests.mjs against the live API,
-- because impersonating a JWT is out of scope for a plain SQL script.
--
-- NOTE: auth.users is seeded with id + email only; other columns are nullable
-- in this verification environment (same assumption as migration 19's VERIFY).
-- =============================================================================

BEGIN;

-- Guard: never run against real data. Abort if the test id already exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-a000-000000000020') THEN
    RAISE EXCEPTION 'VERIFY PRECONDITION FAILED: test auth.users id already exists — aborting to protect real data';
  END IF;
END $$;

-- Seed one brand-new auth user; the on_auth_user_created trigger fires.
INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-4000-a000-000000000020', 'verify-pending-20@ddp.test');

-- A. New user must be 'pending', not 'farmer'.
DO $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles
  WHERE id = '00000000-0000-4000-a000-000000000020';
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: no profile row was created for the new auth user';
  END IF;
  IF v_role <> 'pending' THEN
    RAISE EXCEPTION 'VERIFY A FAILED: new auth user got role %, expected pending (self-provisioning not blocked)', v_role;
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: brand-new auth user provisioned as pending (not an operational farmer).';
END $$;

-- B. CHECK admits 'pending' (already proven by A's insert) and rejects garbage.
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'not_a_role'
    WHERE id = '00000000-0000-4000-a000-000000000020';
    RAISE EXCEPTION 'VERIFY B FAILED: role CHECK accepted an invalid value';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'VERIFY B PASSED: role CHECK still rejects invalid roles.';
  END;
END $$;

-- C. RLS enabled + the three role-guard policies exist.
DO $$
DECLARE v_rls boolean; v_policies int;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class WHERE oid = 'public.profiles'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'VERIFY C FAILED: RLS is not enabled on public.profiles';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles'
    AND policyname IN (
      'profiles: select own or admin',
      'profiles: update own no role change',
      'profiles: admin update role'
    );
  IF v_policies <> 3 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: expected 3 role-guard policies on profiles, found %', v_policies;
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: RLS enabled and admin-only role-change policies present.';
END $$;

-- Leave no residue.
ROLLBACK;
