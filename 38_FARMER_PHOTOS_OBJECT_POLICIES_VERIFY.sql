-- =============================================================================
-- Migration 38 — VERIFY: farmer-photos object policies
--
-- READ-ONLY. Catalog SELECTs only — no auth.users fixture, no DML in any section
-- — so like migration 37's VERIFY, and unlike every other VERIFY in this corpus,
-- it is SAFE TO RUN AGAINST PRODUCTION whole, without extracting a prefix.
--
--   Suggested session guard against Production:
--     PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000"
--
-- NOTE: the Supabase SQL Editor does NOT display RAISE NOTICE output, so a passing
-- run there shows "Success. No rows returned" and confirms nothing. Failures DO
-- surface as errors. For a readable check in that environment use the table-
-- returning queries in docs/runbooks/P6_APPLY_MIGRATION_37_BUCKET_PRIVACY.md Step 3.
--
-- Sections:
--   A — the three policies exist, with the correct SHAPE (not merely present)
--   B — RLS is enabled on storage.objects, or the policies are decoration
--   C — informational: migration 22's overlay, reported but NOT asserted
--
-- Expected on success: two PASSED notices (A, B), one informational NOTICE (C).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Presence AND shape.
--
--    Presence alone is insufficient. A policy that exists but omits the role check,
--    or whose upload check is not bound to the uid path prefix, would satisfy a
--    naive count while leaving the bucket open to a `pending` identity or to one
--    farmer writing under another's prefix.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  r          record;
  v_count    integer := 0;
  v_problems text[]  := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT policyname, permissive, cmd,
           coalesce(qual, '')       AS qual,
           coalesce(with_check, '') AS with_check
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN (
        'farmer-photos: admin all',
        'farmer-photos: farmer read own',
        'farmer-photos: farmer upload own'
      )
  LOOP
    v_count := v_count + 1;

    IF r.permissive <> 'PERMISSIVE' THEN
      v_problems := array_append(v_problems,
        format('%s is %s, expected PERMISSIVE', r.policyname, r.permissive));
    END IF;

    IF (r.qual || r.with_check) NOT LIKE '%farmer-photos%' THEN
      v_problems := array_append(v_problems,
        format('%s does not scope to the farmer-photos bucket', r.policyname));
    END IF;

    -- The two farmer-facing policies must carry the operational-farmer role check.
    -- The admin policy legitimately does not — it gates on is_ddp_admin().
    IF r.policyname <> 'farmer-photos: admin all'
       AND (r.qual || r.with_check) NOT LIKE '%has_operational_farmer_access%'
    THEN
      v_problems := array_append(v_problems,
        format('%s omits has_operational_farmer_access() — a pending identity would pass',
               r.policyname));
    END IF;

    IF r.policyname = 'farmer-photos: farmer upload own'
       AND r.with_check NOT LIKE '%string_to_array%'
    THEN
      v_problems := array_append(v_problems,
        format('%s WITH CHECK lacks the uid path-prefix predicate — one farmer could write '
               || 'under another''s prefix', r.policyname));
    END IF;
  END LOOP;

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: expected 3 farmer-photos policies on storage.objects, found %. '
      'Migration 38 has not been applied, or a policy was dropped. Note that RLS is on, so '
      'a partial policy set means the bucket is inaccessible rather than over-exposed.', v_count;
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: 3 farmer-photos policies present, bucket-scoped, role-checked, and upload is prefix-bound.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. RLS must be on, or everything above is decoration.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: storage.objects does not exist.';
  END IF;

  IF NOT v_enabled THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: RLS is DISABLED on storage.objects. Every policy verified above is '
      'inert while that is true.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: RLS is enabled on storage.objects.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Informational — migration 22's RESTRICTIVE overlay.
--
--    Reported, NOT asserted. Migration 38 does not install it and must not fail
--    because it is absent; conflating the two would let a green run here be
--    misread as "the storage gap is closed".
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_present boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'farmer buckets: operational farmer or admin'
  ) INTO v_present;

  IF v_present THEN
    RAISE NOTICE 'VERIFY C (informational): migration 22 storage overlay IS present on this database.';
  ELSE
    RAISE NOTICE
      'VERIFY C (informational): migration 22 storage overlay is ABSENT. Migration 38 does not '
      'install it and this is NOT a migration-38 failure — see runbook P4 and '
      'docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md. farmer-documents therefore still lacks a '
      'role check on its own policies, while farmer-photos does not.';
  END IF;
END
$verify_c$;
