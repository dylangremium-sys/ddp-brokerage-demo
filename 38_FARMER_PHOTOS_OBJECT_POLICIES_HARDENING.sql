-- =============================================================================
-- Migration 38 — farmer-photos object policies
--
-- Split out of migration 37. Read that file's header first; this one only
-- explains why it is separate and what it adds.
--
-- WHY THIS IS ITS OWN MIGRATION
--   The two halves of the original migration 37 required DIFFERENT privileges,
--   and coupling them meant the achievable half could not be applied either.
--
--   Measured in the production Supabase SQL Editor, 2026-07-30:
--
--     running_as                  = postgres
--     has_table_privilege(storage.buckets, INSERT) = true
--     has_table_privilege(storage.buckets, UPDATE) = true
--     owner of storage.objects    = supabase_admin      <-- postgres is NOT a member
--
--   Writing a bucket row is an ordinary INSERT/UPDATE and needs only table
--   privileges. `CREATE POLICY` strictly requires OWNERSHIP of the table. So
--   migration 37 (buckets) can be applied from the SQL Editor today and this one
--   cannot — it needs a role holding `supabase_admin`, or the dashboard's
--   Storage → Policies UI, which performs the change server-side.
--
--   Keeping them in one file would have refused entirely and taken bucket privacy
--   — the security-critical half — down with the half that was blocked.
--
-- WHAT THIS INSTALLS
--   The three object policies `farmer-photos` currently lacks, mirroring the three
--   that migration 8 installed for `farmer-documents` (admin all / farmer read own /
--   farmer upload own).
--
-- CONSEQUENCE OF NOT APPLYING IT
--   RLS is on for storage.objects and `farmer-photos` has no permissive policy, so
--   the bucket is inaccessible to EVERY caller — including admins, because
--   `farmer-documents: admin all` is scoped to the other bucket. That is
--   fail-closed and safe, but photo upload (PR #97) will not work until this lands.
--
-- WHY THESE POLICIES CARRY A ROLE CHECK AND farmer-documents' DO NOT
--   The `farmer-documents` policies gate on the uid path-prefix only. The role
--   check — "is this identity an OPERATIONAL farmer, not merely `pending`?" — comes
--   from migration 22's RESTRICTIVE overlay, which is CONFIRMED ABSENT on
--   production (re-verified read-only 2026-07-30: 3 policies on storage.objects,
--   overlay count 0). A newly created bucket must not inherit a known gap while
--   that is outstanding, so these call
--   public.has_operational_farmer_access() inline. When the overlay is eventually
--   installed it ANDs the same condition on top: redundant, and harmless.
--
--   This migration is NOT a substitute for migration 22's overlay and does not
--   close it. See docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md and runbook P4.
--
-- IDEMPOTENT. Every policy is dropped-if-exists before creation.
--
-- Verify:   38_FARMER_PHOTOS_OBJECT_POLICIES_VERIFY.sql   (read-only; safe on Production)
-- Rollback: 38_FARMER_PHOTOS_OBJECT_POLICIES_ROLLBACK.sql
--
-- Preconditions:
--   * Migration 37 applied — the `farmer-photos` bucket must exist and be private
--   * public.is_ddp_admin()                    (migration 3 / AUTH_RLS_SCHEMA)
--   * public.has_operational_farmer_access()   (migration 22)
--   * The executing role must OWN storage.objects, or hold membership in its owner
--     (measured on production: `supabase_admin`). Neither `postgres` nor `ddp_ro`
--     qualifies — see section 0.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — fail here, with a diagnosis, rather than mid-statement.
--
--    The ownership check names the owner it read from the catalog rather than
--    assuming `supabase_storage_admin`. On this production project the owner is
--    `supabase_admin`; hardcoding the wrong name would send an operator to request
--    access to a role that does not govern the object.
-- -----------------------------------------------------------------------------
DO $preconditions$
DECLARE
  v_owner text;
  v_owner_oid oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ddp_admin'
  ) THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: public.is_ddp_admin() is absent. '
      'Apply migration 3 / AUTH_RLS_SCHEMA.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_operational_farmer_access'
  ) THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: public.has_operational_farmer_access() is absent. '
      'It is created by 22_OPERATIONAL_FARMER_ACCESS_RLS_HARDENING.sql, which must be applied '
      'first. The policies below call it, and a policy referencing a missing function is '
      'created successfully but then denies every caller at evaluation time — a silent '
      'lockout of the farmer-photos bucket.';
  END IF;

  SELECT c.relowner, pg_get_userbyid(c.relowner)
    INTO v_owner_oid, v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage' AND c.relname = 'objects';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: storage.objects does not exist. The Supabase '
      'storage schema must be provisioned before this migration.';
  END IF;

  IF NOT pg_has_role(current_user, v_owner_oid, 'USAGE') THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: current_user "%" is not a member of "%", which owns '
      'storage.objects. CREATE POLICY requires ownership, so the statements below would fail '
      'and roll back this transaction. Re-run as a role holding membership in "%", or create '
      'the three policies through the dashboard Storage -> Policies UI, which performs the '
      'change server-side. See docs/runbooks/P6_APPLY_MIGRATION_37_BUCKET_PRIVACY.md.',
      current_user, v_owner, v_owner;
  END IF;

  -- Migration 37 must have run: these policies are meaningless without the bucket,
  -- and creating them first would leave three policies referring to nothing.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'farmer-photos') THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: the farmer-photos bucket does not exist. Apply '
      'migration 37 first (or create it in the dashboard with "Public bucket" OFF).';
  END IF;

  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'farmer-photos' AND public IS TRUE) THEN
    RAISE EXCEPTION
      'migration 38 precondition failed: the farmer-photos bucket is PUBLIC. Object policies '
      'do not gate reads on a public bucket, so installing them would create the appearance '
      'of access control without the substance. Set public = false first (migration 37).';
  END IF;
END
$preconditions$;

-- -----------------------------------------------------------------------------
-- 1. The three policies.
--
--    NO farmer UPDATE or DELETE policy is created. That matches farmer-documents
--    exactly: under RLS, an operation with no permissive policy is denied. If a
--    product requirement for farmer-initiated photo replacement or removal
--    emerges, it should be added deliberately, in its own migration, with its own
--    reasoning — not inherited by accident here. (Note for whoever picks that up:
--    the 2026-07-26 record shows prior remove() calls silently matched zero
--    objects, so any such change needs a real deletion-enforcement probe, not a
--    cleanup call, as evidence.)
--
--    The uid path-prefix predicate is identical in form to the one already live on
--    farmer-documents, so object layout conventions stay consistent across the two
--    buckets.
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
-- 2. Postcondition, so an operator reading the transcript can see what landed.
-- -----------------------------------------------------------------------------
DO $report$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname LIKE 'farmer-photos:%';

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'migration 38 failed its own postcondition: expected 3 farmer-photos policies, found %.',
      v_count;
  END IF;

  RAISE NOTICE
    'migration 38 applied: 3 farmer-photos object policies installed (admin all / farmer read '
    'own / farmer upload own), each scoped to the bucket and role-checked inline. Migration 22 '
    'storage overlay is NOT installed by this migration and remains outstanding — see '
    'docs/BREAK_GLASS_REQUEST_STORAGE_OVERLAY_22.md.';
END
$report$;

COMMIT;
