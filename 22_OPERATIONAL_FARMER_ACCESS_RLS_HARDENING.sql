-- 22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql
-- =============================================================================
-- Operational-farmer RLS overlay — close the "pending can still write via REST"
-- gap (Codex P1 on PR #22).
--
-- Problem: every farmer WRITE/UPLOAD policy authorizes by OWNERSHIP/MEMBERSHIP
-- only (created_by = auth.uid() / has_farm_membership() / storage path), never
-- by operational role. So a 'pending' account (which migration 21 blocks at
-- login routing and from self-promotion) can still call the Supabase REST/
-- Storage API directly and INSERT/UPDATE/UPLOAD farm data.
--
-- Fix (OVERLAY, not rewrite): a centralized helper plus one AS RESTRICTIVE
-- FOR ALL policy per farmer-operated table (and a bucket-scoped one for
-- storage). PostgreSQL evaluates access as:
--     (rows matching ANY permissive policy) AND (ALL restrictive policies)
-- so the restrictive layer ANDs "must be an operational farmer or a DDP admin"
-- on top of the existing ownership/field guardrails WITHOUT touching them.
-- Pending users are blocked everywhere; farmers and admins are unchanged;
-- service_role bypasses RLS, so DDP server-side provisioning is unaffected.
--
-- This migration is idempotent and transactional. It DROPs/CREATEs only its own
-- objects (helper + the "operational farmer or admin" policies). It does not
-- drop, rewrite, or weaken any existing permissive or admin policy.
--
-- Audit basis: see the PR #22 RLS authorization audit. Authoritative farmer
-- policies gate on ownership/membership only across farms, farm_profiles,
-- farm_memberships, inventory_batches, farmer_documents, farmer_photos,
-- farmer_review_requests, documents, ddp_scores, risk_flags, status_history,
-- and the farmer-documents/farmer-photos storage buckets.
--
-- Verify:   22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql
-- Rollback: 22_OPERATIONAL_FARMER_ACCESS_RLS_ROLLBACK.sql
-- Precondition: public.is_ddp_admin() exists (migration 3 / AUTH_RLS_SCHEMA);
--               migration 21 (pending role) applied.
-- =============================================================================

BEGIN;

-- 1. Centralized operational-farmer authorization helper.
--    Currently enforces ONLY the proven requirement: the caller's database
--    profile role is 'farmer'. It is intentionally the single choke point so it
--    can later incorporate account status / suspension / onboarding / compliance
--    holds without editing any policy. It reads the role from public.profiles —
--    never from JWT metadata — and returns false for a null uid or missing row.
CREATE OR REPLACE FUNCTION public.has_operational_farmer_access()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'farmer'
  );
$$;

-- Least privilege: used only inside RLS policies, evaluated in the caller's
-- privilege context. authenticated + service_role need EXECUTE; anon never does
-- (anon has no permissive access to these tables, so the helper is never reached
-- for anon). Mirrors the grant posture of public.is_ddp_admin().
REVOKE EXECUTE ON FUNCTION public.has_operational_farmer_access() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_operational_farmer_access() FROM anon;
GRANT  EXECUTE ON FUNCTION public.has_operational_farmer_access() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.has_operational_farmer_access() TO service_role;

-- 2. Restrictive overlay on every farmer-operated table (idempotent).
--    One AS RESTRICTIVE FOR ALL policy per table, applied on top of the existing
--    permissive policies. Existing policies are left exactly as-is.
DO $overlay$
DECLARE
  t text;
  tables text[] := ARRAY[
    'farms',
    'farm_profiles',
    'farm_memberships',
    'inventory_batches',
    'farmer_documents',
    'farmer_photos',
    'farmer_review_requests',
    'documents',
    'ddp_scores',
    'risk_flags',
    'status_history'
  ];
  pol text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    pol := t || ': operational farmer or admin';
    -- Safety no-op if RLS is already enabled (it is, per the audit).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', pol, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I'
      || ' AS RESTRICTIVE FOR ALL'
      || ' USING (public.has_operational_farmer_access() OR public.is_ddp_admin())'
      || ' WITH CHECK (public.has_operational_farmer_access() OR public.is_ddp_admin());',
      pol, t
    );
  END LOOP;
