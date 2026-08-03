-- =============================================================================
-- Migration 52 — ROLLBACK (COA multi-report grouping)
--
-- Restores the database to its migration-51 shape: the two grouping columns and
-- their constraints and indexes are dropped, and
-- record_document_field_extraction is cut back to migration 28's exact
-- seven-argument definition.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 52_COA_REPORT_GROUPING_ROLLBACK.sql
--
-- ─── THIS ROLLBACK DESTROYS DATA, AND SAYS SO ───────────────────────────────
-- DROP COLUMN discards every report_ordinal and report_label ever recorded.
-- The field values themselves survive — they are separate columns — but their
-- attribution to a particular report inside a multi-report document does not,
-- and it cannot be reconstructed afterwards. A document whose pack was split
-- across five reports reverts to an undifferentiated heap of nineteen field
-- names, which is the pre-52 defect, restored faithfully.
--
-- So this is safe to run on a database where migration 52 has been applied but
-- no multi-report extraction has been persisted, and lossy on any other. Check
-- before running:
--
--     SELECT count(*) FROM public.document_field_extractions
--      WHERE report_ordinal IS NOT NULL;
--
-- The append-only trigger (migration 28 §3.6) blocks UPDATE and DELETE on rows,
-- not ALTER TABLE, so the DROP COLUMN below is not obstructed by it. That is
-- worth stating plainly: the table's immutability guarantee is about row
-- content under DML, and a schema change is outside it.
-- =============================================================================

BEGIN;

-- ─── 1. Restore migration 28's write path ───────────────────────────────────
--
-- The nine-argument version is dropped FIRST. Recreating the seven-argument one
-- while the nine-argument one still existed would leave both resolvable, and a
-- seven-argument call would then be ambiguous — PostgreSQL would raise
-- "function is not unique" and every write would fail. Order is load-bearing.

DROP FUNCTION IF EXISTS public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text);

-- Restated verbatim from 28_EVIDENCE_DIGEST_DEDUP_HARDENING.sql §3.7. Any
-- divergence here is a silent, permanent change to the one sanctioned write
-- path, applied under the name "rollback".
CREATE FUNCTION public.record_document_field_extraction(
  p_document_surface   text,
  p_document_id        uuid,
  p_field_name         text,
  p_field_value_text   text,
  p_provenance         text,
  p_confidence         numeric DEFAULT NULL,
  p_extraction_warning text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'record_document_field_extraction: admin role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_document_surface = 'farmer_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.farmer_documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extraction: farmer_document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text,
       provenance, confidence, extraction_warning, recorded_by_user_id)
    VALUES ('farmer_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid())
    RETURNING id INTO new_id;

  ELSIF p_document_surface = 'inventory_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extraction: document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO public.document_field_extractions
      (document_surface, inventory_document_id, field_name, field_value_text,
       provenance, confidence, extraction_warning, recorded_by_user_id)
    VALUES ('inventory_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid())
    RETURNING id INTO new_id;

  ELSE
    RAISE EXCEPTION
      'record_document_field_extraction: unknown document_surface "%" '
      '(expected farmer_document or inventory_document)', p_document_surface
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN new_id;
END
$$;

-- Migration 28 §4's privileges, restored with it. A recreate without these
-- leaves EXECUTE at PUBLIC.
REVOKE EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text) TO authenticated, service_role;

-- ─── 2. Drop the indexes ────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_dfe_farmer_document_report;
DROP INDEX IF EXISTS public.idx_dfe_inventory_document_report;

-- ─── 3. Drop the constraints and columns ────────────────────────────────────
--
-- The constraints go first and explicitly. DROP COLUMN would take them with it,
-- but naming them makes the residue check below meaningful: if a constraint
-- somehow survives its column, that is a state worth failing on rather than
-- inferring.

ALTER TABLE public.document_field_extractions
  DROP CONSTRAINT IF EXISTS dfe_report_label_needs_ordinal_check;

ALTER TABLE public.document_field_extractions
  DROP CONSTRAINT IF EXISTS dfe_report_ordinal_positive_check;

ALTER TABLE public.document_field_extractions
  DROP COLUMN IF EXISTS report_label;

ALTER TABLE public.document_field_extractions
  DROP COLUMN IF EXISTS report_ordinal;

-- ─── 4. Residue check ───────────────────────────────────────────────────────
--
-- Migration 28's rollback ends the same way. An exit code of 0 proves psql
-- reached the end of the file, not that the database is in the intended state;
-- this is what makes the difference between those two things visible.

DO $residue$
DECLARE
  residue text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'document_field_extractions'
               AND column_name IN ('report_ordinal','report_label')) THEN
    residue := residue || 'column report_ordinal/report_label';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.document_field_extractions'::regclass
               AND conname IN ('dfe_report_ordinal_positive_check',
                               'dfe_report_label_needs_ordinal_check')) THEN
    residue := residue || 'constraint dfe_report_*';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
               AND indexname IN ('idx_dfe_farmer_document_report',
                                 'idx_dfe_inventory_document_report')) THEN
    residue := residue || 'index idx_dfe_*_report';
  END IF;

  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)'
     ) IS NOT NULL THEN
    residue := residue || 'function record_document_field_extraction(...,integer,text)';
  END IF;

  -- The restored function must be back, and be the only one.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text)'
     ) IS NULL THEN
    residue := residue || 'MISSING restored 7-arg record_document_field_extraction';
  END IF;

  IF array_length(residue, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 52 INCOMPLETE — %', array_to_string(residue, ', ');
  END IF;

  RAISE NOTICE 'ROLLBACK 52 complete — migration 51 shape restored.';
END
$residue$;

COMMIT;
