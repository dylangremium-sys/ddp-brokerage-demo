-- =============================================================================
-- RLS_ENABLE_STAGED.sql
-- Staged Row Level Security activation for DDP Brokerage / Supabase
--
-- HOW TO USE:
--   Run each stage INDEPENDENTLY in Supabase → SQL Editor.
--   Test the app after every stage before proceeding to the next.
--   If anything breaks, run RLS_ROLLBACK.sql for the affected table.
--
-- PREREQUISITES (must be true before Stage 1):
--   □ AUTH_RLS_SCHEMA.sql Part 1 + Part 2 already applied
--   □ At least one ddp_admin profile row exists
--   □ At least one farmer profile with a farm_memberships row exists
--   □ App auth (sign in / sign out) confirmed working without RLS
--   □ Stage 0 diagnostics pass (see below)
-- =============================================================================


-- =============================================================================
-- STAGE 0: DIAGNOSTICS — Run first. Read output before proceeding.
-- =============================================================================

-- 0a. Which tables currently have RLS enabled?
--     Expected: all rowsecurity = false before any stage is run.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- 0b. Confirm profiles rows exist and roles are correct.
--     Expected: at least one 'ddp_admin' row.
SELECT id, email, display_name, role, created_at
FROM public.profiles
ORDER BY role, created_at;

-- 0c. Confirm farm_memberships rows link users to farms.
--     Expected: at least one row per farmer who has submitted a farm.
SELECT
  fm.id,
  fm.user_id,
  p.email         AS user_email,
  fm.farm_id,
  f.farm_name,
  fm.role         AS membership_role
FROM public.farm_memberships fm
LEFT JOIN public.profiles p ON p.id = fm.user_id
LEFT JOIN public.farms f    ON f.id = fm.farm_id
ORDER BY fm.created_at;

-- 0d. Confirm farms have created_by populated.
--     Rows with NULL created_by are seed data — they won't be visible to
--     farmer RLS policies (that's expected; admin sees them via 'admin all').
SELECT
  id,
  farm_name,
  status,
  created_by,
  CASE WHEN created_by IS NULL THEN 'SEED DATA (no RLS owner)' ELSE 'User-created' END AS data_source
FROM public.farms
ORDER BY created_at;

-- 0e. Confirm inventory_batches have created_by populated.
SELECT
  id,
  product_name,
  status,
  created_by,
  farm_id
FROM public.inventory_batches
ORDER BY updated_at DESC;

-- 0f. Confirm helper functions exist and are SECURITY DEFINER.
--     Expected: two rows, both with prosecdef = true.
SELECT proname, prosecdef, provolatile
FROM pg_proc
WHERE proname IN ('is_ddp_admin', 'has_farm_membership');

-- 0g. Smoke-test is_ddp_admin() as yourself (run as the Supabase service role).
--     This will return false when run from the SQL Editor (service role ≠ a user).
--     That's expected — it proves the function runs without error.
SELECT is_ddp_admin() AS am_i_admin;


-- =============================================================================
-- STAGE 1: Enable RLS on profiles only (no policies yet)
-- =============================================================================
-- SAFETY CHECK: After this, the app will still work because the anon/service
-- role bypasses RLS. But authenticated user reads of profiles will return
-- zero rows until Stage 2 policies are added.
-- Do NOT stop between Stage 1 and Stage 2.
-- Run Stage 1 + Stage 2 together in the same session.
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STAGE 2: profiles policies
-- =============================================================================
-- After this stage:
--   □ Each user can read only their own profile
--   □ DDP admin can read all profiles
--   □ Users can update their own profile (but cannot change their role)
--   □ DDP admin can change any user's role
--
-- VERIFY: Sign in as farmer → app loads with correct role badge.
--         Sign in as admin  → app loads with correct role badge.
--         If app shows auth-loading spinner indefinitely → profiles SELECT
--         policy is failing. Run Stage 2 rollback from RLS_ROLLBACK.sql.
-- =============================================================================

-- Users read their own profile; admin reads all.
CREATE POLICY "profiles: select own or admin"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR is_ddp_admin());

-- Users can update display_name etc. but cannot self-promote role.
CREATE POLICY "profiles: update own no role change"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

-- Only admin can change a user's role.
CREATE POLICY "profiles: admin update role"
  ON public.profiles FOR UPDATE
  USING (is_ddp_admin());

-- ── Test after Stage 2 ────────────────────────────────────────────────────────
-- Expected: each query returns exactly 1 row for the signed-in user.
-- Run these from the Supabase SQL Editor while impersonating each user role.
SELECT id, email, role FROM public.profiles WHERE id = auth.uid();


