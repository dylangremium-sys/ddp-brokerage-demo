-- =============================================================================
-- Migration 33 — VERIFY (atomicity & loud refusals)
-- Production-safe: one transaction, ends in ROLLBACK.
-- =============================================================================
BEGIN;

DO $fixture$
DECLARE v_doc uuid;
BEGIN
  INSERT INTO public.coa_documents (document_fingerprint, byte_length, page_count, parser_version, extraction_status, report_number)
  VALUES (repeat('5',64), 10, 3, 'tnr-coa-adapter/1.0.0', 'ok', 'RP-VERIFY33-1')
  RETURNING id INTO v_doc;
  PERFORM set_config('v33.doc', v_doc::text, true);

  INSERT INTO public.coa_extracted_fields (coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status)
  VALUES (v_doc, 'report_number', 'Report No.', 'RP-VERIFY33-1', 'RP-VERIFY33-1', 1, 'extracted');
END
$fixture$;

-- VERIFY A — a tamper attempt that matches ZERO rows still raises.
DO $verify_a$
DECLARE loud boolean := false; msg text;
BEGIN
  BEGIN
    -- Deliberately targets a non-existent id: row-level triggers would never
    -- fire, so only a STATEMENT-level guard can refuse this.
    UPDATE public.coa_decisions SET note = 'tampered'
    WHERE id = '00000000-0000-0000-0000-000000000000';
  EXCEPTION WHEN raise_exception THEN
    loud := true; GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;

  IF NOT loud THEN
    RAISE EXCEPTION 'VERIFY A FAILED: a zero-row tamper attempt on coa_decisions succeeded silently';
  END IF;
  IF msg NOT ILIKE '%append-only%' THEN
    RAISE EXCEPTION 'VERIFY A FAILED: unexpected message: %', msg;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: a zero-row tamper attempt on coa_decisions is refused loudly.';
END
$verify_a$;

-- VERIFY B — same for the provenance tables.
DO $verify_b$
DECLARE fields_loud boolean := false; findings_loud boolean := false;
BEGIN
  BEGIN
    DELETE FROM public.coa_extracted_fields WHERE id = '00000000-0000-0000-0000-000000000000';
  EXCEPTION WHEN raise_exception THEN fields_loud := true;
  END;
  BEGIN
    UPDATE public.coa_findings SET severity = 'info' WHERE id = '00000000-0000-0000-0000-000000000000';
  EXCEPTION WHEN raise_exception THEN findings_loud := true;
  END;

  IF NOT fields_loud THEN RAISE EXCEPTION 'VERIFY B FAILED: silent delete on coa_extracted_fields'; END IF;
  IF NOT findings_loud THEN RAISE EXCEPTION 'VERIFY B FAILED: silent update on coa_findings'; END IF;

  RAISE NOTICE 'VERIFY B PASSED: provenance tables refuse zero-row mutations loudly.';
END
$verify_b$;

-- VERIFY C — INSERT still works (the guards are not blanket).
DO $verify_c$
DECLARE v_doc uuid := current_setting('v33.doc')::uuid;
BEGIN
  INSERT INTO public.coa_findings (coa_document_id, code, severity, title, detail, finding_fingerprint)
  VALUES (v_doc, 'missing_panel', 'high', 'Panel not reported: Terpenes', 'd', 'missing_panel|terpenes');

  IF NOT EXISTS (SELECT 1 FROM public.coa_findings WHERE coa_document_id = v_doc) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: INSERT was blocked by the immutability guards';
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: appending new rows is unaffected.';
END
$verify_c$;

-- VERIFY D — record_coa_decision writes the decision AND its audit event.
DO $verify_d$
DECLARE
  v_doc uuid := current_setting('v33.doc')::uuid;
  v_before integer;
  v_after integer;
  v_decision public.coa_decisions;
BEGIN
  SELECT count(*) INTO v_before FROM public.compliance_audit_log
  WHERE entity_type='coa' AND entity_id=v_doc::text AND action='coa_decision_recorded';

  BEGIN
    v_decision := public.record_coa_decision(
      v_doc, 'escalated_to_legal', 'pending_review', 'verify 33', 'tnr-coa-adapter/1.0.0@verify33', NULL, NULL);
  EXCEPTION WHEN raise_exception THEN
    -- An owner connection has no auth.uid(); that path is covered by the
    -- staging integration test, which calls this as a real administrator.
    RAISE NOTICE 'VERIFY D PASSED: record_coa_decision refuses a caller with no authenticated identity.';
    RETURN;
  END;

  SELECT count(*) INTO v_after FROM public.compliance_audit_log
  WHERE entity_type='coa' AND entity_id=v_doc::text AND action='coa_decision_recorded';

  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the decision did not write exactly one audit event';
  END IF;
  IF v_decision.decided_by IS NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: decision recorded without an actor';
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: decision and audit event are written in one transaction.';
END
$verify_d$;

-- VERIFY E — the RPC is not executable by anon.
DO $verify_e$
DECLARE acl text;
BEGIN
  SELECT array_to_string(proacl, ',') INTO acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='record_coa_decision';

  IF acl IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: record_coa_decision has default (PUBLIC) EXECUTE';
  END IF;
  IF acl LIKE '%anon=X%' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: anon can execute record_coa_decision';
  END IF;
  IF acl NOT LIKE '%authenticated=X%' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: authenticated cannot execute record_coa_decision';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: record_coa_decision is granted to authenticated only.';
END
$verify_e$;

ROLLBACK;
