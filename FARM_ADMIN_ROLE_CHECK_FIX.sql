-- =============================================================================
-- FARM_ADMIN_ROLE_CHECK_FIX.sql
-- =============================================================================
--
-- STATUS: DRAFT — FOR REVIEW ONLY. NOT APPLIED. NOT RUN. NOT DEPLOYED.
--
-- Live verification result (read-only inspection, no data modified)
-- -------------------------------------------------------------------
-- A read-only production check was run:
--
--     select prosrc from pg_proc where proname = 'fn_protect_farm_admin_fields';
--
-- and separately, a check for non-internal triggers on public.farms.
-- Both currently return 0 rows in production. In other words:
-- fn_protect_farm_admin_fields() and trg_protect_farm_admin_fields do NOT
-- currently exist in the live database, despite
-- PHASE_3E_2_FARM_RESAVE_PERSISTENCE_VALIDATION.md recording that the V2
-- (trigger exists) and V3 (function exists) checks passed after a manual
-- application of FARM_RESAVE_PERSISTENCE_MIGRATION.sql. That prior
-- validation record and the current live state disagree; this file does
-- not attempt to resolve that discrepancy, only to note it, since
-- resolving it is a separate documentation/process question, not a SQL one.
--
-- Consequence for this file: because neither the buggy function nor its
-- trigger is currently live, applying this file today would not be
-- correcting an active production defect — there is nothing live to
-- correct yet. This file is therefore a DEFENSIVE, REPO-LEVEL FIX / FUTURE
-- MIGRATION CORRECTION: if/when FARM_RESAVE_PERSISTENCE_MIGRATION.sql (or
-- an equivalent) is ever (re-)applied to a live database, it should be
-- applied with the corrected role literal already in place — i.e. this
-- file's corrected function body should replace the original migration's
-- version at apply time — rather than applying the known-buggy version
-- first and patching it afterward. It is not an active live production
-- hotfix and does not need to be run against the current database, because
-- the object it targets is not currently present there.
--
-- Purpose
-- -------
-- Fixes a logic bug in public.fn_protect_farm_admin_fields(), as originally
-- written in FARM_RESAVE_PERSISTENCE_MIGRATION.sql (commit 26fe051). That
-- migration's own validation record (PHASE_3E_2_FARM_RESAVE_PERSISTENCE_VALIDATION.md)
-- states it was applied manually to production, but the live check above
-- did not find the function or trigger it describes — see "Live
-- verification result" above.
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
--   Apply:    NOT an active hotfix — per the live verification result
--             above, the function/trigger this file corrects do not
--             currently exist in production. This block should only be
--             run at the point FARM_RESAVE_PERSISTENCE_MIGRATION.sql (or
--             an equivalent) is (re-)applied, using this corrected body
--             instead of the original migration's 'admin' literal, in the
--             Supabase SQL Editor against the target project.
--   Rollback: if this corrected function is ever applied and later needs
--             to be reverted, re-run the original (buggy) definition from
--             FARM_RESAVE_PERSISTENCE_MIGRATION.sql (not expected to be
--             necessary, since the original behavior was itself the bug).
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
--
-- Live status as of the read-only check documented above: V1 and V2 both
-- currently return 0 rows in production (function and trigger absent).
-- That is expected until FARM_RESAVE_PERSISTENCE_MIGRATION.sql (or an
-- equivalent, corrected per this file) is actually applied. If V1/V2 ever
-- return 0 rows again after a deliberate apply was believed to have
-- happened, that itself would indicate the apply did not take effect and
-- should be investigated before assuming this fix is live.
-- =============================================================================

-- -- V1: confirm the deployed function body checks 'ddp_admin', not 'admin'
-- -- (currently 0 rows in production — function does not exist yet)
-- select prosrc from pg_proc where proname = 'fn_protect_farm_admin_fields';

-- -- V2: confirm the trigger is attached and enabled
-- -- (currently 0 non-internal rows on public.farms — trigger does not exist yet)
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
