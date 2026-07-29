-- =============================================================================
-- SELF-SIGNUP CONTAINMENT — diagnose and repair, in one run
--
-- WHAT THIS IS FOR
--   Production has public self-signup ENABLED (`disable_signup: false`,
--   confirmed read-only via /auth/v1/settings). Migration 21 is the database
--   half of the defence against that: a brand-new auth user must be stamped
--   'pending' (non-operational), never 'farmer'.
--
--   We could not verify from outside whether migration 21's SQL is applied to
--   production, and verifying it by signing up would mean creating an account.
--   So this script answers the question AND fixes it in the same run.
--
-- SAFE TO RUN ANYWHERE, MORE THAN ONCE
--   * Idempotent and transactional — it either fully applies or does nothing.
--   * It does NOT alter any existing profile's role. Current farmers and
--     admins are untouched.
--   * If the protection is already in place it reports that and changes nothing.
--
-- HOW TO RUN
--   Supabase dashboard -> your project -> SQL Editor -> paste -> Run.
--   Read the NOTICE output: it tells you whether you were exposed.
--
-- THIS IS ONLY HALF THE FIX
--   The other half cannot be expressed in SQL and must be done in the
--   dashboard: Authentication -> Providers/Settings -> turn OFF
--   "Allow new users to sign up". The service-role admin API bypasses that
--   toggle, so DDP's own farmer provisioning keeps working.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. DIAGNOSE — what does this database currently do with a new signup?
-- -----------------------------------------------------------------------------
DO $diagnose$
DECLARE
  v_src         text;
  v_assigns     text;
  v_pending_cnt integer;
  v_farmer_cnt  integer;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      'containment aborted: public.handle_new_user() does not exist. This database '
      'does not match the expected DDP schema — stop and investigate before running this.';
  END IF;

  IF v_src ~ '''pending''' THEN
    v_assigns := 'pending';
  ELSIF v_src ~ '''farmer''' THEN
    v_assigns := 'farmer';
  ELSE
    v_assigns := 'unknown';
  END IF;

  PERFORM set_config('containment.before', v_assigns, true);

  SELECT count(*) FILTER (WHERE role = 'pending'),
         count(*) FILTER (WHERE role = 'farmer')
    INTO v_pending_cnt, v_farmer_cnt
  FROM public.profiles;

  RAISE NOTICE '── DIAGNOSIS ─────────────────────────────────────────────';
  RAISE NOTICE 'handle_new_user() currently stamps a new signup as: %', upper(v_assigns);

  IF v_assigns = 'farmer' THEN
    RAISE WARNING 'EXPOSED: with self-signup enabled, anyone who confirms an email became an OPERATIONAL farmer.';
    RAISE NOTICE 'Existing profiles: % farmer, % pending. Review the farmer rows against your own provisioning records.',
      v_farmer_cnt, v_pending_cnt;
  ELSIF v_assigns = 'pending' THEN
    RAISE NOTICE 'CONTAINED: new signups were already non-operational. No change needed below.';
  ELSE
    RAISE WARNING 'UNRECOGNISED handle_new_user() body — it assigns neither pending nor farmer. Inspect manually.';
  END IF;
END
$diagnose$;

-- -----------------------------------------------------------------------------
-- 2. REPAIR — a brand-new auth user is provisioned NON-OPERATIONAL.
--
-- Mirrors 21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql. Re-asserting it
-- is harmless where it is already applied.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 'pending' is deliberate and load-bearing: a self-registered user must not
  -- receive an operational role. Only a ddp_admin may promote them, and the
  -- app's post-login routing fails closed for an unresolved role.
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    'pending'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 3. VERIFY — prove the repair took, and that self-promotion stays impossible.
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_src        text;
  v_self_guard boolean;
  v_admin_only boolean;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

  IF v_src !~ '''pending''' THEN
    RAISE EXCEPTION 'containment FAILED: handle_new_user() still does not assign pending';
  END IF;

  -- A non-admin must not be able to change their own role. Without this, the
  -- role stamp above is only a speed bump.
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='profiles' AND cmd='UPDATE'
      AND coalesce(with_check,'') ~ 'role'
      AND coalesce(with_check,'') ~ 'auth\.uid\(\)'
  ) INTO v_self_guard;

  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='profiles' AND cmd='UPDATE'
      AND coalesce(qual,'') ~ 'is_ddp_admin'
  ) INTO v_admin_only;

  RAISE NOTICE '── AFTER ─────────────────────────────────────────────────';
  RAISE NOTICE 'handle_new_user() now stamps: PENDING (was %)', upper(current_setting('containment.before'));

  IF v_self_guard THEN
    RAISE NOTICE 'Self-promotion guard: PRESENT (a user cannot change their own role).';
  ELSE
    RAISE WARNING 'Self-promotion guard: MISSING. A user may be able to change their own role — '
                  'apply 21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql in full and re-check.';
  END IF;

  IF v_admin_only THEN
    RAISE NOTICE 'Admin role-change policy: PRESENT.';
  ELSE
    RAISE WARNING 'Admin role-change policy: MISSING.';
  END IF;

  RAISE NOTICE '──────────────────────────────────────────────────────────';
  RAISE NOTICE 'REMAINING MANUAL STEP: Authentication -> Providers/Settings ->';
  RAISE NOTICE 'turn OFF "Allow new users to sign up". This SQL contains the blast';
  RAISE NOTICE 'radius; the toggle stops the unwanted accounts being created at all.';
END
$verify$;

COMMIT;
