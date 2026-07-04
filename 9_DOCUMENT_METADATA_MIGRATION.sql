-- ============================================================================
-- 9_DOCUMENT_METADATA_MIGRATION.sql
-- Date: 2026-07-04
--
-- Adds document-vault metadata columns to inventory_batches (file size,
-- verification hash, signatory authority, certificate issued date) for the
-- institutional Document Vault display (DocumentCard component).
--
-- PIC/S certification does NOT require a migration — it is stored as a new
-- key inside the existing farm_profiles.licenses JSONB column alongside
-- gmp_cert/gacp_cert and needs no schema change.
--
-- Purely additive, nullable columns — safe to run at any time, fully
-- reversible by simply no longer reading them (see rollback at bottom).
--
-- Do NOT run SQL automatically.
-- ============================================================================

ALTER TABLE public.inventory_batches
  ADD COLUMN IF NOT EXISTS coa_file_size_bytes     bigint,
  ADD COLUMN IF NOT EXISTS coa_verification_hash   text,
  ADD COLUMN IF NOT EXISTS coa_signatory_authority text,
  ADD COLUMN IF NOT EXISTS coa_issued_date         text;

-- Verification — expect 4 rows:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'inventory_batches'
  AND column_name  IN ('coa_file_size_bytes','coa_verification_hash','coa_signatory_authority','coa_issued_date');


-- ============================================================================
-- ROLLBACK (manual, only if needed — additive nullable columns are safe to
-- leave in place indefinitely; the app simply stops reading them otherwise)
-- ============================================================================
-- ALTER TABLE public.inventory_batches
--   DROP COLUMN IF EXISTS coa_file_size_bytes,
--   DROP COLUMN IF EXISTS coa_verification_hash,
--   DROP COLUMN IF EXISTS coa_signatory_authority,
--   DROP COLUMN IF EXISTS coa_issued_date;
