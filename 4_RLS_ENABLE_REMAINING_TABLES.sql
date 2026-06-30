-- ============================================================================
-- RLS HARDENING MIGRATION
-- File: 4_RLS_ENABLE_REMAINING_TABLES.sql
-- Date: 2026-06-30
--
-- Addresses Supabase Security Advisor ERRORS:
--   "RLS Disabled in Public" on:
--     public.ddp_scores
--     public.risk_flags
--     public.status_history
--     public.documents
--
-- These 4 tables were held at Stage 11 in RLS_ENABLE_STAGED.sql pending
-- stabilisation of the farmer MVP (Stages 1-10). Stages 1-10 are confirmed
-- stable; this migration completes the RLS rollout.
--
-- What this file does NOT do:
--   • Does not push, deploy, or touch secrets
--   • Does not drop, truncate, or modify any table structure
--   • Does not weaken any existing RLS policy
--   • Does not grant anon access to any table
--   • Does not grant broad authenticated access — farmer policies are scoped
--     to the calling user's farm membership only
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. ddp_scores
--
-- Purpose: Admin-assigned numeric scores per farm (compliance, quality, etc.).
--   Written exclusively by admin operations (no sbInsert in app code).
--   Farmers should be able to read their own farm's score — it is visible
--   on the farmer dashboard as a "partner tier" indicator.
--
-- SELECT:
--   • Admin (is_ddp_admin): sees all rows — needed for the admin dashboard
--     to rank and compare farms.
--   • Farmer (has_farm_membership): sees only rows for their own farm(s).
--     Scoped via farm_id FK.
--
-- INSERT / UPDATE / DELETE:
--   • Admin only. No farmer or anon path writes scores.
--   • If a non-admin tries to write, the admin policy's WITH CHECK fails
--     and Postgres returns a policy violation — no silent data loss.
--
-- Risk if wrong:
--   • Overly open SELECT: a farmer could read competitor farm scores.
--   • Overly closed SELECT: farmer dashboard partner-tier widget breaks.
--   • No INSERT policy for admin: admin score-setting tool breaks.
-- ============================================================================
ALTER TABLE public.ddp_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ddp_scores: admin all"             ON public.ddp_scores;
DROP POLICY IF EXISTS "ddp_scores: farmer select own farm" ON public.ddp_scores;