-- =============================================================================
-- STAGE 3: Enable RLS on farms only
-- =============================================================================
-- After this stage, all reads of farms return zero rows until Stage 4 policies.
-- Run Stage 3 + Stage 4 together.
-- =============================================================================

ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STAGE 4: farms policies
-- =============================================================================
-- After this stage:
--   □ Admin sees ALL farms (including seed data)
--   □ Farmer sees only farms where created_by = their uid OR they have a
--     farm_memberships row
--   □ Farmer can insert farms with created_by = their uid
--
-- VERIFY:
--   Farmer login → My Submissions shows only their farms (or empty state)
--   Admin login  → Farm Profiles shows all farms including seed data
--   Farmer tries "Enter DDP portal" → blocked by app-side role check (no SQL change)
-- =============================================================================

-- Admin has unrestricted access.
CREATE POLICY "farms: admin all"
  ON public.farms FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read farms they own (by created_by) or are a member of.
CREATE POLICY "farms: farmer select own"
  ON public.farms FOR SELECT
  USING (
    created_by = auth.uid()
    OR has_farm_membership(id)
  );

-- Farmer can insert farms only when setting themselves as created_by.
CREATE POLICY "farms: farmer insert own"
  ON public.farms FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- ── Test after Stage 4 ────────────────────────────────────────────────────────
-- Run this in SQL Editor (service role sees everything):
SELECT id, farm_name, created_by FROM public.farms ORDER BY created_at;
-- Expected: all rows visible from service role.
-- When testing from the app as a farmer: only their farms appear.


-- =============================================================================
-- STAGE 5: Enable RLS on farm_profiles only
-- =============================================================================

ALTER TABLE public.farm_profiles ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STAGE 6: farm_profiles policies
-- =============================================================================
-- ⚠️  IMPORTANT: The INSERT policy below differs from AUTH_RLS_SCHEMA.sql.
--
-- The original draft policy used has_farm_membership(farm_id) for INSERT.
-- This is WRONG because db.ts creates farm_profiles BEFORE creating the
-- farm_memberships row (in that order: farms → farm_profiles → farm_memberships).
-- The membership does not yet exist when farm_profiles is inserted, so
-- has_farm_membership() returns false and the insert would be rejected.
--
-- Two ways to fix this (pick one):
--
--   FIX A (used below): Check farms.created_by instead of membership.
--          Does not require any app code changes.
--
--   FIX B (alternative): Reorder operations in src/lib/db.ts createFarmProfile:
--          Step 1: INSERT farms (with created_by)
--          Step 2: INSERT farm_memberships
--          Step 3: INSERT farm_profiles
--          Then use has_farm_membership(farm_id) in the policy. But this
--          requires a code change + rebuild + deploy before this stage runs.
--
-- This file uses FIX A. Apply FIX B if you prefer belt-and-suspenders.
-- =============================================================================

-- Admin unrestricted.
CREATE POLICY "farm_profiles: admin all"
  ON public.farm_profiles FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read their own farm profile.
CREATE POLICY "farm_profiles: farmer select own"
  ON public.farm_profiles FOR SELECT
  USING (has_farm_membership(farm_id));

-- ⚠️  FIX A: Use farms.created_by to authorise insert (membership not yet created).
CREATE POLICY "farm_profiles: farmer insert own"
  ON public.farm_profiles FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms
      WHERE id = farm_id
        AND created_by = auth.uid()
    )
  );

-- ── Test after Stage 6 ────────────────────────────────────────────────────────
-- From the app as a farmer: submit a new farm.
-- Expected: no error, farm appears in My Submissions.
-- From SQL Editor (service role): confirm new row in farm_profiles.
SELECT farm_id, (business_info->>'tradingName') AS trading_name
FROM public.farm_profiles
ORDER BY id DESC
LIMIT 5;


-- =============================================================================
-- STAGE 7: Enable RLS on farm_memberships only
-- =============================================================================

ALTER TABLE public.farm_memberships ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STAGE 8: farm_memberships policies
-- =============================================================================
-- ⚠️  IMPORTANT: A farmer INSERT policy is REQUIRED but was missing from
-- AUTH_RLS_SCHEMA.sql. The app calls sbInsert('farm_memberships', ...) from
-- within createFarmProfile() as the authenticated farmer. Without an INSERT
-- policy, this call will be rejected by RLS.
--
-- The policy below allows a farmer to insert a membership row only when:
--   - The user_id matches their own uid (no self-spoofing)
--   - The farm was created by them (prevents hijacking other farms)
-- =============================================================================

-- Admin unrestricted.
CREATE POLICY "farm_memberships: admin all"
  ON public.farm_memberships FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read their own memberships.
CREATE POLICY "farm_memberships: farmer select own"
  ON public.farm_memberships FOR SELECT
  USING (user_id = auth.uid());

