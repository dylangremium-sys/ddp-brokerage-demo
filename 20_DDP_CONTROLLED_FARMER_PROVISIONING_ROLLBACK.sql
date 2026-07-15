-- 20_DDP_CONTROLLED_FARMER_PROVISIONING_ROLLBACK.sql
-- =============================================================================
-- Reverse migration 20. Restores the prior auto-farmer behaviour of
-- handle_new_user() and the two-value role CHECK / 'farmer' default.
--
-- WARNING: this REINTRODUCES the Codex P1 self-provisioning exposure. Also
-- re-enable "Allow new users to sign up" in the Supabase dashboard if it was
-- disabled as part of migration 20's companion configuration.
--
-- PRECONDITION: no profile rows may have role = 'pending' when this runs — the
-- narrowed CHECK cannot be re-applied while 'pending' rows exist. Promote or
-- remove any pending accounts first (e.g. via the DDP provisioning path or by
-- deleting the corresponding auth.users rows).
--
-- The RLS policies re-asserted by migration 20 are the intended production
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