END
$overlay$;

-- 3. PRECONDITION for the storage section below.
--
--    CREATE/DROP POLICY on storage.objects requires ownership of that table. In
--    a Supabase project storage.objects is owned by supabase_storage_admin, NOT
--    by the role that normally applies migrations. Without this guard, a role
--    lacking that membership fails at the CREATE POLICY below with
--    "must be owner of table objects" — and because this file is a single
--    transaction, that failure ALSO rolls back the 11-table overlay and the
--    helper created above. The operator would see a storage-shaped error and
--    could easily miss that the public-schema overlay never landed.
--
--    Failing here instead makes the actual precondition explicit and keeps the
--    diagnosis honest. The owner is read from the catalog rather than hardcoded,
--    so this stays correct if the owning role differs. pg_has_role() is true for
--    superusers and for any role holding membership in the owner.
DO $storage_precondition$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION
      'migration 22 precondition failed: storage.objects does not exist. '
      'Apply the storage extension/buckets first, or run this migration without section 3.';
  END IF;

  IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
    RAISE EXCEPTION
      'migration 22 precondition failed: current_user "%" is not a member of "%", which owns '
      'storage.objects. CREATE POLICY on that table would fail and roll back the ENTIRE '
      'migration, including the 11-table overlay. Re-run as a role holding that membership, '
      'or split section 3 into a separately applied migration.',
      current_user, v_owner;
  END IF;
END
$storage_precondition$;

-- 4. Storage: a single bucket-scoped restrictive policy. It constrains ONLY the
--    two farmer buckets; every other bucket short-circuits to true and is
--    unaffected. Blocks pending/non-farmer SELECT/INSERT/UPDATE/DELETE there.
--
--    The bucket test uses IS DISTINCT FROM rather than NOT IN: bucket_id is
--    nullable, and `NULL NOT IN (...)` evaluates to NULL, which a RESTRICTIVE
--    policy treats as a denial. That would make any row with a NULL bucket_id
--    inaccessible to every non-farmer, non-admin caller — an availability
--    regression on buckets this policy is explicitly meant to leave alone.
DROP POLICY IF EXISTS "farmer buckets: operational farmer or admin" ON storage.objects;
CREATE POLICY "farmer buckets: operational farmer or admin"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  USING (
    (bucket_id IS DISTINCT FROM 'farmer-documents'
     AND bucket_id IS DISTINCT FROM 'farmer-photos')
    OR public.has_operational_farmer_access()
    OR public.is_ddp_admin()
  )
  WITH CHECK (
    (bucket_id IS DISTINCT FROM 'farmer-documents'
     AND bucket_id IS DISTINCT FROM 'farmer-photos')
    OR public.has_operational_farmer_access()
    OR public.is_ddp_admin()
  );

-- 5. market_price_benchmarks — the ONLY pending exposure here is the SELECT
--    policy "market_price_benchmarks: farmer select visible"
--    (USING visible_to_farmers = true AND auth.uid() IS NOT NULL), which lets any
--    authenticated pending session read DDP price hints. There is NO farmer
--    write policy on this table (only "admin all" governs writes), so the
--    narrowest control that fully closes the exposure is a restrictive FOR
--    SELECT: it denies pending reads while leaving the farmer/admin SELECT and
--    the admin-managed writes untouched. FOR ALL is unnecessary (no farmer
--    write path to restrict). The existing permissive policies are left as-is.
ALTER TABLE public.market_price_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "market_price_benchmarks: operational farmer or admin" ON public.market_price_benchmarks;
CREATE POLICY "market_price_benchmarks: operational farmer or admin"
  ON public.market_price_benchmarks
  AS RESTRICTIVE
  FOR SELECT
  USING (public.has_operational_farmer_access() OR public.is_ddp_admin());

COMMIT;
