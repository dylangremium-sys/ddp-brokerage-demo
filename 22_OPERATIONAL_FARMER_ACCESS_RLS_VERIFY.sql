-- 22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql
-- =============================================================================
-- Proves migration 22 is correctly applied. Fully transactional; ends in
-- ROLLBACK, so it leaves NO residue. Run AFTER the hardening migration.
--
-- Proves (static, via catalogs):
--   A. helper exists: SECURITY DEFINER, STABLE, safe search_path
--   B. helper is NOT executable by anon; IS executable by authenticated
--   C. every required table has the restrictive "operational farmer or admin"
--      policy, AS RESTRICTIVE, FOR ALL, and RLS is enabled
--   D. storage policy exists, is restrictive, and is bucket-scoped
--   E. no pre-existing permissive farmer policy was dropped
-- Proves (behavioural, via seeded identities):
--   F. pending identity => helper false; farmer identity => helper true;
--      admin identity => is_ddp_admin true, helper false
--
-- NOTE: auth.users is seeded with id + email only (other columns nullable in
-- this environment, as in the migration 19/21 verifies). Migration 21's trigger
-- stamps the new rows 'pending'; two are then promoted for the test.
-- =============================================================================

BEGIN;

-- ── A. helper shape ─────────────────────────────────────────────────────────
DO $$
DECLARE r pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_proc
  WHERE proname = 'has_operational_farmer_access'
    AND pronamespace = 'public'::regnamespace;
  IF NOT FOUND THEN RAISE EXCEPTION 'VERIFY A FAILED: helper function missing'; END IF;
  IF NOT r.prosecdef THEN RAISE EXCEPTION 'VERIFY A FAILED: helper is not SECURITY DEFINER'; END IF;
  IF r.provolatile <> 's' THEN RAISE EXCEPTION 'VERIFY A FAILED: helper is not STABLE'; END IF;
  IF r.proconfig IS NULL OR NOT (r.proconfig::text ILIKE '%search_path%') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: helper has no pinned search_path';
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: helper is SECURITY DEFINER, STABLE, search_path pinned.';
END $$;

-- ── B. helper grants (least privilege) ──────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.has_operational_farmer_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: anon can EXECUTE the helper';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.has_operational_farmer_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: authenticated cannot EXECUTE the helper';
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: helper executable by authenticated, not anon.';
END $$;

-- ── C. restrictive overlay on every required table ──────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'farms','farm_profiles','farm_memberships','inventory_batches',
    'farmer_documents','farmer_photos','farmer_review_requests',
    'documents','ddp_scores','risk_flags','status_history'
  ];
  v_perm text; v_cmd text; v_rls boolean;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT permissive, cmd INTO v_perm, v_cmd
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
      AND policyname = t || ': operational farmer or admin';
    IF v_perm IS NULL THEN
      RAISE EXCEPTION 'VERIFY C FAILED: % missing the operational-farmer restrictive policy', t;
    END IF;
    IF v_perm <> 'RESTRICTIVE' THEN
      RAISE EXCEPTION 'VERIFY C FAILED: %s policy is % (expected RESTRICTIVE)', t, v_perm;
    END IF;
    IF v_cmd <> 'ALL' THEN
      RAISE EXCEPTION 'VERIFY C FAILED: %s policy cmd is % (expected ALL)', t, v_cmd;
    END IF;
    SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    IF NOT v_rls THEN RAISE EXCEPTION 'VERIFY C FAILED: RLS not enabled on %', t; END IF;
  END LOOP;
  RAISE NOTICE 'VERIFY C PASSED: all 11 tables carry a RESTRICTIVE FOR ALL operational-farmer policy with RLS on.';
END $$;

