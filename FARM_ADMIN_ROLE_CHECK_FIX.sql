-- =============================================================================
-- FARM_ADMIN_ROLE_CHECK_FIX.sql
-- =============================================================================
--
-- STATUS: DRAFT — FOR REVIEW ONLY. NOT APPLIED. NOT RUN. NOT DEPLOYED.
--
-- Purpose
-- -------
-- Fixes a logic bug in public.fn_protect_farm_admin_fields(), introduced in
-- FARM_RESAVE_PERSISTENCE_MIGRATION.sql (commit 26fe051, applied manually to
-- production per PHASE_3E_2_FARM_RESAVE_PERSISTENCE_VALIDATION.md).
--
-- The bug
-- --------
-- The function's admin check reads:
--
--     select exists (
--       select 1
--       from public.profiles p
--       where p.id = auth.uid()
--         and p.role = 'admin'          -- <-- wrong literal
--     )
--     into is_admin;
--
-- public.profiles.role has a hard CHECK constraint (AUTH_RLS_SCHEMA.sql:21):
--
--     CHECK (role IN ('ddp_admin', 'farmer'))
--
-- The literal 'admin' is not a value this column can ever hold. Every other
-- admin-gating function in this codebase checks role = 'ddp_admin'
-- (see is_ddp_admin() in AUTH_RLS_SCHEMA.sql and the search-path-hardened
-- copy in 3_SECURITY_HARDENING_SEARCH_PATH_AND_GRANTS.sql). This function is
-- the only one using the literal 'admin', so is_admin below is always false
-- for every user, including real ddp_admin accounts.
--
-- Effect of the bug
-- -----------------
-- Because is_admin can never be true, the trigger always falls through to
-- the "preserve" branch and silently reassigns
-- status / partner_tier / compliance_status / export_readiness / risk_level /
-- reviewed_by / created_by back to their OLD values on every UPDATE to
-- public.farms — including legitimate admin approve/reject/status-change
-- actions performed through the app. The UPDATE does not error; the fields
-- just silently fail to persist.
--
-- Why this is a one-line logic correction
-- ----------------------------------------
-- The only change below is the string literal compared against p.role:
-- 'admin' -> 'ddp_admin'. Nothing else about the function's structure,
-- security context, search_path, or preserved-field list changes. The
-- trigger (trg_protect_farm_admin_fields) already points to this function
-- by name and does not need to be dropped or recreated — CREATE OR REPLACE
-- FUNCTION swaps the function body in place while the existing trigger
-- binding remains valid.
--
-- Scope of this file
-- -------------------
-- - CREATE OR REPLACE FUNCTION only. No DROP FUNCTION, no DROP TRIGGER,
--   no CREATE TRIGGER, no RLS policy changes, no data changes.
-- - Preserves: security definer, search_path, the preserved-field list, and
--   the "return new" early-exit for real admins — identical to the original
--   except for the one corrected literal.
--
-- Apply/rollback (documented here for reviewer convenience only —
-- this file must not be run as part of drafting it):
--   Apply:    run the CREATE OR REPLACE FUNCTION block below in the
--             Supabase SQL Editor against the target project.
--   Rollback: re-run the original (buggy) definition from
--             FARM_RESAVE_PERSISTENCE_MIGRATION.sql if this fix ever needs
--             to be reverted (not expected to be necessary, since the
--             original behavior was itself the bug).
--
-- =============================================================================

create or replace function public.fn_protect_farm_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_admin boolean := false;
begin
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'ddp_admin'   -- fixed: was 'admin' (never matched profiles.role's allowed values)
  )
  into is_admin;

  if is_admin then
    return new;
  end if;

  -- Preserve admin-owned or mixed-control fields for non-admin updates.
  -- Unchanged from the original migration.
  new.status := old.status;
  new.partner_tier := old.partner_tier;
  new.compliance_status := old.compliance_status;
  new.export_readiness := old.export_readiness;
  new.risk_level := old.risk_level;
  new.reviewed_by := old.reviewed_by;
  new.created_by := old.created_by;

  return new;
end;
$$;

-- No trigger changes needed: trg_protect_farm_admin_fields (created in
-- FARM_RESAVE_PERSISTENCE_MIGRATION.sql) already executes
-- public.fn_protect_farm_admin_fields() before update on public.farms.
-- CREATE OR REPLACE FUNCTION above updates the body the existing trigger
-- calls, without dropping or recreating the trigger itself.

-- =============================================================================
-- Verification queries (commented out — for manual, read-only use only
-- after this fix is reviewed and deliberately applied; do not uncomment
-- or run as part of this draft)
-- =============================================================================

-- -- V1: confirm the deployed function body now checks 'ddp_admin', not 'admin'
-- select prosrc from pg_proc where proname = 'fn_protect_farm_admin_fields';

-- -- V2: confirm the trigger is still attached and enabled (should be unaffected
-- -- by this change, since only the function body was replaced)
-- select tgname, tgenabled
-- from pg_trigger
-- where tgname = 'trg_protect_farm_admin_fields';

-- -- V3: confirm the function is still security definer (unchanged)
-- select proname, prosecdef
-- from pg_proc
-- where proname = 'fn_protect_farm_admin_fields';

-- -- V4: behavioral check, safe to run because it is wrapped in a transaction
-- -- that is rolled back — no data is permanently changed. Run as an
-- -- authenticated ddp_admin session against a real (non-critical) farms row.
-- -- begin;
-- --   update public.farms set status = 'Approved' where id = '<some farm id>';
-- --   select status from public.farms where id = '<same farm id>';
-- --   -- expected after fix: shows 'Approved' (the new value), not the prior value
-- -- rollback;
