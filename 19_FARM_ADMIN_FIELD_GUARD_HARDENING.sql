-- =============================================================================
-- 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql
-- =============================================================================
-- Farm admin-field self-approval guard — column-level protection for public.farms
--
-- WHAT THIS CLOSES
-- ----------------
-- The RLS policy "farms: farmer update own" (FARM_RESAVE_PERSISTENCE_MIGRATION.sql)
-- lets a farmer UPDATE their own farm ROW. RLS gates rows, never columns, so the
-- ONLY thing that can stop a farmer from writing admin-controlled columns
-- (compliance_status, risk_level, export_readiness, partner_tier, status,
-- reviewed_by, created_by) is a BEFORE UPDATE trigger. 16_PRODUCTION_SAFETY_VERIFY.sql
-- Q1 states the exact rule:
--   policy present AND trigger PRESENT -> SAFE
--   policy present AND trigger ABSENT  -> *** LIVE PRIVILEGE ESCALATION ***
--                                         (a farmer can approve their own farm)
--
-- This migration installs that guard so a farmer may edit descriptive/contact
-- fields but can never self-certify their own compliance, risk, review, status,
-- tier, or provenance.
--
-- WHY A NEW MIGRATION (not the earlier drafts)
-- --------------------------------------------
-- * FARM_RESAVE_PERSISTENCE_MIGRATION.sql shipped a guard with the wrong admin
--   literal: `p.role = 'admin'`. public.profiles.role has a hard CHECK constraint
--   (AUTH_RLS_SCHEMA.sql:21): CHECK (role IN ('ddp_admin', 'farmer')). 'admin' is
--   not a permitted value, so its admin test is ALWAYS false — the guard would
--   preserve fields even for real ddp_admins (silently dropping legitimate admin
--   writes), and it is marked INTENTIONAL-DRAFT / unapplied.
-- * FARM_ADMIN_ROLE_CHECK_FIX.sql corrects only the literal via CREATE OR REPLACE
--   FUNCTION and assumes the trigger already exists — which, per its own read-only
--   production check, it does NOT (function and trigger return 0 rows in prod).
--
-- This file supersedes both with a single, self-contained, idempotent install of
-- BOTH the function AND the trigger, and it carries NO role literal at all: the
-- admin decision is delegated to the canonical predicate public.is_ddp_admin(),
-- so the 'admin' vs 'ddp_admin' bug class cannot recur here.
--
-- CANONICAL ADMIN SEMANTICS
-- -------------------------
-- public.is_ddp_admin() (AUTH_RLS_SCHEMA.sql; search-path-hardened in
-- 3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql) is the admin predicate every
-- RLS policy in this schema already uses. It is SECURITY DEFINER and reads
-- auth.uid() against public.profiles, so it evaluates the CALLING user correctly
-- even when called from inside another SECURITY DEFINER function.
--
-- SECURITY CONTEXT (rationale)
-- ----------------------------
-- * SECURITY DEFINER: chosen for parity with the repository's canonical guard
--   functions (is_ddp_admin, has_farm_membership) and so the guard's behaviour is
--   independent of the caller's direct table/function grants. (An INVOKER variant
--   would also work today because `authenticated` holds EXECUTE on is_ddp_admin(),
--   but DEFINER is the more resilient, convention-matching choice.)
-- * set search_path = public, pg_temp: fixed search path (Supabase lint
--   0011_function_search_path_mutable). The function references only
--   public.is_ddp_admin(), fully schema-qualified, so resolution never depends on
--   the caller's path.
-- * Least privilege: a trigger function fires WITHOUT the updating role holding
--   EXECUTE on it, so no EXECUTE grant is issued. The default PUBLIC grant (and
--   anon) are revoked to block direct invocation of a SECURITY DEFINER function.
--
-- PROTECTED COLUMNS (enumerated from schema, not from an earlier summary)
-- ----------------------------------------------------------------------
--   from farms base table (SUPABASE_SCHEMA.sql:20-25):
--     status, compliance_status, export_readiness, risk_level, partner_tier
--   added to farms by ALTER (AUTH_RLS_SCHEMA.sql:38-39):
--     created_by, reviewed_by
--
-- SCOPE (deliberately narrow)
-- ---------------------------
-- Touches ONLY public.fn_protect_farm_admin_fields() and the trigger
-- trg_protect_farm_admin_fields on public.farms. It does NOT alter, weaken, or
-- recreate the "farms: farmer update own" RLS policy, and it does NOT touch
-- farm_profiles, profiles, RLS on any table, or any other object. (The separate
-- profiles.role self-elevation concern noted in 16_PRODUCTION_SAFETY_VERIFY.sql is
-- out of scope for this migration.)
--
-- APPLICATION
-- -----------
-- Review, then apply manually in the Supabase SQL Editor against the target
-- project. See docs/FARM_ADMIN_FIELD_GUARD_APPLICATION.md. Companion files:
--   19_FARM_ADMIN_FIELD_GUARD_VERIFY.sql    (object-state + behavioural proof)
--   19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql  (reverses ONLY this migration)
-- Idempotent: safe to re-run; converges to the same object state.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Guard function — preserves admin-controlled columns for non-admin updates
-- ---------------------------------------------------------------------------
create or replace function public.fn_protect_farm_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Real DDP admins may change anything; delegate to the canonical predicate so
  -- this function carries no role literal of its own.
  if public.is_ddp_admin() then
    return new;
  end if;

  -- Non-admin (farmer) UPDATE: force every admin-controlled column back to its
  -- stored value. Descriptive/contact columns (farm_name, legal_business_name,
  -- trading_name, province, district, gps_coordinates, primary_contact,
  -- mobile_number, email, completion_percentage) are intentionally left in NEW so
  -- farmer profile re-save still persists.
  new.status            := old.status;
  new.compliance_status := old.compliance_status;
  new.export_readiness  := old.export_readiness;
  new.risk_level        := old.risk_level;
  new.partner_tier      := old.partner_tier;
  new.reviewed_by       := old.reviewed_by;
  new.created_by        := old.created_by;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Least-privilege ACL — block direct invocation; trigger firing is unaffected
-- ---------------------------------------------------------------------------
-- This is a trigger-only function: it fires from the BEFORE UPDATE trigger below
-- and is granted EXECUTE to NO client role (a trigger does not require the
-- updating role to hold EXECUTE). Revoke the default PUBLIC grant (and anon) so it
-- can never be invoked directly. Per the repository ACL convention
-- (docs/SECURITY_TEST_LOG.md §13/§14; src/lib/publicFunctionExecuteAcl.test.ts)
-- the deliberate no-grant decision is declared with an explicit token:
--   acl-no-grant: fn_protect_farm_admin_fields
revoke execute on function public.fn_protect_farm_admin_fields() from public, anon;

-- ---------------------------------------------------------------------------
-- 3. Trigger — install if absent, safely replace if a prior binding exists
-- ---------------------------------------------------------------------------
drop trigger if exists trg_protect_farm_admin_fields on public.farms;

create trigger trg_protect_farm_admin_fields
before update on public.farms
for each row
execute function public.fn_protect_farm_admin_fields();

commit;
