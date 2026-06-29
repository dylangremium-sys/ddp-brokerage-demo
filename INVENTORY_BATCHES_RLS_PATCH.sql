-- =============================================================================
-- INVENTORY_BATCHES_RLS_PATCH.sql
-- DDP Brokerage — inventory_batches RLS hotfix
--
-- PURPOSE:
--   This file records a manual production RLS hotfix applied to the Supabase
--   project after FARMER_MVP_MIGRATION.sql was run.
--
--   After FARMER_MVP_MIGRATION.sql, diagnostic checks revealed that
--   inventory_batches had only ONE active policy:
--     • inventory_batches: farmer update own (added by the migration)
--
--   The three policies that should have been present from RLS_ENABLE_STAGED.sql
--   were missing from the project:
--     • inventory_batches: admin all
--     • inventory_batches: farmer select own
--     • inventory_batches: farmer insert own
--
--   This patch was applied manually via the Supabase SQL Editor and is
--   recorded here so that:
--     1. The repository matches production DB state.
--     2. Future environment setup (staging, new project) can reproduce the
--        exact policy configuration by running this file.
--     3. Code review and handover have a complete audit trail.
--
-- ORDER:
--   Apply AFTER FARMER_MVP_MIGRATION.sql (which adds the farmer UPDATE policy).
--   The full intended policy set on inventory_batches is:
--     1. inventory_batches: admin all         (this file)
--     2. inventory_batches: farmer select own (this file)
--     3. inventory_batches: farmer insert own (this file)
--     4. inventory_batches: farmer update own (FARMER_MVP_MIGRATION.sql Section F)
--
-- SAFETY:
--   • All DDL uses DROP POLICY IF EXISTS before CREATE POLICY — idempotent.
--   • ALTER TABLE ENABLE ROW LEVEL SECURITY is idempotent.
--   • Safe to re-run against a database where policies already exist.
--   • Does not touch any data rows.
--
-- PREREQUISITES:
--   □ is_ddp_admin()        function exists (AUTH_RLS_SCHEMA.sql Part 2)
--   □ has_farm_membership() function exists (AUTH_RLS_SCHEMA.sql Part 2)
-- =============================================================================


-- Ensure RLS is enabled (idempotent — safe if already enabled).
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- POLICY 1: Admin unrestricted access
-- =============================================================================
-- DDP admin users can read, insert, update, and delete any row.

DROP POLICY IF EXISTS "inventory_batches: admin all" ON public.inventory_batches;

CREATE POLICY "inventory_batches: admin all"
  ON public.inventory_batches FOR ALL
  USING (is_ddp_admin())
  WITH CHECK (is_ddp_admin());


-- =============================================================================
-- POLICY 2: Farmer read — own batches only
-- =============================================================================
-- Farmers can read batches they created OR that belong to a farm they are
-- a member of.  They cannot read other farmers' batches.

DROP POLICY IF EXISTS "inventory_batches: farmer select own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer select own"
  ON public.inventory_batches FOR SELECT
  USING (
    created_by = auth.uid()
    OR has_farm_membership(farm_id)
  );


-- =============================================================================
-- POLICY 3: Farmer insert — own batches only
-- =============================================================================
-- Farmers can insert new batches subject to these constraints:
--   • created_by must be their own uid, OR they have farm membership.
--   • client_visible must be false at insert time (admin-only privilege).
--   • status must not be 'Approved' at insert time (no self-approving).
--   • stock_status must be a farmer-controlled state or NULL.

DROP POLICY IF EXISTS "inventory_batches: farmer insert own" ON public.inventory_batches;

CREATE POLICY "inventory_batches: farmer insert own"
  ON public.inventory_batches FOR INSERT
  WITH CHECK (
    -- Must be their own batch or a farm they belong to
    (created_by = auth.uid() OR has_farm_membership(farm_id))
    -- Farmer cannot create a batch that is already buyer-visible
    AND client_visible = false
    -- Farmer cannot self-approve at insert time
    AND status NOT IN ('Approved')
    -- Farmer cannot insert directly into admin-controlled stock states
    AND (
      stock_status IS NULL
      OR stock_status IN ('draft', 'submitted', 'needs_changes')
    )
  );


-- =============================================================================
-- VERIFICATION — run after applying to confirm all four policies are present
-- =============================================================================
-- SELECT policyname, cmd
-- FROM pg_policies
-- WHERE tablename = 'inventory_batches'
-- ORDER BY policyname;
--
-- Expected output:
--   inventory_batches: admin all          | ALL
--   inventory_batches: farmer insert own  | INSERT
--   inventory_batches: farmer select own  | SELECT
--   inventory_batches: farmer update own  | UPDATE
-- =============================================================================
