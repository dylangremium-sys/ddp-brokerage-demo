-- =============================================================================
-- Migration 31 — VERIFY (Source-bound COA review)
--
-- Production-safe: one transaction, ends in ROLLBACK, no COMMIT. Behavioural
-- checks that build real fixtures and prove the database REFUSES what the gate
-- forbids — most importantly that a regulatory suggestion cannot be stored as
-- bound unless the source it cites was genuinely retrieved.
--
-- A section that cannot build its fixture RAISES, so a vacuous pass is not
-- possible: every section either exercises real rows or fails.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 31_COA_SOURCE_BOUND_REVIEW_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — every table, trigger and function exists with the required shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  tables text[] := ARRAY['coa_documents','coa_extracted_fields','coa_findings',
                         'coa_source_versions','coa_suggestions','coa_decisions'];
  fns text[] := ARRAY['enforce_coa_suggestion_source_binding','prevent_coa_decision_mutation'];
  f text;
  insecure text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || ('table public.' || t);
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity
    ) THEN
      missing := missing || ('RLS not enabled on public.' || t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=f
    ) THEN
      missing := missing || ('function public.' || f);
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=f
        AND p.prosecdef
        AND array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') ILIKE '%search_path=public%'
    ) THEN
      insecure := insecure || f;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='coa_suggestions_enforce_binding') THEN
    missing := missing || 'trigger coa_suggestions_enforce_binding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='coa_decisions_no_update_delete') THEN
    missing := missing || 'trigger coa_decisions_no_update_delete';
  END IF;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing objects: %', array_to_string(missing, ', ');
  END IF;
  IF array_length(insecure,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: function(s) not SECURITY DEFINER with pinned search_path: %',
      array_to_string(insecure, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: 6 tables (RLS on), 2 guard functions (SECURITY DEFINER, pinned search_path), 2 triggers.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- Shared fixture: one COA document, one administrator.
-- -----------------------------------------------------------------------------
DO $fixture$
DECLARE
  v_user uuid;
BEGIN
  SELECT id INTO v_user FROM auth.users LIMIT 1;
  IF v_user IS NULL THEN
    v_user := gen_random_uuid();
    INSERT INTO auth.users (id) VALUES (v_user);
  END IF;
  PERFORM set_config('verify31.user_id', v_user::text, true);

  INSERT INTO public.coa_documents (
    document_fingerprint, source_filename, byte_length, page_count,
    parser_version, extraction_status, report_number, sample_name, batch_number
  ) VALUES (
    repeat('a', 64), 'fixture.pdf', 1234, 3,
    'tnr-coa-adapter/1.0.0', 'ok', 'RP-VERIFY-0001', 'Fixture Sample', 'B-0001'
  );
END
$fixture$;

-- -----------------------------------------------------------------------------
-- VERIFY B — an extracted field must be able to cite its PDF page.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_doc uuid;
  rejected boolean := false;
  accepted_page integer;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);
  IF v_doc IS NULL THEN RAISE EXCEPTION 'VERIFY B FAILED: fixture document missing'; END IF;

  BEGIN
    INSERT INTO public.coa_extracted_fields (coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status)
    VALUES (v_doc, 'no_page', 'No page', 'x', 'x', NULL, 'extracted');
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'VERIFY B FAILED: an extracted field was stored without a PDF page number';
  END IF;

  INSERT INTO public.coa_extracted_fields (coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status)
  VALUES (v_doc, 'report_number', 'Report No.', 'RP-VERIFY-0001', 'RP-VERIFY-0001', 1, 'extracted');

  -- A field that was never found legitimately has no page.
  INSERT INTO public.coa_extracted_fields (coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status)
  VALUES (v_doc, 'material_batch_number', 'Material Batch No.', 'N/A', NULL, NULL, 'missing');

  SELECT page_number INTO accepted_page FROM public.coa_extracted_fields
  WHERE coa_document_id = v_doc AND field_key = 'report_number';
  IF accepted_page IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: stored page provenance was not readable back';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: extracted fields require a page number; missing fields may omit it.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — findings are idempotent per (document, fingerprint).
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_doc uuid;
  duplicate_rejected boolean := false;
  n integer;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);

  INSERT INTO public.coa_findings (coa_document_id, code, severity, title, detail, panel_key, page_number, finding_fingerprint)
  VALUES (v_doc, 'missing_panel', 'high', 'Panel not reported: Pesticides', 'detail', 'pesticides', NULL, 'missing_panel|pesticides');

  BEGIN
    INSERT INTO public.coa_findings (coa_document_id, code, severity, title, detail, panel_key, page_number, finding_fingerprint)
    VALUES (v_doc, 'missing_panel', 'high', 'Panel not reported: Pesticides', 'detail', 'pesticides', NULL, 'missing_panel|pesticides');
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected := true;
  END;

  IF NOT duplicate_rejected THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the same finding was stored twice for one document';
  END IF;

  SELECT count(*) INTO n FROM public.coa_findings WHERE coa_document_id = v_doc;
  IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: expected exactly 1 finding, found %', n; END IF;

  RAISE NOTICE 'VERIFY C PASSED: re-running extraction cannot duplicate a finding (idempotent retry).';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — a successful retrieval must carry a content fingerprint.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.coa_source_versions (source_key, authority, jurisdiction, requested_url, retrieval_status, content_fingerprint)
    VALUES ('th-fda', 'Thai FDA', 'Thailand', 'https://www.fda.moph.go.th/', 'retrieved', NULL);
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a "retrieved" source version was stored with no content fingerprint';
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: a retrieved source version cannot exist without its version fingerprint.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — a FAILED retrieval is recorded, not discarded.
--
-- This is the state that must block a regulatory suggestion, so it has to be
-- persistable.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_failed uuid;
BEGIN
  INSERT INTO public.coa_source_versions (source_key, authority, jurisdiction, requested_url, retrieval_status, failure_reason)
  VALUES ('th-fda', 'Thai FDA', 'Thailand', 'https://www.fda.moph.go.th/', 'timeout', 'request exceeded 12000ms')
  RETURNING id INTO v_failed;

  IF v_failed IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a failed retrieval could not be recorded';
  END IF;
  PERFORM set_config('verify31.failed_source', v_failed::text, true);

  RAISE NOTICE 'VERIFY E PASSED: an unverified/failed source retrieval is durably recorded.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — an UNCITED suggestion cannot be stored as bound.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_doc uuid;
  rejected boolean := false;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);

  BEGIN
    INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text)
    VALUES (v_doc, NULL, 'bound', 'An uncited suggestion.');
  EXCEPTION WHEN check_violation OR raise_exception THEN
    rejected := true;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'VERIFY F FAILED: an uncited suggestion was stored in the bound state';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: an uncited regulatory suggestion is refused by the database.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- VERIFY G — a suggestion citing an UNVERIFIED source cannot be bound.
