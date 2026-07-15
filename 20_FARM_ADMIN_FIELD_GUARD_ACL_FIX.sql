-- =============================================================================
-- 20_FARM_ADMIN_FIELD_GUARD_ACL_FIX.sql
-- =============================================================================
-- Corrective ACL migration for the farm admin-field guard function.
--
-- WHY
-- ---
-- Supabase's default privileges (ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
-- EXECUTE ON FUNCTIONS TO authenticated, anon, service_role) grant EXECUTE on every
-- NEW public function DIRECTLY to `authenticated` (and `anon`), not only via PUBLIC.
-- 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql revoked EXECUTE only from `public` and
-- `anon`, so `authenticated` retained a direct EXECUTE grant on this trigger-only
-- guard function. 19_..._VERIFY.sql Section A caught this on the Production apply
-- ("authenticated must NOT hold EXECUTE on the guard function"), and a manual
-- `REVOKE EXECUTE ... FROM authenticated` was applied to Production.
--
-- This migration makes that correction durable so FRESH environments converge to
-- the same least-privilege ACL state without a manual step. It matches the pattern
-- already used by the other trigger-only no-grant function
-- (17_PROCUREMENT_DECISIONS_MVP.sql:165-167 revokes PUBLIC, anon, AND authenticated).
--
-- Migration 19 is intentionally LEFT UNCHANGED as historical truth — it has already
-- been applied to Production; this corrective migration is applied on top of it.
--
-- SCOPE (deliberately minimal)
-- ----------------------------
-- Changes ONLY the EXECUTE ACL of public.fn_protect_farm_admin_fields(). It does
-- NOT touch trigger logic, protected columns, RLS policies, verification behaviour,
-- rollback, or any application code. Idempotent (REVOKE is idempotent; re-revoking
-- public/anon is a no-op). Trigger-only function granted EXECUTE to NO client role:
--   acl-no-grant: fn_protect_farm_admin_fields
--
-- VERIFICATION: no new VERIFY file is needed — 19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql
-- Section A already asserts `authenticated` (and anon) cannot EXECUTE the guard, so
-- it validates the combined 19 + 20 end state. Q1 of 16_PRODUCTION_SAFETY_VERIFY.sql
-- is unaffected (it concerns the trigger/policy, not this ACL).
-- =============================================================================

begin;

revoke execute on function public.fn_protect_farm_admin_fields() from public, anon, authenticated;

commit;
