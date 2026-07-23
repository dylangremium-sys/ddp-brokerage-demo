-- =============================================================================
-- RLS_ROLLBACK.sql
-- Emergency rollback for Row Level Security on DDP Brokerage tables.
--
-- HOW TO USE:
--   Run the relevant block in Supabase → SQL Editor if the app goes blank,
--   throws Supabase errors, or loses data visibility after an RLS stage.
--
-- ⚠ THIS IS NOT A SAFE OPERATION. It is DATA-preserving, not SECURITY-preserving.
--
--   These commands do not delete rows, drop tables, alter columns, or change
--   auth.users — but disabling Row Level Security REMOVES ALL TENANT ISOLATION.
--   Every farmer can then read and write EVERY other farm's rows: profiles,
--   farms, inventory, documents, scores and risk flags. `rowsecurity = false` is
--   the single most severe state this database can be in. Treat this file as
--   break-glass only, re-enable RLS immediately afterwards, and treat any period
--   it was disabled as a potential data-exposure incident.
--
-- Re-enable by re-running the relevant stage from RLS_ENABLE_STAGED.sql.
-- =============================================================================


-- =============================================================================
-- FULL ROLLBACK — disables RLS on all tables at once
-- Use when the app is completely broken and you need immediate recovery.
--
-- FAIL-CLOSED OPT-IN: this block strips tenant isolation from all nine core
-- tables, so it refuses to run unless the operator states that intent explicitly
-- IN THE SAME SESSION:
--
--     SET rls.disable_tenant_isolation = 'true';
--
-- That makes a reflexive copy-paste during an outage impossible: the destructive
-- step cannot happen by accident, only by decision. It is also wrapped in a
-- transaction so a partial strip cannot be left behind.
-- =============================================================================

BEGIN;

DO $tenant_isolation_guard$
DECLARE
  v_opt_in text;
BEGIN
  BEGIN
    v_opt_in := current_setting('rls.disable_tenant_isolation');
  EXCEPTION WHEN undefined_object THEN
    v_opt_in := NULL;
  END;

  IF v_opt_in IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'RLS full rollback refused: this disables Row Level Security on all nine core '
      'tables, removing ALL tenant isolation (every farmer could read and write every '
      'other farm''s data). If that is genuinely intended, run '
      'SET rls.disable_tenant_isolation = ''true''; in this session first, and re-enable '
      'RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$tenant_isolation_guard$;

ALTER TABLE public.profiles           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farms              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_profiles      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_memberships   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ddp_scores         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_flags         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_history     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents          DISABLE ROW LEVEL SECURITY;

COMMIT;

-- Confirm all tables are now unrestricted:
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;


-- =============================================================================
-- TARGETED ROLLBACKS — use these to roll back a single stage without
-- touching other tables that are already working correctly.
-- =============================================================================

-- ── profiles (Stages 1–2) ─────────────────────────────────────────────────────
-- Symptom: App stuck on auth-loading spinner; farmer/admin role badge never appears.
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.profiles removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles: select own or admin"      ON public.profiles;
DROP POLICY IF EXISTS "profiles: update own no role change" ON public.profiles;
DROP POLICY IF EXISTS "profiles: admin update role"        ON public.profiles;

-- ── farms (Stages 3–4) ────────────────────────────────────────────────────────
-- Symptom: Farm Profiles page empty for admin; My Submissions empty for farmer
--          who did have farms.
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.farms removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.farms DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farms: admin all"          ON public.farms;
DROP POLICY IF EXISTS "farms: farmer select own"  ON public.farms;
DROP POLICY IF EXISTS "farms: farmer insert own"  ON public.farms;

-- ── farm_profiles (Stages 5–6) ────────────────────────────────────────────────
-- Symptom: Farm registration fails with Supabase error banner; DDP Farm Review
--          shows empty profile sections for admin.
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.farm_profiles removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.farm_profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_profiles: admin all"         ON public.farm_profiles;
DROP POLICY IF EXISTS "farm_profiles: farmer select own" ON public.farm_profiles;
DROP POLICY IF EXISTS "farm_profiles: farmer insert own" ON public.farm_profiles;

-- ── farm_memberships (Stages 7–8) ─────────────────────────────────────────────
-- Symptom: Farm registration fails at the membership insert step
--          (error visible in browser console as "policy violation").
--          Farmer scope loads empty even after registering a farm.
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.farm_memberships removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.farm_memberships DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_memberships: admin all"         ON public.farm_memberships;
DROP POLICY IF EXISTS "farm_memberships: farmer select own" ON public.farm_memberships;
DROP POLICY IF EXISTS "farm_memberships: farmer insert own" ON public.farm_memberships;

-- ── inventory_batches (Stages 9–10) ───────────────────────────────────────────
-- Symptom: Inventory Review empty for admin; Submit Inventory fails;
--          My Submissions inventory section empty after submission.
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.inventory_batches removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.inventory_batches DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_batches: admin all"         ON public.inventory_batches;
DROP POLICY IF EXISTS "inventory_batches: farmer select own" ON public.inventory_batches;
DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

-- ── ddp_scores (Stage 11) ─────────────────────────────────────────────────────
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.ddp_scores removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.ddp_scores DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ddp_scores: admin all"            ON public.ddp_scores;
DROP POLICY IF EXISTS "ddp_scores: farmer select own farm" ON public.ddp_scores;

-- ── risk_flags (Stage 11) ─────────────────────────────────────────────────────
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.risk_flags removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.risk_flags DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_flags: admin all"             ON public.risk_flags;
DROP POLICY IF EXISTS "risk_flags: farmer select own farm" ON public.risk_flags;

-- ── status_history (Stage 11) ─────────────────────────────────────────────────
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.status_history removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.status_history DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "status_history: admin all"       ON public.status_history;
DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;

-- ── documents (Stage 11) ──────────────────────────────────────────────────────
DO $targeted_isolation_guard$
BEGIN
  IF coalesce(current_setting('rls.disable_tenant_isolation', true), '') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'refused: disabling RLS on public.documents removes tenant isolation for that table — '
      'every authenticated user could then read and write every row in it. If that is genuinely '
      'intended, run SET rls.disable_tenant_isolation = ''true''; in this session first, and '
      're-enable RLS from RLS_ENABLE_STAGED.sql as soon as the incident is over.';
  END IF;
END
$targeted_isolation_guard$;
ALTER TABLE public.documents DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "documents: admin all"       ON public.documents;
DROP POLICY IF EXISTS "documents: farmer select own" ON public.documents;


-- =============================================================================
-- POLICY INSPECTION — run after any rollback to confirm state
-- =============================================================================

-- Which tables have RLS enabled right now?
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Which policies currently exist?
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
