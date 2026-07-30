-- =============================================================================
-- Migration 37 — VERIFY: storage bucket privacy
--
-- READ-ONLY. This file is unusual in this corpus and deliberately so: it
-- executes only catalog SELECTs. It builds no auth.users fixture, inserts
-- nothing, and performs no DML in any section — so unlike every other VERIFY
-- script here, it is SAFE TO RUN AGAINST PRODUCTION under the change freeze,
-- whole, without extracting a read-only prefix. It can be run as any role that
-- can read storage.buckets and pg_policies.
--
--   Suggested session guard when pointing it at Production:
--     PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000"
--
-- NOTE ON ROLE VISIBILITY: `ddp_ro` lacks USAGE on schema `storage`, which is
-- exactly why the privacy of these buckets has never been measured. Section A
-- therefore fails LOUDLY if it cannot read storage.buckets, rather than
-- reporting zero rows as though the buckets were absent. A permission error and
-- a missing bucket are different findings and must not look alike.
--
-- Sections:
--   A — both farmer buckets exist and are PRIVATE (the migration's whole point)
--   B — farmer-photos carries its three object policies, with correct shape
--   C — RLS is enabled on storage.objects
--   D — informational: migration 22's overlay, reported but NOT asserted
--
-- Expected on success: three PASSED notices (A, B, C), one informational NOTICE (D),
-- and no exception.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Bucket privacy — the assertion this migration exists to make.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_can_read  boolean;
  v_docs      boolean;
  v_photos    boolean;
  v_missing   text[] := ARRAY[]::text[];
  v_public    text[] := ARRAY[]::text[];
BEGIN
  -- Distinguish "cannot see" from "not there". Without this, a role lacking
  -- USAGE on schema storage would report both buckets missing, which reads as a
  -- much worse (and false) finding.
  BEGIN
    PERFORM 1 FROM storage.buckets LIMIT 1;
    v_can_read := true;
  EXCEPTION
    WHEN insufficient_privilege THEN v_can_read := false;
    WHEN undefined_table       THEN v_can_read := false;
  END;

  IF NOT v_can_read THEN
    RAISE EXCEPTION
      'VERIFY A INCONCLUSIVE: cannot read storage.buckets as "%". This is NOT evidence that '
      'the buckets are absent or public — it is evidence that this role cannot see them. '
      'Re-run as a role holding USAGE on schema storage. (ddp_ro does not.)', current_user;
  END IF;

  SELECT public INTO v_docs   FROM storage.buckets WHERE id = 'farmer-documents';
  SELECT public INTO v_photos FROM storage.buckets WHERE id = 'farmer-photos';

  IF v_docs   IS NULL THEN v_missing := array_append(v_missing, 'farmer-documents'); END IF;
  IF v_photos IS NULL THEN v_missing := array_append(v_missing, 'farmer-photos');    END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: bucket(s) absent: %. Migration 37 creates both; it has not been applied '
      'to this database.', array_to_string(v_missing, ', ');
  END IF;

  -- The core check. `public IS TRUE` is deliberate: a NULL public column is not
  -- treated as private-by-assumption, it is caught by the branch below.
  IF v_docs   IS TRUE THEN v_public := array_append(v_public, 'farmer-documents'); END IF;
  IF v_photos IS TRUE THEN v_public := array_append(v_public, 'farmer-photos');    END IF;

  IF array_length(v_public, 1) > 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED — PUBLIC BUCKET(S): %. On a public Supabase bucket, RLS on '
      'storage.objects does NOT gate reads: every object is served by URL to any caller. '
      'Every COA and farm photo in that bucket is readable by anyone holding a path. '
      'Treat as a live incident, not a migration defect.', array_to_string(v_public, ', ');
  END IF;

  IF v_docs IS NOT FALSE OR v_photos IS NOT FALSE THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: bucket privacy is not explicitly false (farmer-documents=%, '
      'farmer-photos=%). A NULL is not a guarantee; migration 37 sets it to false explicitly.',
      coalesce(v_docs::text, 'NULL'), coalesce(v_photos::text, 'NULL');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: farmer-documents and farmer-photos both exist and are PRIVATE (public = false).';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. farmer-photos object policies — presence AND shape.
--
--    Presence alone is insufficient: a policy that exists but omits the role
--    check, or whose WITH CHECK is weaker than its USING, would pass a naive
--    count and still leave the bucket open to a `pending` identity.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  r            record;
  v_count      integer := 0;
  v_problems   text[]  := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT policyname, permissive, cmd, coalesce(qual, '') AS qual,
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
      v_problems := array_append(v_problems, format('%s is %s, expected PERMISSIVE', r.policyname, r.permissive));
    END IF;

    IF (r.qual || r.with_check) NOT LIKE '%farmer-photos%' THEN
      v_problems := array_append(v_problems, format('%s does not scope to the farmer-photos bucket', r.policyname));
    END IF;

    -- The two farmer-facing policies must carry the operational-farmer role
    -- check. The admin policy legitimately does not.
    IF r.policyname <> 'farmer-photos: admin all'
       AND (r.qual || r.with_check) NOT LIKE '%has_operational_farmer_access%'
    THEN
      v_problems := array_append(v_problems,
        format('%s omits has_operational_farmer_access() — a pending identity would pass', r.policyname));
    END IF;

    -- Uploads must be constrained by the uid path prefix, not merely by role,
    -- or one farmer could write under another farmer's prefix.
    IF r.policyname = 'farmer-photos: farmer upload own'
       AND r.with_check NOT LIKE '%string_to_array%'
    THEN
      v_problems := array_append(v_problems,
        format('%s WITH CHECK lacks the uid path-prefix predicate', r.policyname));
    END IF;
  END LOOP;

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: expected 3 farmer-photos policies on storage.objects, found %. '
      'Migration 37 section 3 has not been applied, or a policy was dropped.', v_count;
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: 3 farmer-photos policies present, bucket-scoped, role-checked, and upload is prefix-bound.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. RLS must be enabled on storage.objects, or every policy above is decoration.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: storage.objects does not exist.';
  END IF;

  IF NOT v_enabled THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: RLS is DISABLED on storage.objects. Every policy verified above is '
      'inert while that is true.';
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: RLS is enabled on storage.objects.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Informational only — migration 22's RESTRICTIVE overlay.
--
--    Reported, NOT asserted. Migration 37 does not install it and must not fail
--    because it is absent; conflating the two would let a green run here be
--    misread as "the storage gap is closed". Its absence on Production is a
--    separate, tracked finding.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_present boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'farmer buckets: operational farmer or admin'
  ) INTO v_present;

  IF v_present THEN
    RAISE NOTICE 'VERIFY D (informational): migration 22 storage overlay IS present on this database.';
  ELSE
    RAISE NOTICE
      'VERIFY D (informational): migration 22 storage overlay is ABSENT on this database. '
      'Migration 37 does not install it. This is NOT a migration-37 failure — see '
      'docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md. Note that farmer-documents therefore '
      'still lacks a role check on its own policies, while farmer-photos does not.';
  END IF;
END
$verify_d$;
