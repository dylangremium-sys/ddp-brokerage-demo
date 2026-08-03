-- =============================================================================
-- 52_COA_REPORT_GROUPING_HARDENING.sql
--
-- Records WHICH laboratory report inside a document a field value came from.
--
-- Depends on migration 28 (document_field_extractions,
-- record_document_field_extraction, document_extraction_field_names).
--
--   • Rollback: 52_COA_REPORT_GROUPING_ROLLBACK.sql
--   • Verify:   52_COA_REPORT_GROUPING_VERIFY.sql
--
-- WHAT WAS WRONG
-- Migration 28 stores 'report_number' as a FIELD NAME — one row among nineteen
-- permitted names — and not as a grouping key. That is correct for a document
-- holding one report and silently wrong for a document holding several.
--
-- A Thai COA pack is routinely five reports in one PDF. Extracting it produced,
-- against a single document row:
--
--     field_name='sample_name'   → 'Gelato'
--     field_name='sample_name'   → 'Jell Breath'
--     field_name='total_thc'     → '24.5'
--     field_name='total_thc'     → '19.8'
--     field_name='report_number' → 'TH-2411-0031'
--     field_name='report_number' → 'TH-2411-0032'
--
-- with nothing whatsoever tying 'Gelato' to '24.5' to 'TH-2411-0031'. Migration
-- 28 §3.3 defines the current value of a field as "its most recent row by
-- extracted_at", so reading that document back yields exactly ONE strain name
-- and ONE THC figure, chosen by insertion order. Four reports vanish and the
-- survivor is arbitrary.
--
-- This is a data-integrity defect of the worst kind for this product: it does
-- not fail, it answers. A buyer pack would carry one strain's cannabinoid
-- figures under another strain's batch reference, with full provenance metadata
-- attesting that a machine read it off the certificate.
--
-- The extraction step never had this bug — it returns reports as distinct
-- objects. The defect is entirely in the write path, which is why no amount of
-- re-running the extractor surfaces it. It has never been observed in the wild
-- for the narrow reason that migration 28's persistence was never wired up: the
-- endpoint adapter threw `coa_extract_not_implemented_persistence` on purpose
-- rather than write rows it could not write correctly.
--
-- WHAT THIS DOES
-- Adds two nullable columns to document_field_extractions and threads them
-- through the one sanctioned write path:
--
--     report_ordinal  integer  — 1-based position of the report within the
--                                document. Rows sharing (document, ordinal) are
--                                one report.
--     report_label    text     — the report's own printed identifier, kept for
--                                humans. NOT the grouping key: two reports in a
--                                pack can print the same number, and a report
--                                can print none at all.
--
-- NULL keeps its migration-28 meaning: a reading not attributed to any
-- particular report. Every row written before this migration is such a reading,
-- which is why the columns are nullable and why no backfill is attempted — see
-- the note on backfill below.
--
-- ─── WHY ORDINAL AND LABEL, RATHER THAN A REPORTS TABLE ─────────────────────
-- A `document_reports` parent table with a foreign key would let the database
-- enforce the grouping instead of trusting the writer. That is the stronger
-- design and it was considered and rejected for this migration on cost: it adds
-- a table, its RLS, its grants, its own VERIFY and ROLLBACK surface, and a
-- second write path — for a guarantee that, here, one function already provides.
--
-- The honest statement of the residual risk: nothing in the database stops two
-- different reports being written under the same ordinal. The grouping is a
-- convention enforced by record_document_field_extraction's callers, not by a
-- constraint. If a second writer is ever added, that guarantee is gone and this
-- should become a real table. (Owner decision, 2026-08-03.)
--
-- ─── WHY THE RPC IS DROPPED AND RECREATED, NOT REPLACED ─────────────────────
-- CREATE OR REPLACE FUNCTION cannot add a parameter. Adding one — even with a
-- DEFAULT — produces a function with a NEW signature, so the old seven-argument
-- version would survive alongside it as an overload. A caller passing seven
-- arguments would then bind to the old function and write a row with a NULL
-- ordinal, which is precisely the bug this migration exists to close, now
-- silently and only on some code paths.
--
-- So the old signature is dropped. Dropping a function also drops its ACL, so
-- the REVOKE/GRANT pair from migration 28 §4 is re-applied verbatim below;
-- omitting it would leave EXECUTE at PostgreSQL's default of PUBLIC.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
--
--   • No backfill. Existing rows keep report_ordinal NULL rather than being
--     assigned 1. Writing 1 would assert "this reading belongs to the first
--     report", which is an unverified claim about documents nobody has re-read,
--     and migration 28's table is append-only precisely so that no process
--     revises history. NULL says what is true: unattributed.
--
--   • No change to document_extraction_field_names(). 'report_number' stays a
--     valid field name. The printed number is still worth recording as a field
--     read off the page with its own confidence and provenance; report_label is
--     a denormalised convenience for grouping and display, not a replacement
--     for the extracted value.
--
--   • No UNIQUE constraint on (document, ordinal, field_name). The table is
--     append-only by design: re-extraction INSERTs a newer row for the same
--     field and the most recent one wins. A UNIQUE constraint would forbid that
--     and break migration 28 §3.6.
-- =============================================================================

BEGIN;

