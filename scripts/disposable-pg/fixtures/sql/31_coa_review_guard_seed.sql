-- Destructive-guard seed for the 31_coa_review fixture.
--
-- Creates one live COA review chain — document, retrieved source version, bound
-- suggestion, and an administrator DECISION — so the migration-31 ROLLBACK
-- guard has real audit data to protect. This is HARNESS TEST DATA, not
-- migration SQL.
--
-- The decision is the point: it is append-only and cannot be reconstructed once
-- dropped, so after this seed the guard must REFUSE a rollback without the
-- explicit opt-in, and SUCCEED with it.
DO $seed$
DECLARE
  actor      uuid;
  doc_id     uuid;
  source_id  uuid;
  sugg_id    uuid;
  decision_id uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: no auth.users row available to act as administrator';
  END IF;

  INSERT INTO public.coa_documents (
    document_fingerprint, source_filename, byte_length, page_count,
    parser_version, extraction_status, report_number, sample_name, batch_number, uploaded_by
  ) VALUES (
    repeat('d', 64), 'guard-seed.pdf', 4242, 3,
    'tnr-coa-adapter/1.0.0', 'ok', 'RP-SEED-0001', 'Guard Seed Sample', 'B-SEED', actor
  ) RETURNING id INTO doc_id;

  INSERT INTO public.coa_extracted_fields (
    coa_document_id, field_key, label, raw_value, normalized_value, page_number, extraction_status
  ) VALUES (
    doc_id, 'report_number', 'Report No.', 'RP-SEED-0001', 'RP-SEED-0001', 1, 'extracted'
  );

  INSERT INTO public.coa_source_versions (
    source_key, authority, jurisdiction, jurisdiction_code, requested_url, final_url,
    retrieval_status, http_status, content_type, byte_length, content_fingerprint,
    relevant_section, section_matched, retrieved_by
  ) VALUES (
    'th-fda', 'Thai Food and Drug Administration', 'Thailand', 'TH',
    'https://www.fda.moph.go.th/', 'https://www.fda.moph.go.th/',
    'retrieved', 200, 'text/html', 8192, repeat('e', 64),
    'Seeded verbatim section from the retrieved authority page.', true, actor
  ) RETURNING id INTO source_id;

  INSERT INTO public.coa_suggestions (
    coa_document_id, source_version_id, state, suggestion_text, created_by
  ) VALUES (
    doc_id, source_id, 'bound',
    'Preliminary, source-bound note for the seeded document. This is not a compliance determination.',
    actor
  ) RETURNING id INTO sugg_id;

  INSERT INTO public.coa_decisions (
    coa_document_id, source_version_id, suggestion_id, decision,
    previous_state, resulting_state, note, evidence_version, decided_by
  ) VALUES (
    doc_id, source_id, sugg_id, 'escalated_to_legal',
    'pending_review', 'escalated_to_legal', 'Seeded administrator decision.',
    'tnr-coa-adapter/1.0.0@' || repeat('d', 64), actor
  ) RETURNING id INTO decision_id;

  IF decision_id IS NULL THEN
    RAISE EXCEPTION 'guard seed failed: control insert produced no decision (guard test would be vacuous)';
  END IF;

  RAISE NOTICE 'guard seed: 1 live COA review chain created (document=%, decision=%).', doc_id, decision_id;
END
$seed$;
