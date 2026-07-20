-- 22_OPERATIONAL_FARMER_ACCESS_RLS_VERIFY.sql
-- =============================================================================
-- Proves migration 22 is correctly applied. Fully transactional; ends in
-- ROLLBACK, so it leaves NO residue. Run AFTER the hardening migration.
--
-- Proves (static, via catalogs):
--   A. helper exists: SECURITY DEFINER, STABLE, safe search_path
--   B. helper is NOT executable by anon; IS executable by authenticated
--   C. every required table has the restrictive "operational farmer or admin"
--      policy, AS RESTRICTIVE, FOR ALL, RLS enabled, AND both USING and
--      WITH CHECK actually gate on the helper (not a USING(true) no-op)
--   D. storage policy exists, is restrictive, is bucket-scoped, and its
--      WITH CHECK matches its USING (so uploads are guarded, not just reads)
--   E. no pre-existing permissive farmer policy was dropped
-- Proves (behavioural, via seeded identities):
--   F. pending identity => helper false; farmer identity => helper true;
--      admin identity => is_ddp_admin true, helper false
--   G. ENFORCEMENT: as the `authenticated` role, a farmer INSERT into
--      public.farms is admitted (control) and the identical pending INSERT is
--      denied. C-F all pass against a policy that blocks nothing; only G fails.
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
  v_perm text; v_cmd text; v_rls boolean; v_qual text; v_check text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT permissive, cmd, qual, with_check INTO v_perm, v_cmd, v_qual, v_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
      AND policyname = t || ': operational farmer or admin';
    IF v_perm IS NULL THEN
      RAISE EXCEPTION 'VERIFY C FAILED: % missing the operational-farmer restrictive policy', t;
    END IF;
    IF v_perm <> 'RESTRICTIVE' THEN
      RAISE EXCEPTION 'VERIFY C FAILED: % policy is % (expected RESTRICTIVE)', t, v_perm;
    END IF;
    IF v_cmd <> 'ALL' THEN
      RAISE EXCEPTION 'VERIFY C FAILED: % policy cmd is % (expected ALL)', t, v_cmd;
    END IF;
    -- The EFFECTIVE PREDICATE, not just the policy's shape. Without these two
    -- checks a policy created as `AS RESTRICTIVE FOR ALL USING (true) WITH CHECK
    -- (true)` — a complete no-op — passes every other assertion in this section.
    IF v_qual IS NULL
       OR v_qual NOT LIKE '%has_operational_farmer_access%'
       OR v_qual NOT LIKE '%is_ddp_admin%' THEN
      RAISE EXCEPTION
        'VERIFY C FAILED: % policy USING does not gate on has_operational_farmer_access()/is_ddp_admin() (got: %)',
        t, coalesce(v_qual, '<null>');
    END IF;
    IF v_check IS NULL
       OR v_check NOT LIKE '%has_operational_farmer_access%'
       OR v_check NOT LIKE '%is_ddp_admin%' THEN
      RAISE EXCEPTION
        'VERIFY C FAILED: % policy WITH CHECK does not gate on has_operational_farmer_access()/is_ddp_admin() (got: %)',
        t, coalesce(v_check, '<null>');
    END IF;
    SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    IF NOT v_rls THEN RAISE EXCEPTION 'VERIFY C FAILED: RLS not enabled on %', t; END IF;
  END LOOP;
  RAISE NOTICE 'VERIFY C PASSED: all 11 tables carry a RESTRICTIVE FOR ALL operational-farmer policy, gating on the helper in BOTH USING and WITH CHECK, with RLS on.';
END $$;

-- ── D. storage policy: restrictive + bucket-scoped ──────────────────────────
DO $$
DECLARE v_perm text; v_qual text; v_check text;
BEGIN
  SELECT permissive, qual, with_check INTO v_perm, v_qual, v_check
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'farmer buckets: operational farmer or admin';
  IF v_perm IS NULL THEN RAISE EXCEPTION 'VERIFY D FAILED: storage policy missing'; END IF;
  IF v_perm <> 'RESTRICTIVE' THEN RAISE EXCEPTION 'VERIFY D FAILED: storage policy not RESTRICTIVE'; END IF;
  IF v_qual IS NULL OR v_qual NOT LIKE '%farmer-documents%' OR v_qual NOT LIKE '%farmer-photos%' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: storage policy USING is not scoped to the farmer buckets';
  END IF;
  IF v_qual NOT LIKE '%has_operational_farmer_access%' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: storage policy USING does not gate on has_operational_farmer_access()';
  END IF;
  -- WITH CHECK governs uploads. A policy with a correct USING and a missing or
  -- inverted WITH CHECK would leave pending WRITES unguarded while passing every
  -- read-side assertion above.
  IF v_check IS NULL
     OR v_check NOT LIKE '%farmer-documents%'
     OR v_check NOT LIKE '%farmer-photos%'
     OR v_check NOT LIKE '%has_operational_farmer_access%' THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: storage policy WITH CHECK is missing or does not match the USING predicate (got: %)',
      coalesce(v_check, '<null>');
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: storage policy is restrictive, bucket-scoped, and guards reads AND writes.';
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

-- ── G. behavioural POLICY ENFORCEMENT (the overlay actually blocks a write) ──
--
-- Sections C/D/D2 read the catalog; section F reads a boolean. None of them
-- proves a policy denies anything. This section performs the real write.
--
-- The design point is the CONTROL: the farmer identity inserts the SAME row
-- first. Its success proves the permissive ownership policy admits the write,
-- so the pending denial that follows is attributable to the restrictive overlay
-- rather than to a missing grant, a NOT NULL column, or a CHECK constraint —
-- the exact ambiguity that makes a bare "it was denied" result worthless.
--
-- Runs as the `authenticated` role because RLS is bypassed for a table owner
-- unless FORCE ROW LEVEL SECURITY is set; as the owner these inserts would both
-- succeed and prove nothing. Everything is undone by the ROLLBACK at end of file.
DO $$
DECLARE
  v_pending uuid := '00000000-0000-4000-a000-000000000121';
  v_farmer  uuid := '00000000-0000-4000-a000-000000000122';
  v_farm_id uuid;
  v_denied  boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;

  -- CONTROL: farmer identity must be admitted.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_farmer)::text, true);
  INSERT INTO public.farms (farm_name, created_by)
  VALUES ('verify22-control-farmer', v_farmer)
  RETURNING id INTO v_farm_id;

  IF v_farm_id IS NULL THEN
    RESET ROLE;
    RAISE EXCEPTION
      'VERIFY G FAILED: the farmer identity could not insert into public.farms, so the '
      'pending denial below would be unattributable. Control invalid.';
  END IF;

  -- SUBJECT: the identical write as a pending identity must be denied by the overlay.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pending)::text, true);
  BEGIN
    INSERT INTO public.farms (farm_name, created_by)
    VALUES ('verify22-subject-pending', v_pending);
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_denied := true;
    WHEN others THEN
      RESET ROLE;
      RAISE EXCEPTION
        'VERIFY G INCONCLUSIVE: the pending insert failed with SQLSTATE % (%) — that is not an '
        'RLS denial, so this section did not test the overlay.', SQLSTATE, SQLERRM;
  END;

  RESET ROLE;

  IF NOT v_denied THEN
    RAISE EXCEPTION
      'VERIFY G FAILED: a pending identity successfully INSERTed into public.farms. The '
      'restrictive overlay is present in the catalog but is NOT enforcing.';
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: farmer insert admitted; the identical pending insert was denied by the overlay.';
END $$;

ROLLBACK;