-- ── D. storage policy: restrictive + bucket-scoped ──────────────────────────
DO $$
DECLARE v_perm text; v_qual text;
BEGIN
  SELECT permissive, qual INTO v_perm, v_qual
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'farmer buckets: operational farmer or admin';
  IF v_perm IS NULL THEN RAISE EXCEPTION 'VERIFY D FAILED: storage policy missing'; END IF;
  IF v_perm <> 'RESTRICTIVE' THEN RAISE EXCEPTION 'VERIFY D FAILED: storage policy not RESTRICTIVE'; END IF;
  IF v_qual IS NULL OR v_qual NOT LIKE '%farmer-documents%' OR v_qual NOT LIKE '%farmer-photos%' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: storage policy is not scoped to the farmer buckets';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: storage policy is restrictive and bucket-scoped.';
END $$;

-- ── D2. market_price_benchmarks: restrictive FOR SELECT + RLS on ────────────
DO $$
DECLARE v_perm text; v_cmd text; v_rls boolean;
BEGIN
  SELECT permissive, cmd INTO v_perm, v_cmd
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'market_price_benchmarks'
    AND policyname = 'market_price_benchmarks: operational farmer or admin';
  IF v_perm IS NULL THEN RAISE EXCEPTION 'VERIFY D2 FAILED: market_price_benchmarks overlay policy missing'; END IF;
  IF v_perm <> 'RESTRICTIVE' THEN RAISE EXCEPTION 'VERIFY D2 FAILED: policy is % (expected RESTRICTIVE)', v_perm; END IF;
  IF v_cmd <> 'SELECT' THEN RAISE EXCEPTION 'VERIFY D2 FAILED: policy cmd is % (expected SELECT)', v_cmd; END IF;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.market_price_benchmarks'::regclass;
  IF NOT v_rls THEN RAISE EXCEPTION 'VERIFY D2 FAILED: RLS not enabled on market_price_benchmarks'; END IF;
  RAISE NOTICE 'VERIFY D2 PASSED: market_price_benchmarks has a RESTRICTIVE FOR SELECT operational-farmer policy with RLS on.';
END $$;

-- ── E. pre-existing permissive farmer policies untouched ────────────────────
DO $$
DECLARE
  expected text[] := ARRAY[
    'farms|farms: farmer insert own',
    'inventory_batches|inventory_batches: farmer insert own',
    'inventory_batches|inventory_batches: farmer update own',
    'farm_memberships|farm_memberships: farmer insert own',
    'market_price_benchmarks|market_price_benchmarks: farmer select visible'
  ];
  e text; parts text[];
BEGIN
  FOREACH e IN ARRAY expected LOOP
    parts := string_to_array(e, '|');
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = parts[1]
        AND policyname = parts[2] AND permissive = 'PERMISSIVE'
    ) THEN
      RAISE EXCEPTION 'VERIFY E FAILED: pre-existing permissive policy "%" was dropped', parts[2];
    END IF;
  END LOOP;
  RAISE NOTICE 'VERIFY E PASSED: sampled pre-existing permissive farmer policies still present.';
END $$;

-- ── F. behavioural helper check ─────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-a000-000000000121', 'verify21-pending@ddp.test'),
  ('00000000-0000-4000-a000-000000000122', 'verify21-farmer@ddp.test'),
  ('00000000-0000-4000-a000-000000000123', 'verify21-admin@ddp.test');
UPDATE public.profiles SET role = 'farmer'    WHERE id = '00000000-0000-4000-a000-000000000122';
UPDATE public.profiles SET role = 'ddp_admin' WHERE id = '00000000-0000-4000-a000-000000000123';

DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000121"}', true);
  IF public.has_operational_farmer_access() THEN
    RAISE EXCEPTION 'VERIFY F FAILED: pending identity was granted operational farmer access';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000122"}', true);
  IF NOT public.has_operational_farmer_access() THEN
    RAISE EXCEPTION 'VERIFY F FAILED: farmer identity was denied operational farmer access';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000123"}', true);
  IF public.has_operational_farmer_access() THEN
    RAISE EXCEPTION 'VERIFY F FAILED: admin identity unexpectedly reports farmer access';
  END IF;
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'VERIFY F FAILED: admin identity not recognised as ddp_admin';
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: pending denied, farmer allowed, admin admin (not farmer).';
END $$;

ROLLBACK;