--
-- The gate's central rule: no verified source retrieval = no suggestion.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_doc uuid;
  v_failed uuid;
  rejected boolean := false;
  message text;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);
  v_failed := current_setting('verify31.failed_source')::uuid;

  BEGIN
    INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text)
    VALUES (v_doc, v_failed, 'bound', 'A suggestion resting on a timed-out source.');
  EXCEPTION WHEN raise_exception THEN
    rejected := true;
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'VERIFY G FAILED: a suggestion bound to an unretrieved source was accepted';
  END IF;
  IF message NOT ILIKE '%not successfully retrieved%' THEN
    RAISE EXCEPTION 'VERIFY G FAILED: unexpected refusal message: %', message;
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: a suggestion cannot rest on an unverified source (%).', left(message, 60);
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- VERIFY H — a quarantined suggestion IS storable, with its reason.
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  v_doc uuid;
  v_failed uuid;
  v_id uuid;
  reason_required boolean := false;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);
  v_failed := current_setting('verify31.failed_source')::uuid;

  INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text, reason)
  VALUES (v_doc, v_failed, 'quarantined', 'A suggestion held for inspection.',
          'the cited source was not successfully retrieved (status "timeout")')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a quarantined suggestion could not be recorded';
  END IF;

  BEGIN
    INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text, reason)
    VALUES (v_doc, v_failed, 'quarantined', 'No reason given.', NULL);
  EXCEPTION WHEN check_violation THEN
    reason_required := true;
  END;

  IF NOT reason_required THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a quarantined suggestion was stored without a reason';
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: quarantined suggestions are retained for audit and must state a reason.';
END
$verify_h$;