-- ─── 1. The columns ─────────────────────────────────────────────────────────

ALTER TABLE public.document_field_extractions
  ADD COLUMN IF NOT EXISTS report_ordinal integer;

ALTER TABLE public.document_field_extractions
  ADD COLUMN IF NOT EXISTS report_label text;

-- ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL, so this is guarded by a
-- catalogue lookup to keep the migration re-runnable like the rest of the file.
--
-- The bound is >= 1 and not >= 0: the ordinal is a 1-based human-facing position
-- ("report 1 of 5"). Admitting 0 would let two encodings of "the first report"
-- coexist in one column, and any consumer that groups by ordinal would split
-- one report into two.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.document_field_extractions'::regclass
      AND conname  = 'dfe_report_ordinal_positive_check'
  ) THEN
    ALTER TABLE public.document_field_extractions
      ADD CONSTRAINT dfe_report_ordinal_positive_check
        CHECK (report_ordinal IS NULL OR report_ordinal >= 1);
  END IF;
END
$$;

-- A label with no ordinal is a row that names a report it is not grouped with —
-- readable by a human, invisible to every query that assembles a report. That
-- is the failure this migration exists to prevent, so it is refused rather than
-- stored.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.document_field_extractions'::regclass
      AND conname  = 'dfe_report_label_needs_ordinal_check'
  ) THEN
    ALTER TABLE public.document_field_extractions
      ADD CONSTRAINT dfe_report_label_needs_ordinal_check
        CHECK (report_label IS NULL OR report_ordinal IS NOT NULL);
  END IF;
END
$$;

-- ─── 2. Indexes serving "assemble report N of this document" ────────────────
--
-- Partial, matching migration 28's existing pair: the surface discriminator
-- guarantees exactly one of these FKs is set, so a row appears in exactly one.

CREATE INDEX IF NOT EXISTS idx_dfe_farmer_document_report
  ON public.document_field_extractions (farmer_document_id, report_ordinal, extracted_at DESC)
  WHERE farmer_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dfe_inventory_document_report
  ON public.document_field_extractions (inventory_document_id, report_ordinal, extracted_at DESC)
  WHERE inventory_document_id IS NOT NULL;

-- ─── 3. The write path, re-cut with the grouping arguments ──────────────────
--
-- Everything inside the body is migration 28 §3.7 unchanged except for carrying
-- the two new columns: same admin gate, same FK existence checks, same
-- auth.uid() stamp, same error codes. It is restated in full rather than
-- patched because a function body cannot be amended in place.

DROP FUNCTION IF EXISTS public.record_document_field_extraction(text,uuid,text,text,text,numeric,text);

CREATE FUNCTION public.record_document_field_extraction(
  p_document_surface   text,
  p_document_id        uuid,
  p_field_name         text,
  p_field_value_text   text,
  p_provenance         text,
  p_confidence         numeric DEFAULT NULL,
  p_extraction_warning text    DEFAULT NULL,
  p_report_ordinal     integer DEFAULT NULL,
  p_report_label       text    DEFAULT NULL
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
       provenance, confidence, extraction_warning, recorded_by_user_id,
       report_ordinal, report_label)
    VALUES ('farmer_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid(),
            p_report_ordinal, p_report_label)
    RETURNING id INTO new_id;

  ELSIF p_document_surface = 'inventory_document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents WHERE id = p_document_id) THEN
      RAISE EXCEPTION 'record_document_field_extraction: document % not found', p_document_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO public.document_field_extractions
      (document_surface, inventory_document_id, field_name, field_value_text,
       provenance, confidence, extraction_warning, recorded_by_user_id,
       report_ordinal, report_label)
    VALUES ('inventory_document', p_document_id, p_field_name, p_field_value_text,
            p_provenance, p_confidence, p_extraction_warning, auth.uid(),
            p_report_ordinal, p_report_label)
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

-- ─── 4. Privileges ──────────────────────────────────────────────────────────
--
-- DROP FUNCTION took the old ACL with it. Without these two lines EXECUTE
-- reverts to PostgreSQL's default — PUBLIC — which would hand anon a
-- SECURITY DEFINER writer. The admin gate inside the body would still refuse
-- the write, so this is defence in depth rather than the only lock, but an
-- unauthenticated caller should not reach the function body at all.
--
-- service_role is granted EXECUTE to match migration 28. Note that the grant is
-- not sufficient to write: the body calls is_ddp_admin(), which resolves
-- auth.uid() — NULL under a service-role connection carrying no user JWT — so a
-- service-role caller is refused by the admin gate. Writing through this
-- function requires the END USER's access token. That is deliberate: it is what
-- makes recorded_by_user_id a fact about a person rather than about a server.

REVOKE EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text) TO authenticated, service_role;

COMMENT ON COLUMN public.document_field_extractions.report_ordinal IS
  '1-based position of the source report within a multi-report document. Rows '
  'sharing (document, report_ordinal) belong to one laboratory report. NULL '
  'means the reading is not attributed to a particular report.';

COMMENT ON COLUMN public.document_field_extractions.report_label IS
  'The report identifier as printed on the certificate, for display. Not a key: '
  'it may be absent or duplicated within a pack. Group by report_ordinal.';

COMMIT;
