-- =============================================================================
-- Migration 53 — ROLLBACK (batch COA extraction write)
--
-- Removes the batch write path and its key vocabulary, leaving migration 52's
-- single-row `record_document_field_extraction` as the only writer — which is
-- the state migration 53 found.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 53_COA_BATCH_EXTRACTION_WRITE_ROLLBACK.sql
--
-- ─── THIS ROLLBACK DESTROYS NO DATA ─────────────────────────────────────────
-- Migration 53 added no column and no constraint; it added two functions. Every
-- row written through the batch path is an ordinary row of
-- document_field_extractions, indistinguishable from one written through the
-- single-row path and unaffected by dropping the function that inserted it.
--
-- ─── WHAT REVERTS WITH IT, AND IT IS NOT NOTHING ────────────────────────────
-- The atomicity guarantee goes with the function. Any caller rolled back to the
-- per-row loop can once again half-write a pack, and pays one HTTP round trip
-- per field. That is a behavioural regression, not merely the removal of a
-- convenience, and the application code must be rolled back with it — an
-- application still calling record_document_field_extractions_batch after this
-- runs receives PostgREST's "function not found" and every extraction fails
-- closed.
--
-- Fail-closed is the right failure here, and it is worth being explicit that it
-- IS the failure mode: nothing silently reverts to writing rows one at a time.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.record_document_field_extractions_batch(text,uuid,jsonb);
DROP FUNCTION IF EXISTS public.document_extraction_batch_row_keys();

-- ─── Residue check ──────────────────────────────────────────────────────────
--
-- An exit code of 0 proves psql reached the end of the file, not that the
-- database is in the intended state. This is what makes the difference between
-- those two things visible.

DO $residue$
DECLARE
  residue text[] := ARRAY[]::text[];
BEGIN
  IF to_regprocedure('public.record_document_field_extractions_batch(text,uuid,jsonb)') IS NOT NULL THEN
    residue := residue || 'function record_document_field_extractions_batch(text,uuid,jsonb)';
  END IF;

  IF to_regprocedure('public.document_extraction_batch_row_keys()') IS NOT NULL THEN
    residue := residue || 'function document_extraction_batch_row_keys()';
  END IF;

  -- Migration 52's writer must STILL BE THERE. Rolling back 53 must leave a
  -- system that can still record an extraction; if this is missing, the
  -- rollback has left the feature with no write path at all.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)'
     ) IS NULL THEN
    residue := residue || 'MISSING migration 52 single-row record_document_field_extraction — no write path survives';
  END IF;

  -- The table and its columns are migration 28's and 52's, and must be untouched.
  IF to_regclass('public.document_field_extractions') IS NULL THEN
    residue := residue || 'MISSING table document_field_extractions';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'document_field_extractions'
                   AND column_name = 'report_ordinal') THEN
    residue := residue || 'MISSING column report_ordinal — migration 52 was damaged by this rollback';
  END IF;

  IF array_length(residue, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 53 INCOMPLETE — %', array_to_string(residue, ', ');
  END IF;

  RAISE NOTICE 'ROLLBACK 53 complete — batch writer removed, migration 52 single-row path intact.';
END
$residue$;

COMMIT;
