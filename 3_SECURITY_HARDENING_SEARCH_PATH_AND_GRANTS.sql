-- ============================================================================
-- SECURITY HARDENING MIGRATION
-- File: 3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql
-- Date: 2026-06-30
--
-- Addresses Supabase Security Advisor findings:
--   ERROR  — Function Search Path Mutable on 4 functions
--   WARNING — Public Can Execute SECURITY DEFINER on 5 functions
--
-- What this file does NOT do:
--   • Does not change any RLS policy
--   • Does not change any trigger definition or wiring
--   • Does not change any table, column, or index
--   • Does not touch auth config, secrets, or environment settings
--   • Does not drop or rename anything
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. handle_new_user()
--
-- Purpose: BEFORE INSERT trigger on auth.users → creates a public.profiles row.
-- Fix 1 (search_path): The original already set search_path = public, but
--   omitted pg_temp.  Without an explicit pg_temp placement, a malicious
--   session-level temp object could shadow a public schema name while the
--   SECURITY DEFINER function runs.  Adding pg_temp at the END pins its
--   position so it cannot shadow public objects.
-- Fix 2 (grants): Trigger functions are invoked by the trigger mechanism,
--   never by direct EXECUTE calls.  PostgreSQL's default GRANT EXECUTE TO
--   PUBLIC is unnecessary and widens attack surface for privilege escalation
--   via crafted EXECUTE calls.
-- ============================================================================

-- REPLAY DOWNGRADE GUARD (DDP audit A2). This file predates migration 21, which
-- changed handle_new_user() to mint the NON-OPERATIONAL 'pending' role so an
-- anonymous signup can no longer self-provision a working 'farmer' account.
-- Re-running this file AFTER migration 21 would CREATE OR REPLACE that hardened
-- definition back to the 'farmer' default and SILENTLY re-open that exposure —
-- the ordering rests only on filename numbering, with nothing recording applied
-- state. Fresh installs are unaffected (the hardened version is not yet present);
-- only an out-of-order replay is refused, and it is refused BEFORE anything is
-- changed.
DO $handle_new_user_downgrade_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'handle_new_user'
      AND p.prosrc LIKE '%''pending''%'
  ) THEN
    RAISE EXCEPTION
      'refused: the hardened handle_new_user() from migration 21 (mints ''pending'') is '
      'installed. Re-running this file would revert it to the ''farmer'' default and re-open '
      'anonymous self-provisioning. Roll back migration 21 deliberately first if that is '
      'genuinely intended.';
  END IF;
END
$handle_new_user_downgrade_guard$;

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

-- Remove the default PostgreSQL grant that makes every function callable by PUBLIC.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
-- Belt-and-suspenders: explicitly revoke from API-facing roles.
-- Trigger functions are never legitimately called by client sessions.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;


-- ============================================================================
-- 2. is_ddp_admin()
--
-- Purpose: STABLE SECURITY DEFINER helper called inside RLS policies to test
--   whether the current user's profile row carries role = 'ddp_admin'.
-- Fix 1 (search_path): No search_path was set at all.  Both public (profiles
--   table) and auth (auth.uid() function) must be reachable.  pg_temp is
--   appended last so temp-schema objects cannot shadow either schema.
-- Fix 2 (grants): anon users are never ddp_admin; remove default PUBLIC
--   grant.  authenticated and service_role must retain EXECUTE because
--   PostgreSQL evaluates RLS policies in the session user's privilege context,
--   so the calling role must have EXECUTE on any function used in a policy.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_ddp_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'ddp_admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_ddp_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_ddp_admin() FROM anon;

-- Required: RLS policies on multiple tables call is_ddp_admin(); PostgreSQL
-- checks EXECUTE privilege against the session role when evaluating policies.
GRANT EXECUTE ON FUNCTION public.is_ddp_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_ddp_admin() TO service_role;


