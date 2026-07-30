-- =============================================================================
-- Migration 37 — Storage bucket privacy, asserted in SQL
--
-- THE DEFECT THIS CLOSES
--   The two farmer buckets are not created by any migration. `farmer-documents`
--   is created by a MANUAL Supabase Dashboard step, and the only thing that
--   protects its privacy is a comment addressed to a human —
--   8_COA_UPLOAD_STORAGE_MIGRATION.sql:42:
--
--       -- Do NOT make this bucket public.  All access must go through signed URLs.
--
--   That is an instruction, not a constraint. No SQL anywhere in this repository
--   asserts `public = false` for either farmer bucket, so nothing detects or
--   corrects a bucket that is public — whether set that way on the day it was
--   created, or flipped later by anyone holding Dashboard access. The change
--   leaves no trace in version control and no failing check.
--
--   WHY IT MATTERS MORE THAN A POLICY GAP: on a PUBLIC Supabase bucket, RLS on
--   storage.objects does not gate reads. Objects are served by URL to any
--   caller. A public farmer bucket therefore exposes every COA PDF and every
--   farm photo to anyone holding or guessing a path, and no policy in migration
--   8, 22 or 24 changes that. Privacy of the bucket is the outer boundary; the
--   object policies are only meaningful inside it.
--
--   `farmer-photos` is worse: it is created by no migration, and the 2026-07-26
--   read-only Production verification recorded that it carries NO storage policy
--   at all (docs/MIGRATION_RUNTIME_STATUS.md). Its privacy setting has never
--   been read by anyone — `ddp_ro` lacks USAGE on schema `storage`, so
--   storage.buckets could not be listed. The state is UNMEASURED, which is not
--   the same as safe.
--
-- THE PATTERN THIS COPIES
--   This repository already does the right thing for a bucket it creates itself.
--   24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql:77-79 asserts the state rather
--   than assuming it, and converges an existing bucket rather than trusting it:
--
--       INSERT INTO storage.buckets (id, name, public, file_size_limit)
--       VALUES ('evidence-request-files', ..., false, 104857600)
--       ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = ...;
--
--   The two farmer buckets never received that treatment. This migration gives
--   it to them.
--
-- SCOPE — deliberately narrow
--   1. Assert `public = false` on `farmer-documents` and `farmer-photos`.
--   2. Create `farmer-photos` if it does not exist, private.
--   3. Give `farmer-photos` the object policies it currently lacks.
--
--   It does NOT touch the three existing `farmer-documents` object policies.
--   Those are applied and enforcing on Production; rewriting them here would
--   risk a regression on a live upload path for no gain, and their missing role
--   check is migration 22's job (see below).
--
--   It does NOT install migration 22's RESTRICTIVE overlay. That remains absent
--   from Production and remains the subject of
--   docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md. This migration is not a
--   substitute for it and does not close it.
--
-- WHY THE NEW POLICIES CARRY A ROLE CHECK AND THE OLD ONES DO NOT
--   The `farmer-documents` policies gate on the uid path-prefix only. The role
--   check — "is this identity an OPERATIONAL farmer, not merely `pending`?" —
--   comes from migration 22's RESTRICTIVE overlay, which is confirmed ABSENT on
--   Production. A newly created bucket must not inherit a known gap while that
--   is outstanding, so the checks below call
--   public.has_operational_farmer_access() inline. When migration 22's overlay
--   is eventually installed it ANDs the same condition on top: redundant, and
--   harmless. Fail-closed now beats consistent-with-a-gap now.
--
-- IDEMPOTENT. Safe to re-run: the bucket writes converge, and every policy is
-- dropped-if-exists before creation.
--
-- Verify:   37_STORAGE_BUCKET_PRIVACY_VERIFY.sql   (read-only; safe on Production)
-- Rollback: 37_STORAGE_BUCKET_PRIVACY_ROLLBACK.sql
--
-- Preconditions:
--   * storage.buckets and storage.objects exist (Supabase storage schema)
--   * public.is_ddp_admin()                     (migration 3 / AUTH_RLS_SCHEMA)
--   * public.has_operational_farmer_access()    (migration 22 — present and
--     verified on Production per the 2026-07-26 record, VERIFY A/B/C)
--   * The executing role must hold membership in the owners of storage.buckets
--     and storage.objects (in Supabase: supabase_storage_admin) — see section 0.
--     `ddp_ro` cannot run this migration.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — fail here, with a diagnosis, rather than mid-statement.
--
--    This file is one transaction. A privilege failure at section 2 or 3 would
--    roll back everything and surface as a bare "must be owner of table"
--    error, which is easy to misread as the migration being wrong rather than
--    the role being insufficient. Checking first keeps the diagnosis honest.
--    The owning role is read from the catalog, not hardcoded, so this stays
--    correct if Supabase changes it. pg_has_role() is true for superusers and
--    for any role holding membership in the owner.
-- -----------------------------------------------------------------------------
DO $preconditions$
DECLARE
  v_owner text;
  v_rel   text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin'
  ) THEN
    RAISE EXCEPTION
      'migration 37 precondition failed: public.is_ddp_admin() is absent. '
      'Apply migration 3 / AUTH_RLS_SCHEMA.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_operational_farmer_access'
  ) THEN
    RAISE EXCEPTION
      'migration 37 precondition failed: public.has_operational_farmer_access() is absent. '
      'It is created by 22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql, which must be '
      'applied first. The policies in section 3 call it, and a policy referencing a '
      'missing function would be created but then deny every caller at evaluation time — '
      'a silent lockout of the farmer-photos bucket.';
  END IF;

  FOREACH v_rel IN ARRAY ARRAY['buckets', 'objects'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = v_rel;

    IF v_owner IS NULL THEN
      RAISE EXCEPTION
        'migration 37 precondition failed: storage.% does not exist. The Supabase storage '
        'schema must be provisioned before this migration.', v_rel;
    END IF;

    IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
      RAISE EXCEPTION
        'migration 37 precondition failed: current_user "%" is not a member of "%", which '
        'owns storage.%. The writes in this migration would fail and roll back the whole '
        'transaction. Re-run as a role holding that membership (in Supabase: '
        'supabase_storage_admin). The read-only ddp_ro role cannot apply this migration.',
        current_user, v_owner, v_rel;
    END IF;
  END LOOP;
END
$preconditions$;

-- -----------------------------------------------------------------------------
-- 1. (reserved — no public-schema changes in this migration)
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 2. Assert bucket privacy.
--
--    ON CONFLICT sets ONLY `public`. It deliberately does NOT converge
--    file_size_limit for a bucket that already exists.
--
--    WHY: both farmer buckets were configured by hand and their limits are
--    unknown to this repository. Overwriting a hand-set limit with a guess could
--    silently break COA or photo uploads that currently work — an availability
--    regression introduced by a security migration. `public` is the security
--    property this migration exists to guarantee, so `public` alone is asserted.
--    A newly created bucket gets an explicit limit because there is no existing
--    value to preserve.
--
--    The column list matches 24_EVIDENCE_REQUEST_RESOLUTION_STORAGE.sql:77
--    exactly (id, name, public, file_size_limit). Narrower controls such as
--    allowed_mime_types are deliberately NOT set here: that column's presence
--    varies across storage-schema versions, and a migration that fails on an
--    older substrate is worse than one that leaves a further hardening for a
--    follow-up. Recorded as a known non-inclusion, not an oversight.
-- -----------------------------------------------------------------------------

-- farmer-documents: exists on Production (created by hand per migration 8
-- PART B). This converges its privacy and creates it only if somehow absent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('farmer-documents', 'farmer-documents', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- farmer-photos: may not exist at all. 10 MiB is ample for a phone photo and
-- bounds the damage from an upload loop; it applies only on creation.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('farmer-photos', 'farmer-photos', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false;

-- -----------------------------------------------------------------------------
-- 3. farmer-photos object policies.
--
--    Mirrors the three farmer-documents policies from migration 8 (admin all /
--    farmer read own / farmer upload own), with the role check added inline for
--    the reason given in the header.
--
--    NO farmer UPDATE or DELETE policy is created. That matches farmer-documents
--    exactly: under RLS, an operation with no permissive policy is denied. If a
--    product requirement for farmer-initiated photo replacement or removal
--    emerges, it should be added deliberately, in its own migration, with its
--    own reasoning — not inherited by accident here. (Note for whoever picks
--    that up: the 2026-07-26 record shows prior remove() calls silently matched
--    zero objects, so any such change needs a real deletion-enforcement probe,
--    not a cleanup call, as evidence.)
--
--    The uid path-prefix predicate is byte-identical in form to the one already
--    live on farmer-documents, so object layout conventions stay consistent
--    across the two buckets.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "farmer-photos: admin all" ON storage.objects;
CREATE POLICY "farmer-photos: admin all"
  ON storage.objects
  FOR ALL
  USING      (bucket_id = 'farmer-photos' AND public.is_ddp_admin())
  WITH CHECK (bucket_id = 'farmer-photos' AND public.is_ddp_admin());

DROP POLICY IF EXISTS "farmer-photos: farmer read own" ON storage.objects;
CREATE POLICY "farmer-photos: farmer read own"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'farmer-photos'
    AND (
      public.is_ddp_admin()
      OR (
        public.has_operational_farmer_access()
        AND auth.uid()::text = (string_to_array(name, '/'))[1]
      )
    )
  );

DROP POLICY IF EXISTS "farmer-photos: farmer upload own" ON storage.objects;
CREATE POLICY "farmer-photos: farmer upload own"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'farmer-photos'
    AND public.has_operational_farmer_access()
    AND auth.uid()::text = (string_to_array(name, '/'))[1]
  );

-- -----------------------------------------------------------------------------
-- 4. Report what landed, so an operator reading the transcript can see it.
-- -----------------------------------------------------------------------------
DO $report$
DECLARE
  v_public_count integer;
  v_policy_count integer;
BEGIN
  SELECT count(*) INTO v_public_count
  FROM storage.buckets
  WHERE id IN ('farmer-documents', 'farmer-photos') AND public IS TRUE;

  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname LIKE 'farmer-photos:%';

  IF v_public_count <> 0 THEN
    RAISE EXCEPTION
      'migration 37 failed its own postcondition: % farmer bucket(s) still report public = true '
      'after the converging write. Investigate before committing.', v_public_count;
  END IF;

  IF v_policy_count <> 3 THEN
    RAISE EXCEPTION
      'migration 37 failed its own postcondition: expected 3 farmer-photos policies, found %.',
      v_policy_count;
  END IF;

  RAISE NOTICE
    'migration 37 applied: farmer-documents and farmer-photos are private (public = false); '
    '3 farmer-photos object policies installed. Migration 22 storage overlay is NOT installed '
    'by this migration and remains outstanding — see docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md.';
END
$report$;

COMMIT;
