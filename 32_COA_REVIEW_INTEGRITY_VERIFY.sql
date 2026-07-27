-- =============================================================================
-- Migration 32 — VERIFY (COA review integrity hardening)
--
-- Production-safe: one transaction, ends in ROLLBACK. Behavioural checks that
-- prove the two HIGH red-team findings are actually closed, not merely that
-- objects exist.
--
-- Run: psql "<conn>" -v ON_ERROR_STOP=1 -f 32_COA_REVIEW_INTEGRITY_VERIFY.sql
-- =============================================================================

BEGIN;

-- Fixture: a document, a retrieved source, and a suggestion bound to it.
DO $fixture$
DECLARE
  v_doc uuid; v_src uuid;
BEGIN
  INSERT INTO public.coa_documents (document_fingerprint, byte_length, page_count, parser_version, extraction_status, report_number)
  VALUES (repeat('3',64), 10, 3, 'tnr-coa-adapter/1.0.0', 'ok', 'RP-VERIFY32-1')
  RETURNING id INTO v_doc;
  PERFORM set_config('v32.doc', v_doc::text, true);

  INSERT INTO public.coa_source_versions (source_key, authority, jurisdiction, requested_url, retrieval_status, content_fingerprint)
  VALUES ('th-fda','Thai FDA','Thailand','https://www.fda.moph.go.th/','retrieved', repeat('4',64))
  RETURNING id INTO v_src;
  PERFORM set_config('v32.src', v_src::text, true);

  INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text)
  VALUES (v_doc, v_src, 'bound', 'Bound for verify 32.');

  INSERT INTO public.coa_extracted_fields (coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status)
  VALUES (v_doc, 'total_thc', 'Total THC', '26.86 %w/w', '26.86 %w/w', 1, 'extracted');

  INSERT INTO public.coa_findings (coa_document_id, code, severity, title, detail, finding_fingerprint)
  VALUES (v_doc, 'missing_panel', 'high', 'Panel not reported: Pesticides', 'd', 'missing_panel|pesticides');
END
$fixture$;

-- VERIFY A — a source version cited by a bound suggestion cannot be mutated.
DO $verify_a$
DECLARE
  blocked boolean := false; msg text;
BEGIN
  BEGIN
    UPDATE public.coa_source_versions
    SET retrieval_status = 'timeout'
    WHERE id = current_setting('v32.src')::uuid;
  EXCEPTION WHEN raise_exception THEN
    blocked := true; GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION 'VERIFY A FAILED: a cited source version was downgraded while a bound suggestion still referenced it';
  END IF;
  IF msg NOT ILIKE '%immutable%' THEN
    RAISE EXCEPTION 'VERIFY A FAILED: unexpected refusal message: %', msg;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: a source version cited by a bound suggestion is immutable.';
END
$verify_a$;

-- VERIFY B — an UNCITED source version remains mutable (no over-blocking).
DO $verify_b$
DECLARE
  v_free uuid;
BEGIN
  INSERT INTO public.coa_source_versions (source_key, authority, jurisdiction, requested_url, retrieval_status)
  VALUES ('th-fda','Thai FDA','Thailand','https://www.fda.moph.go.th/','timeout')
  RETURNING id INTO v_free;

  UPDATE public.coa_source_versions SET failure_reason = 'annotated' WHERE id = v_free;

  IF NOT EXISTS (SELECT 1 FROM public.coa_source_versions WHERE id = v_free AND failure_reason = 'annotated') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: an uncited source version could not be updated';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: an uncited source version is still mutable — the guard is scoped, not blanket.';
END
$verify_b$;

-- VERIFY C — extracted provenance is append-only.
DO $verify_c$
DECLARE
  upd_blocked boolean := false; del_blocked boolean := false;
BEGIN
  BEGIN
    UPDATE public.coa_extracted_fields SET normalized_value = 'FABRICATED'
    WHERE coa_document_id = current_setting('v32.doc')::uuid;
  EXCEPTION WHEN raise_exception THEN upd_blocked := true;
  END;
  BEGIN
    DELETE FROM public.coa_extracted_fields WHERE coa_document_id = current_setting('v32.doc')::uuid;
  EXCEPTION WHEN raise_exception THEN del_blocked := true;
  END;

  IF NOT upd_blocked THEN RAISE EXCEPTION 'VERIFY C FAILED: an extracted field was overwritten'; END IF;
  IF NOT del_blocked THEN RAISE EXCEPTION 'VERIFY C FAILED: an extracted field was deleted'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.coa_extracted_fields
                 WHERE coa_document_id = current_setting('v32.doc')::uuid
                   AND normalized_value = '26.86 %w/w') THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the original extracted value did not survive';
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: extracted fields cannot be rewritten or removed.';
END
$verify_c$;

-- VERIFY D — findings are append-only.
DO $verify_d$
DECLARE
  upd_blocked boolean := false; del_blocked boolean := false;
BEGIN
  BEGIN
    UPDATE public.coa_findings SET severity = 'info'
    WHERE coa_document_id = current_setting('v32.doc')::uuid;
  EXCEPTION WHEN raise_exception THEN upd_blocked := true;
  END;
  BEGIN
    DELETE FROM public.coa_findings WHERE coa_document_id = current_setting('v32.doc')::uuid;
  EXCEPTION WHEN raise_exception THEN del_blocked := true;
  END;

  IF NOT upd_blocked THEN RAISE EXCEPTION 'VERIFY D FAILED: a finding was downgraded'; END IF;
  IF NOT del_blocked THEN RAISE EXCEPTION 'VERIFY D FAILED: a finding was deleted'; END IF;

  RAISE NOTICE 'VERIFY D PASSED: findings cannot be downgraded or removed.';
END
$verify_d$;

-- VERIFY E — RLS exposes no UPDATE/DELETE path on the provenance tables.
DO $verify_e$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(tablename || '.' || cmd, ', ') INTO offending
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('coa_extracted_fields', 'coa_findings')
    AND cmd IN ('UPDATE', 'DELETE', 'ALL');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: mutating policy still present: %', offending;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: provenance tables expose SELECT + INSERT only.';
END
$verify_e$;

ROLLBACK;
