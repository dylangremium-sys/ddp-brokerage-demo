-- 21_DDP_CONTROLLED_FARMER_PROVISIONING_HARDENING.sql
-- =============================================================================
-- DDP-only farmer provisioning — enforce below the UI.
--
-- Problem (Codex P1): removing the in-app signup UI does not stop farmer
-- self-provisioning. Any anon caller can hit Supabase Auth's public signup
-- endpoint directly, and the on_auth_user_created trigger (handle_new_user)
-- previously stamped every brand-new auth user with an OPERATIONAL role
-- ('farmer'). So a direct POST /auth/v1/signup minted a working farmer.
--
-- Fix (defense in depth, all reversible):
--   1. A brand-new auth user is provisioned as a NON-operational 'pending'
--      profile, never 'farmer'. resolvePostLoginDecision() fails closed for
--      'pending', so a self-signed-up user cannot reach any dashboard.
--   2. Only a ddp_admin may change a profile's role (RLS re-asserted below),
--      so a 'pending' user cannot self-promote to 'farmer'.
--
-- This migration is idempotent and transactional. It does NOT alter any
-- existing profile row's role, so current farmers and admins are untouched.
--
-- Companion Supabase Auth setting (NOT expressible in SQL — apply in the
-- dashboard): Authentication -> Providers/Settings -> disable "Allow new users
-- to sign up". The service_role admin API bypasses that toggle, so DDP
-- provisioning still works. Verified by the staging auth probe.
--
-- Precondition: public.is_ddp_admin() and public.handle_new_user() already
-- exist (3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql, AUTH_RLS_SCHEMA.sql).
-- Verify:   21_DDP_CONTROLLED_FARMER_PROVISIONING_VERIFY.sql
-- Rollback: 21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql
-- =============================================================================

BEGIN;

-- 1. profiles.role — add the non-operational 'pending' state and make it the
--    default. Existing rows keep their current role (both 'farmer' and
--    'ddp_admin' still satisfy the widened CHECK), so no user is changed.
ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'pending';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('ddp_admin', 'farmer', 'pending'));

-- 2. handle_new_user() — a brand-new auth user becomes 'pending', not 'farmer'.
--    Everything else matches the hardened definition in migration 3
--    (SECURITY DEFINER, pinned search_path with pg_temp last, ON CONFLICT skip).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
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

-- Trigger-only function: never called directly by client roles (migration 12).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- 3. Only a ddp_admin may change a role. Without RLS a 'pending' user could
--    UPDATE their own profiles row to role='farmer' via the anon/authenticated
--    API, defeating layer 1. These policies mirror RLS_ENABLE_STAGED.sql and are
--    re-asserted idempotently so enforcement is self-contained in this migration.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: select own or admin" ON public.profiles;
CREATE POLICY "profiles: select own or admin"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR public.is_ddp_admin());

-- A user may edit their own profile but NOT change their own role.
DROP POLICY IF EXISTS "profiles: update own no role change" ON public.profiles;
CREATE POLICY "profiles: update own no role change"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

-- Only a ddp_admin may change any user's role (the provisioning path).
DROP POLICY IF EXISTS "profiles: admin update role" ON public.profiles;
CREATE POLICY "profiles: admin update role"
  ON public.profiles FOR UPDATE
  USING (public.is_ddp_admin());

COMMIT;
