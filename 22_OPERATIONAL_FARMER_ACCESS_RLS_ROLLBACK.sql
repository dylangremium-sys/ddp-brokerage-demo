-- 22_OPERATIONAL_FARMER_ACCESS_RLS_ROLLBACK.sql
-- =============================================================================
-- Reverse migration 22. Drops ONLY the objects migration 22 created:
--   • the 11 "<table>: operational farmer or admin" restrictive policies
--   • the "farmer buckets: operational farmer or admin" storage policy
--   • the public.has_operational_farmer_access() helper
--
-- It leaves every pre-existing permissive/admin policy untouched and does NOT
-- disable RLS on any table.
--
-- WARNING: this REOPENS the Codex P1 gap — a 'pending' account can again write
-- farm data directly via the REST/Storage API.
--
-- Order matters: the policies depend on the helper, so the policies are dropped
-- BEFORE the function. Idempotent (IF EXISTS throughout).
-- =============================================================================

BEGIN;

-- 1. Drop the per-table restrictive policies (depend on the helper).
DO $rollback$
DECLARE
  t text;
  tables text[] := ARRAY[
    'farms','farm_profiles','farm_memberships','inventory_batches',
    'farmer_documents','farmer_photos','farmer_review_requests',
    'documents','ddp_scores','risk_flags','status_history'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || ': operational farmer or admin', t);
  END LOOP;
END
$rollback$;

-- 2. Drop the storage restrictive policy.
DROP POLICY IF EXISTS "farmer buckets: operational farmer or admin" ON storage.objects;

-- 3. Drop the helper (now unreferenced).
DROP FUNCTION IF EXISTS public.has_operational_farmer_access();

COMMIT;
