-- =============================================================================
-- RLS_ROLLBACK.sql
-- Emergency rollback for Row Level Security on DDP Brokerage tables.
--
-- HOW TO USE:
--   Run the relevant block in Supabase → SQL Editor if the app goes blank,
--   throws Supabase errors, or loses data visibility after an RLS stage.
--
-- SAFE: These commands only disable or drop policies. They do NOT:
--   - Delete rows
--   - Drop tables
--   - Alter columns
--   - Change auth.users
--
-- After disabling RLS, the table returns to its previous unrestricted state.
-- Re-enable by re-running the relevant stage from RLS_ENABLE_STAGED.sql.
-- =============================================================================


-- =============================================================================
-- FULL ROLLBACK — disables RLS on all tables at once
-- Use when the app is completely broken and you need immediate recovery.
-- =============================================================================

ALTER TABLE public.profiles           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farms              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_profiles      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_memberships   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ddp_scores         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_flags         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_history     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents          DISABLE ROW LEVEL SECURITY;

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
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles: select own or admin"      ON public.profiles;
DROP POLICY IF EXISTS "profiles: update own no role change" ON public.profiles;
DROP POLICY IF EXISTS "profiles: admin update role"        ON public.profiles;

-- ── farms (Stages 3–4) ────────────────────────────────────────────────────────
-- Symptom: Farm Profiles page empty for admin; My Submissions empty for farmer
--          who did have farms.
ALTER TABLE public.farms DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farms: admin all"          ON public.farms;
DROP POLICY IF EXISTS "farms: farmer select own"  ON public.farms;
DROP POLICY IF EXISTS "farms: farmer insert own"  ON public.farms;

-- ── farm_profiles (Stages 5–6) ────────────────────────────────────────────────
-- Symptom: Farm registration fails with Supabase error banner; DDP Farm Review
--          shows empty profile sections for admin.
ALTER TABLE public.farm_profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_profiles: admin all"         ON public.farm_profiles;
DROP POLICY IF EXISTS "farm_profiles: farmer select own" ON public.farm_profiles;
DROP POLICY IF EXISTS "farm_profiles: farmer insert own" ON public.farm_profiles;

-- ── farm_memberships (Stages 7–8) ─────────────────────────────────────────────
-- Symptom: Farm registration fails at the membership insert step
--          (error visible in browser console as "policy violation").
--          Farmer scope loads empty even after registering a farm.
ALTER TABLE public.farm_memberships DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_memberships: admin all"         ON public.farm_memberships;
DROP POLICY IF EXISTS "farm_memberships: farmer select own" ON public.farm_memberships;
DROP POLICY IF EXISTS "farm_memberships: farmer insert own" ON public.farm_memberships;

-- ── inventory_batches (Stages 9–10) ───────────────────────────────────────────
-- Symptom: Inventory Review empty for admin; Submit Inventory fails;
--          My Submissions inventory section empty after submission.
ALTER TABLE public.inventory_batches DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_batches: admin all"         ON public.inventory_batches;
DROP POLICY IF EXISTS "inventory_batches: farmer select own" ON public.inventory_batches;
DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

-- ── ddp_scores (Stage 11) ─────────────────────────────────────────────────────
ALTER TABLE public.ddp_scores DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ddp_scores: admin all"            ON public.ddp_scores;
DROP POLICY IF EXISTS "ddp_scores: farmer select own farm" ON public.ddp_scores;

-- ── risk_flags (Stage 11) ─────────────────────────────────────────────────────
ALTER TABLE public.risk_flags DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_flags: admin all"             ON public.risk_flags;
DROP POLICY IF EXISTS "risk_flags: farmer select own farm" ON public.risk_flags;

-- ── status_history (Stage 11) ─────────────────────────────────────────────────
ALTER TABLE public.status_history DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "status_history: admin all"       ON public.status_history;
DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;

-- ── documents (Stage 11) ──────────────────────────────────────────────────────
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
