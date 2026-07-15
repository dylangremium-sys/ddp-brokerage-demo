-- =============================================================================
-- 19_FARM_ADMIN_FIELD_GUARD_ROLLBACK.sql
-- =============================================================================
-- Reverses ONLY 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql: it drops the trigger
-- trg_protect_farm_admin_fields on public.farms and the function
-- public.fn_protect_farm_admin_fields(). It changes nothing else.
--
-- *** SECURITY WARNING — READ BEFORE RUNNING ***
-- ------------------------------------------------------------------------------
-- This rollback RE-OPENS the farm admin-field self-approval privilege escalation.
-- The RLS policy "farms: farmer update own" is intentionally LEFT IN PLACE (this
-- script does NOT drop it). With that policy present and this trigger removed,
-- 16_PRODUCTION_SAFETY_VERIFY.sql Q1 returns:
--     *** ESCALATION RISK — farmer UPDATE policy is LIVE and the column guard is ABSENT ***
-- i.e. any farmer can set their own farms.compliance_status / risk_level /
-- export_readiness / partner_tier / status / reviewed_by / created_by — approving
-- their own farm. Only run this if you are deliberately and temporarily reverting
-- the guard, and re-apply 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql promptly.
--
-- Why this script does NOT also drop the policy: dropping "farms: farmer update
-- own" would be the "safe" state (no farmer UPDATE path at all), but that policy
-- is owned by the farmer re-save workstream (FARM_RESAVE_PERSISTENCE_MIGRATION.sql),
-- not by this remediation. Reverting a change you did not make is out of scope and
-- would also break legitimate farmer profile re-save. Rollback is strictly the
-- inverse of the forward migration.
-- =============================================================================

begin;

-- Precondition (informational): report what is present before rollback.
do $$
begin
  raise notice 'ROLLBACK precondition: trigger present=%, function present=%',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.farms'::regclass
            and t.tgname = 'trg_protect_farm_admin_fields' and not t.tgisinternal),
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'fn_protect_farm_admin_fields');
end $$;

-- 1. Drop the trigger first (it depends on the function).
drop trigger if exists trg_protect_farm_admin_fields on public.farms;

-- 2. Drop the guard function.
drop function if exists public.fn_protect_farm_admin_fields();

-- Postcondition: both objects must be gone, and the farmer-update policy must be
-- untouched (still present). RAISE if either invariant is violated.
do $$
begin
  if exists (select 1 from pg_trigger t where t.tgrelid = 'public.farms'::regclass
             and t.tgname = 'trg_protect_farm_admin_fields' and not t.tgisinternal) then
    raise exception 'ROLLBACK FAILED: trigger trg_protect_farm_admin_fields still present';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'fn_protect_farm_admin_fields') then
    raise exception 'ROLLBACK FAILED: function fn_protect_farm_admin_fields still present';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'farms'
                 and policyname = 'farms: farmer update own') then
    raise exception 'ROLLBACK FAILED: policy "farms: farmer update own" was dropped — rollback overreached its scope';
  end if;
  raise warning 'ROLLBACK COMPLETE: farm admin-field guard REMOVED. Self-approval escalation is now RE-OPENED while "farms: farmer update own" remains live. Re-apply 19_FARM_ADMIN_FIELD_GUARD_HARDENING.sql to close it.';
end $$;

commit;
