-- 21_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql
-- =============================================================================
-- Reverse migration 21. Restores the prior auto-farmer behaviour of
-- handle_new_user() and the two-value role CHECK / 'farmer' default.
--
-- WARNING: this REINTRODUCES the Codex P1 self-provisioning exposure. Also
-- re-enable "Allow new users to sign up" in the Supabase dashboard if it was
-- disabled as part of migration 21's companion configuration.
--
-- ORDERING REQUIREMENT: roll back migration 22 BEFORE this file.
-- Migration 22's restrictive overlay authorizes via has_operational_farmer_access(),
-- which tests `profiles.role = 'farmer'`. Restoring the 'farmer' default below
-- means a self-signed-up account is created AS a farmer, so the helper returns
-- true for it and EVERY restrictive policy passes. Running this file while 22 is
-- still applied therefore does not merely reopen migration 21's gap — it silently
-- reduces migration 22's entire overlay to a no-op while leaving the policies in
-- the catalog, where they still look applied and still pass 22's VERIFY sections
-- C/D/D2. Only 22's VERIFY section G (behavioural enforcement) would catch it.
--
-- PRECONDITION: no profile rows may have role = 'pending' when this runs — the
-- narrowed CHECK cannot be re-applied while 'pending' rows exist. Promote or
-- remove any pending accounts first (e.g. via the DDP provisioning path or by
-- deleting the corresponding auth.users rows).
--
-- The RLS policies re-asserted by migration 21 are the intended production
-- state (from RLS_ENABLE_STAGED.sql) and are deliberately LEFT IN PLACE.
-- =============================================================================

BEGIN;

-- 1. Restore handle_new_user() to auto-assign the operational 'farmer' role.
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
    'farmer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- 2. Restore the prior default and the two-value CHECK.
ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'farmer';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('ddp_admin', 'farmer'));

COMMIT;