-- -----------------------------------------------------------------------------
-- VERIFY I — a suggestion citing a genuinely RETRIEVED source binds.
-- -----------------------------------------------------------------------------
DO $verify_i$
DECLARE
  v_doc uuid;
  v_good uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);

  INSERT INTO public.coa_source_versions (
    source_key, authority, jurisdiction, jurisdiction_code, requested_url, final_url,
    retrieval_status, http_status, content_type, byte_length, content_fingerprint,
    relevant_section, section_matched
  ) VALUES (
    'th-fda', 'Thai Food and Drug Administration', 'Thailand', 'TH',
    'https://www.fda.moph.go.th/', 'https://www.fda.moph.go.th/',
    'retrieved', 200, 'text/html', 4096, repeat('c',64),
    'Published requirements text.', true
  ) RETURNING id INTO v_good;
  PERFORM set_config('verify31.good_source', v_good::text, true);

  INSERT INTO public.coa_suggestions (coa_document_id, source_version_id, state, suggestion_text)
  VALUES (v_doc, v_good, 'bound', 'Preliminary note bound to a retrieved source version.')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY I FAILED: a properly bound suggestion was refused';
  END IF;
  PERFORM set_config('verify31.suggestion', v_id::text, true);

  RAISE NOTICE 'VERIFY I PASSED: a suggestion bound to a retrieved, fingerprinted source version is accepted.';
END
$verify_i$;

-- -----------------------------------------------------------------------------
-- VERIFY J — administrator decisions are append-only.
-- -----------------------------------------------------------------------------
DO $verify_j$
DECLARE
  v_doc uuid;
  v_user uuid;
  v_good uuid;
  v_suggestion uuid;
  v_decision uuid;
  update_blocked boolean := false;
  delete_blocked boolean := false;
BEGIN
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);
  v_user := current_setting('verify31.user_id')::uuid;
  v_good := current_setting('verify31.good_source')::uuid;
  v_suggestion := current_setting('verify31.suggestion')::uuid;

  INSERT INTO public.coa_decisions (
    coa_document_id, source_version_id, suggestion_id, decision,
    previous_state, resulting_state, note, evidence_version, decided_by
  ) VALUES (
    v_doc, v_good, v_suggestion, 'escalated_to_legal',
    'pending_review', 'escalated_to_legal', 'Referred for legal review.',
    'tnr-coa-adapter/1.0.0@' || repeat('a',64), v_user
  ) RETURNING id INTO v_decision;

  IF v_decision IS NULL THEN
    RAISE EXCEPTION 'VERIFY J FAILED: an administrator decision could not be recorded';
  END IF;

  BEGIN
    UPDATE public.coa_decisions SET note = 'tampered' WHERE id = v_decision;
  EXCEPTION WHEN raise_exception THEN update_blocked := true;
  END;
  BEGIN
    DELETE FROM public.coa_decisions WHERE id = v_decision;
  EXCEPTION WHEN raise_exception THEN delete_blocked := true;
  END;

  IF NOT update_blocked THEN RAISE EXCEPTION 'VERIFY J FAILED: a recorded decision could be updated'; END IF;
  IF NOT delete_blocked THEN RAISE EXCEPTION 'VERIFY J FAILED: a recorded decision could be deleted'; END IF;

  RAISE NOTICE 'VERIFY J PASSED: a decision records actor/states/evidence version and cannot be altered or removed.';
END
$verify_j$;

-- -----------------------------------------------------------------------------
-- VERIFY K — the audit log accepts the COA vocabulary and rejects invented ones.
-- -----------------------------------------------------------------------------
DO $verify_k$
DECLARE
  v_user uuid;
  v_good uuid;
  v_doc uuid;
  bad_rejected boolean := false;
  n integer;