-- Admin: full read/write on all rows.
CREATE POLICY "ddp_scores: admin all"
  ON public.ddp_scores FOR ALL
  USING     (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- Farmer: read-only, scoped to farms they are members of.
CREATE POLICY "ddp_scores: farmer select own farm"
  ON public.ddp_scores FOR SELECT
  USING (public.has_farm_membership(farm_id));


-- ============================================================================
-- 2. risk_flags
--
-- Purpose: Admin-assigned risk labels per farm (e.g. "missing COA",
--   "facility concern"). Written exclusively by admin. Farmers may see
--   flags on their own farm to understand what needs attention.
--
-- SELECT:
--   • Admin: all rows.
--   • Farmer: only rows where farm_id matches a farm they belong to.
--
-- INSERT / UPDATE / DELETE:
--   • Admin only. A farmer should never be able to create or dismiss a
--     risk flag — that would undermine the audit trail.
--
-- Risk if wrong:
--   • Overly open SELECT: farmer A can read the risk flags of farm B —
--     a serious confidentiality breach in a brokerage context.
--   • Overly open INSERT/UPDATE: a farmer could delete their own risk flag.
--   • No INSERT policy for admin: admin flag-setting tool breaks.
-- ============================================================================
ALTER TABLE public.risk_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_flags: admin all"              ON public.risk_flags;
DROP POLICY IF EXISTS "risk_flags: farmer select own farm" ON public.risk_flags;

CREATE POLICY "risk_flags: admin all"
  ON public.risk_flags FOR ALL
  USING     (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

CREATE POLICY "risk_flags: farmer select own farm"
  ON public.risk_flags FOR SELECT
  USING (public.has_farm_membership(farm_id));


-- ============================================================================
-- 3. status_history
--
-- Purpose: Append-only audit log of status transitions for farms and
--   inventory batches. INSERT is performed by the app (db.ts lines 284, 382)
--   inside updateFarmProfileStatus() and updateInventoryStatus(), both of
--   which are called only from admin review actions in App.tsx (lines 315,
--   330). The calling Supabase session therefore always carries a ddp_admin
--   JWT — the admin INSERT policy covers this path.
--
-- entity_type is polymorphic ('farm' or 'inventory_batch'); entity_id is the
--   corresponding primary key. There is no direct FK so farm/batch membership
--   is verified via sub-selects.
--
-- SELECT:
--   • Admin: all rows.
--   • Farmer: rows where entity_type = 'farm' and they are a member of that
--     farm, OR entity_type = 'inventory_batch' and they created the batch
--     or are a member of the batch's farm.
--
-- INSERT:
--   • Admin only. The app only ever inserts here in an admin session.
--     If this ever needs to change (e.g. system-level service inserts),
--     add a WITH CHECK (true) FOR INSERT policy for service_role instead.
--
-- UPDATE / DELETE:
--   • Nobody. Audit logs must be immutable. No UPDATE or DELETE policy is
--     created — Postgres denies by default when no matching policy exists.
--
-- Risk if wrong:
--   • Overly open SELECT: farmer sees status history for other farms.
--   • INSERT open to farmer: farmer could forge audit entries.
--   • UPDATE/DELETE open to anyone: audit log integrity lost.
-- ============================================================================
ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "status_history: admin all"        ON public.status_history;
DROP POLICY IF EXISTS "status_history: farmer select own" ON public.status_history;

-- Admin: full read/write. Covers the INSERT path in db.ts.
CREATE POLICY "status_history: admin all"
  ON public.status_history FOR ALL
  USING     (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- Farmer: read-only, scoped to entities they own or belong to.
CREATE POLICY "status_history: farmer select own"
  ON public.status_history FOR SELECT
  USING (
    (entity_type = 'farm' AND public.has_farm_membership(entity_id))
    OR
    (entity_type = 'inventory_batch' AND EXISTS (
      SELECT 1 FROM public.inventory_batches ib
      WHERE ib.id = entity_id
        AND (ib.created_by = auth.uid() OR public.has_farm_membership(ib.farm_id))
    ))
  );


-- ============================================================================
-- 4. documents
--
-- Purpose: Admin-managed document metadata for farms and inventory batches.
--   Holds file_url, review_status, and reviewer_note — fields that indicate
--   admin review activity. No sbInsert/sbUpdate calls for this table exist
--   in app code; it is written by admin backend operations.
--
--   NOTE: public.farmer_documents is a separate table (added in migration 2)
--   where farmers upload their own COA files. That table already has RLS.
--   This table (public.documents) is the older admin-managed document store.
--
-- SELECT:
--   • Admin: all rows.
--   • Farmer: rows where farm_id matches one of their farms, OR where
--     inventory_batch_id points to a batch they created or farm they belong
--     to. farm_id may be NULL if the document is batch-only; the second
--     branch of the OR covers that case.
--
-- INSERT / UPDATE / DELETE:
--   • Admin only. reviewer_note and review_status must not be writeable
--     by farmers or anonymous callers.
--
-- Risk if wrong:
--   • Overly open SELECT: farmer sees reviewer_note for other farms'
--     documents — leaks admin commentary.
--   • Farmer INSERT/UPDATE: farmer could alter reviewer_note or review_status.
--   • No policy at all: table remains publicly readable (the current state,
--     which this migration fixes).
-- ============================================================================
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents: admin all"        ON public.documents;
DROP POLICY IF EXISTS "documents: farmer select own" ON public.documents;

CREATE POLICY "documents: admin all"
  ON public.documents FOR ALL
  USING     (public.is_ddp_admin())
  WITH CHECK (public.is_ddp_admin());

-- Farmer: read-only, scoped to their own farm or their own batches.
CREATE POLICY "documents: farmer select own"
  ON public.documents FOR SELECT
  USING (
    public.has_farm_membership(farm_id)
    OR (
      inventory_batch_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_batches ib
        WHERE ib.id = inventory_batch_id
          AND (ib.created_by = auth.uid() OR public.has_farm_membership(ib.farm_id))
      )
    )
  );


-- ============================================================================
-- VERIFICATION QUERIES
-- Uncomment and run each block in the Supabase SQL Editor after applying.
-- ============================================================================

-- 1. Confirm RLS is enabled on all 4 tables:
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('ddp_scores', 'risk_flags', 'status_history', 'documents');
-- Expected: rowsecurity = true for all 4 rows.

-- 2. Confirm policies exist on all 4 tables:
-- SELECT tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('ddp_scores', 'risk_flags', 'status_history', 'documents')
-- ORDER BY tablename, policyname;
-- Expected: 2 policies per table (admin all + farmer select own).

-- 3. Confirm no anon policies exist on any of these tables:
-- SELECT tablename, policyname, roles
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('ddp_scores', 'risk_flags', 'status_history', 'documents')
--   AND (roles::text LIKE '%anon%' OR roles::text LIKE '%public%');
-- Expected: 0 rows.

-- 4. Confirm authenticated access is admin-gated (no unchecked SELECT for authenticated):
-- SELECT tablename, policyname, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('ddp_scores', 'risk_flags', 'status_history', 'documents')
--   AND qual NOT LIKE '%is_ddp_admin%'
--   AND qual NOT LIKE '%has_farm_membership%'
--   AND qual NOT LIKE '%auth.uid%';
-- Expected: 0 rows (every policy references an admin or membership check).

COMMIT;