-- ============================================================================
-- 3. has_farm_membership(p_farm_id UUID)
--
-- Purpose: STABLE SECURITY DEFINER helper called inside RLS policies to test
--   whether the current user holds a membership row for the given farm.
-- Fix 1 (search_path): Same reasoning as is_ddp_admin() — both public and
--   auth schemas are needed; pg_temp pinned last.
-- Fix 2 (grants): anon users have no memberships; remove default PUBLIC grant.
--   authenticated and service_role retain EXECUTE for the same RLS reason.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.has_farm_membership(p_farm_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farm_memberships
    WHERE farm_id = p_farm_id AND user_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_farm_membership(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_farm_membership(UUID) FROM anon;

-- Required: RLS policies on inventory_batches, farmer_review_requests, and
-- storage objects call has_farm_membership(); session role needs EXECUTE.
GRANT EXECUTE ON FUNCTION public.has_farm_membership(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_farm_membership(UUID) TO service_role;


-- ============================================================================
-- 4. fn_protect_owner_notes()
--
-- Purpose: BEFORE UPDATE trigger on public.inventory_batches — silently
--   pins the owner_notes column to its pre-update value for non-admin callers.
--   Calls is_ddp_admin() to detect admins.
-- Fix 1 (search_path): No search_path was set.  public is needed for
--   is_ddp_admin() lookup; auth for auth.uid() inside that helper; pg_temp
--   pinned last to prevent shadowing.
-- Fix 2 (grants): Trigger-only function; same reasoning as handle_new_user().
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_protect_owner_notes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  -- DDP admins may set owner_notes to any value.
  IF is_ddp_admin() THEN
    RETURN NEW;
  END IF;

  -- For all other callers (farmers, service accounts without admin role):
  -- silently restore the pre-update value.
  -- The UPDATE is not rejected — only owner_notes is pinned to OLD.
  NEW.owner_notes := OLD.owner_notes;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM authenticated;


-- ============================================================================
-- 5. fn_protect_review_request_fields()
--
-- Purpose: BEFORE UPDATE trigger on public.farmer_review_requests — pins
--   immutable fields (message, request_type, created_by, …) for non-admin
--   callers and prevents re-opening resolved requests.  Calls is_ddp_admin().
-- Fix 1 (search_path): Same reasoning as fn_protect_owner_notes().
-- Fix 2 (grants): Trigger-only function; same reasoning as handle_new_user().
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_protect_review_request_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  -- DDP admins may modify any field (e.g. to correct a typo in the message).
  IF is_ddp_admin() THEN
    RETURN NEW;
  END IF;

  -- Prevent re-opening a resolved request.
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION
      'farmer_review_requests: cannot modify a request that is already resolved.';
  END IF;

  -- Pin all immutable fields to their current values regardless of payload.
  NEW.message            := OLD.message;
  NEW.request_type       := OLD.request_type;
  NEW.created_by         := OLD.created_by;
  NEW.inventory_batch_id := OLD.inventory_batch_id;
  NEW.farm_id            := OLD.farm_id;
  NEW.product_name       := OLD.product_name;
  NEW.farm_name          := OLD.farm_name;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM anon;


-- ============================================================================
-- VERIFICATION QUERIES
-- Run these after applying to confirm the changes took effect.
-- ============================================================================

-- 1. Confirm search_path is set on all 5 functions:
-- SELECT proname, proconfig
-- FROM pg_proc
-- JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
-- WHERE pg_namespace.nspname = 'public'
--   AND proname IN (
--     'handle_new_user', 'is_ddp_admin', 'has_farm_membership',
--     'fn_protect_owner_notes', 'fn_protect_review_request_fields'
--   );
-- Expected: proconfig contains "search_path=public,auth,pg_temp" for all rows.

-- 2. Confirm no PUBLIC/anon EXECUTE remains on trigger functions:
-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name IN (
--     'handle_new_user', 'fn_protect_owner_notes',
--     'fn_protect_review_request_fields'
--   )
-- ORDER BY routine_name, grantee;
-- Expected: only postgres / supabase_admin rows (no PUBLIC, anon, authenticated).

-- 3. Confirm is_ddp_admin and has_farm_membership retain authenticated grant:
-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('is_ddp_admin', 'has_farm_membership')
-- ORDER BY routine_name, grantee;
-- Expected: authenticated and service_role present; PUBLIC and anon absent.

-- 4. Confirm triggers are still wired:
-- SELECT tgname, tgrelid::regclass AS table_name, tgenabled
-- FROM pg_trigger
-- WHERE tgname IN (
--   'on_auth_user_created',
--   'trg_protect_owner_notes',
--   'trg_protect_review_request_fields'
-- );
-- Expected: 3 rows, all tgenabled = 'O' (origin / enabled).

COMMIT;
