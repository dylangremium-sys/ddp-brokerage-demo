-- =============================================================================
-- Migration 27 — ROLLBACK (Evidence digest de-duplication & extraction provenance)
--
-- Reverses ONLY migration 27. It creates nothing, and it touches no object
-- belonging to any other migration. Migration 24's tables, RPCs and triggers,
-- and public.farmer_documents itself, are all left intact — this file removes
-- only the two columns migration 27 added to that table.
--
-- ORDERING REQUIREMENT: run this file BEFORE migration 24's rollback if both are
-- being reversed. Migration 27's RLS policy calls
-- public.can_operationally_access_farm(), which migration 24's rollback drops;
-- reversing 24 first would leave a policy referencing a missing function.
--
-- DATA SAFETY: this rollback destroys two kinds of evidence that cannot be
-- reconstructed —
--
--   * public.document_field_extractions rows. These are append-only records of
--     what was believed about a document, when, and on what basis. Dropping the
--     table erases the provenance trail, not just a derived value.
--   * public.farmer_documents.sha256_hex / sha256_recorded_at. A digest recorded
--     at intake attests to the bytes AS RECEIVED. Once dropped it cannot be
--     recovered by re-hashing: re-hashing proves what the file is now, not what
--     it was when it arrived.
--
-- It therefore REFUSES to run while either exists, unless the operator
-- explicitly opts in by setting:
--
--     SET LOCAL document_extractions.rollback_destructive = 'true';
--
-- That guard makes accidental destruction of provenance data impossible while
-- still leaving a real rollback path for a failed deployment with no live data.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Refuse to destroy live provenance data unless explicitly authorized.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  extraction_count integer := 0;
  digest_count     integer := 0;
  opt_in           text;
BEGIN
  IF to_regclass('public.document_field_extractions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.document_field_extractions' INTO extraction_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'farmer_documents'
      AND column_name = 'sha256_hex'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.farmer_documents WHERE sha256_hex IS NOT NULL'
      INTO digest_count;
  END IF;

  IF extraction_count > 0 OR digest_count > 0 THEN
    BEGIN
      opt_in := current_setting('document_extractions.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 27 refused: % extraction record(s) and % recorded document digest(s) exist. '
        'Both attest to what was received and believed at intake and cannot be reconstructed '
        '(re-hashing proves what a file is now, not what it was when it arrived). To proceed '
        'deliberately, run SET LOCAL document_extractions.rollback_destructive = ''true''; '
        'in the same transaction.',
        extraction_count, digest_count;
    END IF;

    RAISE NOTICE
      'rollback 27: destructive opt-in acknowledged — removing % extraction record(s) and % document digest(s).',
      extraction_count, digest_count;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Policies (dropped before the helper function they reference).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "dfe: admin select all"                  ON public.document_field_extractions;
DROP POLICY IF EXISTS "dfe: operational farmer select own farm" ON public.document_field_extractions;

-- -----------------------------------------------------------------------------
-- 2. Triggers. The append-only trigger must go before DROP TABLE, and the dedup
--    trigger is removed from migration 24's table without altering that table
--    in any other way.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_dfe_append_only ON public.document_field_extractions;
DROP TRIGGER IF EXISTS trg_evidence_attachment_digest_dedup ON public.evidence_request_attachments;

-- -----------------------------------------------------------------------------
-- 3. RPC and lookup function.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_document_field_extraction(text,uuid,text,text,text,numeric,text);
DROP FUNCTION IF EXISTS public.find_document_digest_matches(char);
DROP FUNCTION IF EXISTS public.fn_dfe_append_only();
DROP FUNCTION IF EXISTS public.fn_evidence_attachment_digest_dedup();

-- -----------------------------------------------------------------------------
-- 4. Table. Dropped BEFORE the vocabulary functions below, because its CHECK
--    constraints depend on them.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.document_field_extractions;

-- -----------------------------------------------------------------------------
-- 5. Vocabulary helpers introduced by migration 27.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.document_extraction_field_names();
DROP FUNCTION IF EXISTS public.document_extraction_provenances();

-- -----------------------------------------------------------------------------
-- 6. Indexes on migration 24's attachment table. Only the two this migration
--    created — nothing migration 24 defined is touched.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uniq_evidence_attachments_response_digest;
DROP INDEX IF EXISTS public.idx_evidence_attachments_sha256_hex;

-- -----------------------------------------------------------------------------
-- 7. Columns added to public.farmer_documents, with their constraints and index.
--    The table itself belongs to FARMER_MVP_MIGRATION and is NOT dropped.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_farmer_documents_sha256_hex;

ALTER TABLE public.farmer_documents
  DROP CONSTRAINT IF EXISTS farmer_documents_sha256_pairing_check,
  DROP CONSTRAINT IF EXISTS farmer_documents_sha256_hex_format_check;

ALTER TABLE public.farmer_documents
  DROP COLUMN IF EXISTS sha256_recorded_at,
  DROP COLUMN IF EXISTS sha256_hex;

-- -----------------------------------------------------------------------------
-- 8. Self-verification. The harness's post-rollback hooks check tables,
--    functions, policies and buckets — they cannot see a COLUMN that failed to
--    drop, and a partially-reversed migration must not report success. This
--    block fails the transaction if anything migration 27 created survives, or
--    if anything it must not touch went missing.
-- -----------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  residue text[] := ARRAY[]::text[];
  damage  text[] := ARRAY[]::text[];
  c text;
  i text;
  f text;
BEGIN
  IF to_regclass('public.document_field_extractions') IS NOT NULL THEN
    residue := residue || 'table document_field_extractions';
  END IF;

  FOREACH c IN ARRAY ARRAY['sha256_hex','sha256_recorded_at'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'farmer_documents'
                 AND column_name = c)
    THEN residue := residue || ('column farmer_documents.' || c); END IF;
  END LOOP;

  FOREACH i IN ARRAY ARRAY['uniq_evidence_attachments_response_digest',
                           'idx_evidence_attachments_sha256_hex',
                           'idx_farmer_documents_sha256_hex'] LOOP
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = i)
    THEN residue := residue || ('index ' || i); END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['record_document_field_extraction','find_document_digest_matches',
                           'fn_dfe_append_only','fn_evidence_attachment_digest_dedup',
                           'document_extraction_field_names','document_extraction_provenances'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = f)
    THEN residue := residue || ('function ' || f); END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname IN ('trg_dfe_append_only','trg_evidence_attachment_digest_dedup')
               AND NOT tgisinternal)
  THEN residue := residue || 'trigger (dedup/append-only)'; END IF;

  -- Nothing belonging to another migration may have been removed as collateral.
  IF to_regclass('public.farmer_documents') IS NULL THEN
    damage := damage || 'table farmer_documents (belongs to FARMER_MVP_MIGRATION)';
  END IF;
  IF to_regclass('public.evidence_request_attachments') IS NULL THEN
    damage := damage || 'table evidence_request_attachments (belongs to migration 24)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'trg_evidence_attachment_validate' AND NOT tgisinternal) THEN
    damage := damage || 'trigger trg_evidence_attachment_validate (belongs to migration 24)';
  END IF;

  IF array_length(residue,1) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 27 incomplete — migration-27 object(s) survived: %',
      array_to_string(residue, ', ');
  END IF;
  IF array_length(damage,1) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 27 overreached — object(s) from other migrations removed: %',
      array_to_string(damage, ', ');
  END IF;

  RAISE NOTICE 'rollback 27 complete: every migration-27 object removed; migration 24 and farmer_documents intact.';
END
$selfcheck$;

COMMIT;