-- ⚠️  MISSING FROM AUTH_RLS_SCHEMA.sql — required for farm registration to work.
-- Farmer can insert their own membership only for farms they created.
CREATE POLICY "farm_memberships: farmer insert own"
  ON public.farm_memberships FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.farms
      WHERE id = farm_id
        AND created_by = auth.uid()
    )
  );

-- ── Test after Stage 8 ────────────────────────────────────────────────────────
-- From the app as a farmer: submit another new farm.
-- Expected: farm appears in My Submissions, no error in app error banner.
-- From SQL Editor: confirm both farms and farm_memberships rows created.
SELECT fm.farm_id, f.farm_name, fm.user_id, p.email
FROM public.farm_memberships fm
JOIN public.farms f    ON f.id = fm.farm_id
JOIN public.profiles p ON p.id = fm.user_id;


-- =============================================================================
-- STAGE 9: Enable RLS on inventory_batches only
-- =============================================================================

ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- STAGE 10: inventory_batches policies
-- =============================================================================
-- After this stage:
--   □ Admin sees ALL batches and can update status
--   □ Farmer sees only batches they created or that belong to their farms
--   □ Farmer can insert batches with created_by = their uid
--
-- VERIFY:
--   Farmer: Submit Inventory → batch appears in My Submissions.
--   Admin:  Inventory Review → all batches visible, approve/reject works.
-- =============================================================================

-- Admin unrestricted.
CREATE POLICY "inventory_batches: admin all"
  ON public.inventory_batches FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

-- Farmer can read batches they submitted or linked to their farm.
CREATE POLICY "inventory_batches: farmer select own"
  ON public.inventory_batches FOR SELECT
  USING (
    created_by = auth.uid()
    OR has_farm_membership(farm_id)
  );

-- Farmer can insert only with their own uid as created_by.
CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- ── Test after Stage 10 ───────────────────────────────────────────────────────
-- Farmer: submit inventory → visible in My Submissions.
-- Admin: Inventory Review shows all batches (including farmer's new one).
-- Admin: approve a batch → status updates, no error.


-- =============================================================================
-- STAGE 11: Optional — ddp_scores, risk_flags, status_history, documents
-- =============================================================================
-- These tables are lower risk because:
--   - Farmers never write to them directly (app writes as admin/service role).
--   - They may be empty or minimally populated.
-- Apply only after Stages 1–10 are stable.
-- =============================================================================

-- ── ddp_scores ────────────────────────────────────────────────────────────────
ALTER TABLE public.ddp_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ddp_scores: admin all"
  ON public.ddp_scores FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

CREATE POLICY "ddp_scores: farmer select own farm"
  ON public.ddp_scores FOR SELECT
  USING (has_farm_membership(farm_id));

-- ── risk_flags ────────────────────────────────────────────────────────────────
ALTER TABLE public.risk_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "risk_flags: admin all"
  ON public.risk_flags FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

CREATE POLICY "risk_flags: farmer select own farm"
  ON public.risk_flags FOR SELECT
  USING (has_farm_membership(farm_id));

-- ── status_history ────────────────────────────────────────────────────────────
-- Note: status_history INSERT is performed by admin actions (approve/reject).
-- The "admin all" policy covers this. No farmer insert policy needed.
ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "status_history: admin all"
  ON public.status_history FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

CREATE POLICY "status_history: farmer select own"
  ON public.status_history FOR SELECT
  USING (
    (entity_type = 'farm'            AND has_farm_membership(entity_id))
    OR
    (entity_type = 'inventory_batch' AND EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id       = entity_id
        AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
    ))
  );

-- ── documents ─────────────────────────────────────────────────────────────────
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents: admin all"
  ON public.documents FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());

CREATE POLICY "documents: farmer select own"
  ON public.documents FOR SELECT
  USING (
    has_farm_membership(farm_id)
    OR (
      inventory_batch_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_batches ib
        WHERE ib.id = inventory_batch_id
          AND (ib.created_by = auth.uid() OR has_farm_membership(ib.farm_id))
      )
    )
  );


-- =============================================================================
-- END OF STAGED RLS PLAN
-- =============================================================================
-- Two policy corrections vs AUTH_RLS_SCHEMA.sql (see Stages 6 and 8):
--
--   1. "farm_profiles: farmer insert own"
--      Changed: has_farm_membership(farm_id)
--      To:      EXISTS (SELECT 1 FROM farms WHERE id = farm_id AND created_by = auth.uid())
--      Why:     Membership row does not exist yet when farm_profiles is inserted.
--
--   2. "farm_memberships: farmer insert own"   ← NEW POLICY (was missing entirely)
--      Allows farmer to insert their own membership row for farms they created.
--      Without this, farm registration fails with a policy violation at the
--      third step of createFarmProfile().
-- =============================================================================