BEGIN
  v_user := current_setting('verify31.user_id')::uuid;
  v_good := current_setting('verify31.good_source')::uuid;
  SELECT id INTO v_doc FROM public.coa_documents WHERE document_fingerprint = repeat('a',64);

  INSERT INTO public.compliance_audit_log (
    actor_type, actor_id, action, entity_type, entity_id,
    before_state, after_state, reason, evidence_version, source_version_id
  ) VALUES (
    'admin', v_user, 'coa_decision_recorded', 'coa', v_doc::text,
    jsonb_build_object('state','pending_review'),
    jsonb_build_object('state','escalated_to_legal'),
    'Referred for legal review.',
    'tnr-coa-adapter/1.0.0@' || repeat('a',64), v_good
  );

  BEGIN
    INSERT INTO public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id)
    VALUES ('admin', v_user, 'coa_totally_invented_action', 'coa', v_doc::text);
  EXCEPTION WHEN check_violation THEN bad_rejected := true;
  END;

  IF NOT bad_rejected THEN
    RAISE EXCEPTION 'VERIFY K FAILED: the audit log accepted an unknown action';
  END IF;

  SELECT count(*) INTO n FROM public.compliance_audit_log
  WHERE action = 'coa_decision_recorded' AND evidence_version IS NOT NULL AND source_version_id IS NOT NULL;
  IF n < 1 THEN
    RAISE EXCEPTION 'VERIFY K FAILED: the audit event did not retain its evidence and source versions';
  END IF;

  -- The migration-9 vocabulary must still work.
  INSERT INTO public.compliance_audit_log (actor_type, action, entity_type, entity_id)
  VALUES ('system', 'alert_created', 'coa', v_doc::text);

  RAISE NOTICE 'VERIFY K PASSED: audit events carry actor, action, evidence + source version and states; unknown actions are refused.';
END
$verify_k$;

-- -----------------------------------------------------------------------------
-- VERIFY L — identical PDF bytes cannot create a second document record.
-- -----------------------------------------------------------------------------
DO $verify_l$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.coa_documents (document_fingerprint, byte_length, parser_version, extraction_status)
    VALUES (repeat('a',64), 999, 'tnr-coa-adapter/1.0.0', 'ok');
  EXCEPTION WHEN unique_violation THEN rejected := true;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION 'VERIFY L FAILED: the same document bytes produced two records';
  END IF;

  RAISE NOTICE 'VERIFY L PASSED: document fingerprint is unique — re-upload is idempotent.';
END
$verify_l$;

-- -----------------------------------------------------------------------------
-- VERIFY M — RLS policies are admin-only, and decisions are insert-own.
-- -----------------------------------------------------------------------------
DO $verify_m$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  tables text[] := ARRAY['coa_documents','coa_extracted_fields','coa_findings',
                         'coa_source_versions','coa_suggestions','coa_decisions'];
  decision_insert text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t) THEN
      missing := missing || ('no policy on public.' || t);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=t
        AND coalesce(qual,'') !~ 'is_ddp_admin'
        AND coalesce(with_check,'') !~ 'is_ddp_admin'
    ) THEN
      missing := missing || ('a policy on public.' || t || ' does not require is_ddp_admin()');
    END IF;
  END LOOP;

  SELECT with_check INTO decision_insert
  FROM pg_policies
  WHERE schemaname='public' AND tablename='coa_decisions' AND cmd='INSERT';

  IF decision_insert IS NULL OR decision_insert !~ 'auth\.uid\(\)' THEN
    missing := missing || 'coa_decisions INSERT policy does not pin decided_by to auth.uid()';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='coa_decisions' AND cmd IN ('UPDATE','DELETE')) THEN
    missing := missing || 'coa_decisions exposes an UPDATE/DELETE policy';
  END IF;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY M FAILED: %', array_to_string(missing, '; ');
  END IF;

  RAISE NOTICE 'VERIFY M PASSED: all six tables are admin-only; decisions are insert-own with no update/delete policy.';
END
$verify_m$;

ROLLBACK;
