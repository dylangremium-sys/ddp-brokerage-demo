-- FARM_RESAVE_PERSISTENCE_MIGRATION.sql
-- Phase 3E-2B — Farm Profile Re-Save Persistence Migration Proposal
--
-- PURPOSE
-- This file prepares the live database for safe farmer re-save persistence.
--
-- It is intended to fix the current re-save failure path where:
-- 1. public.farms is upserted during farmer profile save.
-- 2. The first insert can succeed.
-- 3. A later re-save attempts to update public.farms.
-- 4. Farmer UPDATE is currently blocked by RLS.
-- 5. farm_profiles and farm_memberships also need idempotent-safe support.
--
-- SAFETY RULE
-- Do not run this file automatically.
-- Review first, then apply manually in Supabase SQL Editor only after approval.
--
-- HIGH-LEVEL CHANGES
-- 1. Protect admin-owned farm fields from farmer updates.
-- 2. Allow farmers to update their own farm row without overwriting protected fields.
-- 3. Add UNIQUE(farm_id) to farm_profiles after duplicate precheck.
-- 4. Allow farmers to update their own farm_profile row.
--
-- NO APP CODE CHANGE IS INCLUDED IN THIS FILE.
-- NO db.ts CHANGE IS INCLUDED IN THIS FILE.

begin;

-- ---------------------------------------------------------------------------
-- 0. Duplicate precheck for farm_profiles(farm_id)
-- ---------------------------------------------------------------------------
-- This query should return zero rows before the unique constraint is added.
-- If it returns rows, stop and resolve duplicates before applying this migration.

-- Verification-only query:
-- select
--   farm_id,
--   count(*) as duplicate_count
-- from public.farm_profiles
-- where farm_id is not null
-- group by farm_id
-- having count(*) > 1
-- order by duplicate_count desc, farm_id;

-- ---------------------------------------------------------------------------
-- 1. Protect admin-owned fields on public.farms
-- ---------------------------------------------------------------------------
-- Farmers need UPDATE permission for their own farm rows so profile re-save can
-- persist. However, the existing farmer save payload can include stale or null
-- values for fields that should remain admin-controlled.
--
-- This trigger preserves those protected fields for non-admin users.

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
      and p.role = 'admin'
  )
  into is_admin;

  if is_admin then
    return new;
  end if;

  -- Preserve admin-owned or mixed-control fields for non-admin updates.
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

revoke all on function public.fn_protect_farm_admin_fields() from public;

drop trigger if exists trg_protect_farm_admin_fields on public.farms;

create trigger trg_protect_farm_admin_fields
before update on public.farms
for each row
execute function public.fn_protect_farm_admin_fields();

-- ---------------------------------------------------------------------------
-- 2. Allow farmer UPDATE on their own public.farms rows
-- ---------------------------------------------------------------------------
-- Membership is used as the ownership gate.

drop policy if exists "farms: farmer update own" on public.farms;

create policy "farms: farmer update own"
on public.farms
for update
to authenticated
using (
  exists (
    select 1
    from public.farm_memberships fm
    where fm.farm_id = farms.id
      and fm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.farm_memberships fm
    where fm.farm_id = farms.id
      and fm.user_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- 3. Add idempotent unique constraint for public.farm_profiles(farm_id)
-- ---------------------------------------------------------------------------
-- Required so app code can safely upsert farm_profiles on farm_id.
--
-- This block intentionally raises an exception if duplicates exist.

do $$
begin
  if exists (
    select 1
    from (
      select farm_id
      from public.farm_profiles
      where farm_id is not null
      group by farm_id
      having count(*) > 1
    ) duplicates
  ) then
    raise exception
      'Cannot add farm_profiles_farm_id_unique: duplicate farm_profiles.farm_id values exist.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.farm_profiles'::regclass
      and conname = 'farm_profiles_farm_id_unique'
  ) then
    alter table public.farm_profiles
      add constraint farm_profiles_farm_id_unique unique (farm_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Allow farmer UPDATE on their own public.farm_profiles rows
-- ---------------------------------------------------------------------------

drop policy if exists "farm_profiles: farmer update own" on public.farm_profiles;

create policy "farm_profiles: farmer update own"
on public.farm_profiles
for update
to authenticated
using (
  exists (
    select 1
    from public.farm_memberships fm
    where fm.farm_id = farm_profiles.farm_id
      and fm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.farm_memberships fm
    where fm.farm_id = farm_profiles.farm_id
      and fm.user_id = auth.uid()
  )
);

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION QUERIES
-- ---------------------------------------------------------------------------
-- Run these manually after applying the migration.

-- 1. Confirm duplicate farm_profiles were not present.
select
  farm_id,
  count(*) as duplicate_count
from public.farm_profiles
where farm_id is not null
group by farm_id
having count(*) > 1
order by duplicate_count desc, farm_id;

-- 2. Confirm protective trigger exists and is enabled.
select
  tgname,
  tgenabled
from pg_trigger
where tgrelid = 'public.farms'::regclass
  and tgname = 'trg_protect_farm_admin_fields';

-- 3. Confirm protective function exists.
select
  n.nspname as schema_name,
  p.proname as function_name,
  p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'fn_protect_farm_admin_fields';

-- 4. Confirm policies exist.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and (
    (tablename = 'farms' and policyname = 'farms: farmer update own')
    or
    (tablename = 'farm_profiles' and policyname = 'farm_profiles: farmer update own')
  )
order by tablename, policyname;

-- 5. Confirm farm_profiles unique constraint exists.
select
  conname,
  contype
from pg_constraint
where conrelid = 'public.farm_profiles'::regclass
  and conname = 'farm_profiles_farm_id_unique';

-- ---------------------------------------------------------------------------
-- ROLLBACK SQL
-- ---------------------------------------------------------------------------
-- Do not run unless rollback is required.
--
-- begin;
--
-- drop policy if exists "farm_profiles: farmer update own" on public.farm_profiles;
-- alter table public.farm_profiles
--   drop constraint if exists farm_profiles_farm_id_unique;
--
-- drop policy if exists "farms: farmer update own" on public.farms;
-- drop trigger if exists trg_protect_farm_admin_fields on public.farms;
-- drop function if exists public.fn_protect_farm_admin_fields();
--
-- commit;
