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
--   B — informational: farmer-photos object policies (migration 38, NOT asserted here)
--   C — RLS is enabled on storage.objects
--   D — informational: migration 22's overlay, reported but NOT asserted
--
-- Expected on success: two PASSED notices (A, C) and two informational NOTICEs
-- (B, D), with no exception.
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
-- B. farmer-photos object policies — INFORMATIONAL ONLY.
--
--    Migration 37 no longer installs these; they are migration 38, which requires
--    ownership of storage.objects. Reported, never asserted: failing here would
--    make migration 37 un-verifiable on a database where it is correctly and
--    completely applied, which is how a real gate gets disabled by whoever hits
--    the false failure first.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname LIKE 'farmer-photos:%';

  IF v_count > 0 THEN
    RAISE NOTICE
      'VERIFY B (informational): % policy/policies govern farmer-photos — migration 38 is applied '
      'here by some route. The count varies by route: the migration creates 3 (one FOR ALL admin), '
      'the Supabase dashboard creates 6 (it splits FOR ALL into one policy per operation). Run '
      '38_..._VERIFY.sql for the assertion.', v_count;
  ELSE
    RAISE NOTICE
      'VERIFY B (informational): farmer-photos has NO object policies. Expected until '
      'migration 38 is applied. RLS is on, so the bucket is inaccessible to every caller '
      '— fail-closed, but photo upload will not work until 38 lands. NOT a migration-37 failure.';
  END IF;
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
