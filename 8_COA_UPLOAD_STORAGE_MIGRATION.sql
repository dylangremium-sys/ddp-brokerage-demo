-- ============================================================================
-- 8_COA_UPLOAD_STORAGE_MIGRATION.sql
-- Date: 2026-06-30
--
-- Enables real COA file upload via Supabase Storage.
--
-- PART A  — Database column (apply first, safe to run any time)
-- PART B  — Storage bucket creation (manual Supabase Dashboard step)
-- PART C  — Storage RLS policies (apply AFTER bucket exists)
--
-- Do NOT run SQL automatically.
-- ============================================================================


-- ============================================================================
-- PART A: Add coa_storage_path column to inventory_batches
-- Stores the object path within the farmer-documents bucket.
-- Used to generate signed URLs for secure COA viewing.
-- ============================================================================

ALTER TABLE public.inventory_batches
  ADD COLUMN IF NOT EXISTS coa_storage_path text;

-- Verification — expect a row for coa_storage_path:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'inventory_batches'
  AND column_name  = 'coa_storage_path';


-- ============================================================================
-- PART B: Storage bucket creation — MANUAL STEP (no SQL equivalent)
-- ============================================================================
-- In Supabase Dashboard → Storage → New bucket:
--
--   Bucket name:  farmer-documents
--   Public:       NO (private)
--   Max file size: 10 MB
--   Allowed MIME types: application/pdf
--
-- Do NOT make this bucket public.  All access must go through signed URLs.
-- ============================================================================


-- ============================================================================
-- PART C: Storage RLS policies
-- Apply in Supabase → SQL Editor AFTER the farmer-documents bucket exists.
-- The policies use is_ddp_admin() which is defined in AUTH_RLS_SCHEMA.sql.
-- ============================================================================

-- Admin: full access to all objects in the bucket.
DROP POLICY IF EXISTS "farmer-documents: admin all" ON storage.objects;
CREATE POLICY "farmer-documents: admin all"
  ON storage.objects FOR ALL
  USING    (bucket_id = 'farmer-documents' AND is_ddp_admin())
  WITH CHECK (bucket_id = 'farmer-documents' AND is_ddp_admin());

-- Farmer upload: path must start with the farmer's own auth.uid().
-- Storage path pattern: {userId}/{farmId}/{batchId}/{timestamp}-{filename}.pdf
DROP POLICY IF EXISTS "farmer-documents: farmer upload own" ON storage.objects;
CREATE POLICY "farmer-documents: farmer upload own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'farmer-documents'
    AND auth.uid()::text = (string_to_array(name, '/'))[1]
  );

-- Farmer read: only files under their own UID prefix.
DROP POLICY IF EXISTS "farmer-documents: farmer read own" ON storage.objects;
CREATE POLICY "farmer-documents: farmer read own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'farmer-documents'
    AND (
      is_ddp_admin()
      OR auth.uid()::text = (string_to_array(name, '/'))[1]
    )
  );

-- Verification — expect 3 rows for bucket_id = 'farmer-documents':
SELECT policyname, cmd
FROM pg_policies
WHERE tablename = 'objects'
  AND schemaname = 'storage'
  AND policyname LIKE 'farmer-documents%'
ORDER BY policyname;
