-- =============================================================================
-- Migration 27 — VERIFY (Evidence digest de-duplication & extraction provenance)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- These are BEHAVIOURAL checks, not catalog spot-checks. Each section builds a
-- real fixture and proves the database actually refuses the thing the migration
-- says it refuses — and, just as important, that it still PERMITS the adjacent
-- legitimate case (D, E, F). A constraint that over-blocks would pass a
-- refusal-only test while breaking real submissions.
--
-- A section that cannot build its fixture RAISES rather than silently passing,
-- so the script can never pass vacuously.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 27_EVIDENCE_DIGEST_DEDUP_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — every migration-27 object exists with the required security shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing   text[] := ARRAY[]::text[];
  f         text;
  fns       text[] := ARRAY['fn_evidence_attachment_digest_dedup',
                            'find_document_digest_matches',
                            'document_extraction_field_names',
                            'document_extraction_provenances',
                            'fn_dfe_append_only',
                            'record_document_field_extraction'];
  idx       text;
  idxs      text[] := ARRAY['idx_evidence_attachments_sha256_hex',
                            'uniq_evidence_attachments_response_digest',
                            'idx_farmer_documents_sha256_hex'];
  secdef_ok boolean;
  invoker   boolean;
  rls_on    boolean;
BEGIN
  IF to_regclass('public.document_field_extractions') IS NULL THEN
    missing := missing || 'table public.document_field_extractions';
  END IF;

  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = f)
    THEN missing := missing || ('function ' || f); END IF;
  END LOOP;

  FOREACH idx IN ARRAY idxs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = 'public' AND indexname = idx)
    THEN missing := missing || ('index ' || idx); END IF;
  END LOOP;

  FOR f IN SELECT unnest(ARRAY['sha256_hex','sha256_recorded_at']) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'farmer_documents'
                     AND column_name = f)
    THEN missing := missing || ('column farmer_documents.' || f); END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'trg_evidence_attachment_digest_dedup' AND NOT tgisinternal)
  THEN missing := missing || 'trigger trg_evidence_attachment_digest_dedup'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'trg_dfe_append_only' AND NOT tgisinternal)
  THEN missing := missing || 'trigger trg_dfe_append_only'; END IF;

  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(missing, ', ');
  END IF;

  -- RLS must be enabled on the new table.
  SELECT c.relrowsecurity INTO rls_on
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'document_field_extractions';
  IF rls_on IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS not enabled on document_field_extractions';
  END IF;

  -- The write RPC must be SECURITY DEFINER with an explicit search_path.
  SELECT p.prosecdef
         AND p.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
    INTO secdef_ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_document_field_extraction';
  IF secdef_ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: record_document_field_extraction is not SECURITY DEFINER with search_path';
  END IF;

  -- The digest lookup must NOT be SECURITY DEFINER. As DEFINER it would bypass
  -- RLS on both surfaces and report other farms' documents to any caller who
  -- guessed a digest. This is the load-bearing security property of PART 2.3.
  SELECT NOT p.prosecdef INTO invoker
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'find_document_digest_matches';
  IF invoker IS NOT TRUE THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: find_document_digest_matches is SECURITY DEFINER — it would '
      'bypass RLS and disclose other farms'' documents by digest';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: all migration-27 objects exist; RLS on; write RPC is SECURITY DEFINER with search_path; digest lookup is SECURITY INVOKER.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- VERIFY B — no client role, and not service_role, holds direct write privilege
-- on document_field_extractions. Every write must go through the RPC.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  leaks text[] := ARRAY[]::text[];
  r     record;
BEGIN
  FOR r IN
    SELECT role_name, priv
    FROM unnest(ARRAY['anon','authenticated','service_role']) AS role_name,
         unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS priv
  LOOP
    IF has_table_privilege(r.role_name, 'public.document_field_extractions', r.priv) THEN
      leaks := leaks || (r.role_name || ':' || r.priv);
    END IF;
  END LOOP;

  IF array_length(leaks,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: direct write privilege(s) present: %',
      array_to_string(leaks, ', ');
  END IF;

  -- Non-vacuity: the grant that SHOULD exist must exist, otherwise this section
  -- would also pass against a table nobody can reach at all.
  IF NOT has_table_privilege('authenticated', 'public.document_field_extractions', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: authenticated lost SELECT — back-office reads would break';
  END IF;
  IF has_table_privilege('anon', 'public.document_field_extractions', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: anon holds SELECT on document_field_extractions';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: anon/authenticated/service_role hold no direct DML; authenticated retains SELECT; anon has none.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — the same bytes cannot be attached twice to ONE response.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  actor    uuid;
  farm_v   uuid;
  prof_v   uuid;
  req_id   uuid;
  resp_id  uuid;
  digest   char(64) := repeat('c', 64);
  ok       boolean := false;
  msg      text;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: no auth.users row to act as creator (fixture unbuildable)';
  END IF;

  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_v) RETURNING id INTO prof_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;

  -- Control: the first attachment carrying this digest must succeed.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_id || '/' || resp_id || '/c1/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 1024, digest, actor, now());

  IF NOT EXISTS (SELECT 1 FROM public.evidence_request_attachments
                 WHERE response_id = resp_id AND sha256_hex = digest) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: control attachment absent (test would be vacuous)';
  END IF;

  -- C1: the SAME bytes under a DIFFERENT filename and path must be refused.
  BEGIN
    INSERT INTO public.evidence_request_attachments
      (request_id, response_id, origin, storage_bucket, storage_object_path,
       upload_state, original_filename, mime_type, size_bytes, sha256_hex,
       created_by_user_id, finalized_at)
    VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
            farm_v || '/' || req_id || '/' || resp_id || '/c2/licence-copy.pdf',
            'ready', 'licence-copy.pdf', 'application/pdf', 1024, digest, actor, now());
  EXCEPTION WHEN unique_violation THEN
    ok := true;
    msg := SQLERRM;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a byte-identical duplicate was accepted on the same response';
  END IF;

  -- The message must name the duplicate, not surface a bare index name: the
  -- friendly trigger of PART 1.3 must be what fired.
  IF msg NOT LIKE '%byte-identical%' THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: duplicate was refused but not by the operator-readable trigger (got: %)', msg;
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a byte-identical duplicate on one response is refused, with a message naming the existing attachment.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — the same digest on a DIFFERENT request/response is still allowed.
-- Proves the rule detects duplication without blocking legitimate recurrence
-- (re-submission after a clarification request; one lab report, two batches).
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  actor    uuid;
  farm_v   uuid;
  prof_v   uuid;
  req_a    uuid;
  req_b    uuid;
  resp_a   uuid;
  resp_b   uuid;
  digest   char(64) := repeat('d', 64);
  n        integer;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_v) RETURNING id INTO prof_v;

  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_a;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_a, 1, 'draft', actor, actor) RETURNING id INTO resp_a;

  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'gacp_evidence',
          'GACP certificate', 'Please upload the current GACP certificate document.', actor)
  RETURNING id INTO req_b;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_b, 1, 'draft', actor, actor) RETURNING id INTO resp_b;

  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_a, resp_a, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_a || '/' || resp_a || '/d/doc.pdf',
          'ready', 'doc.pdf', 'application/pdf', 1024, digest, actor, now());

  -- Same digest, different response — must be ACCEPTED.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_b, resp_b, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_b || '/' || resp_b || '/d/doc.pdf',
          'ready', 'doc.pdf', 'application/pdf', 1024, digest, actor, now());

  SELECT count(*) INTO n FROM public.evidence_request_attachments WHERE sha256_hex = digest;
  IF n <> 2 THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: expected 2 attachments sharing the digest across responses, found %', n;
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: the same digest is accepted on a different response — detection does not over-block legitimate recurrence.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — several PENDING uploads coexist on one response.
-- The unique index is partial on sha256_hex IS NOT NULL; if it were not, the
-- whole reserve-then-finalize flow of migration 24 would break on the second
-- concurrent upload, because a pending attachment has no digest yet.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  actor   uuid;
  farm_v  uuid;
  prof_v  uuid;
  req_id  uuid;
  resp_id uuid;
  n       integer;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_v) RETURNING id INTO prof_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;

  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, created_by_user_id)
  VALUES
    (req_id, resp_id, 'request_upload', 'evidence-request-files',
     farm_v || '/' || req_id || '/' || resp_id || '/e1/a.pdf',
     'pending_upload', 'a.pdf', 'application/pdf', 1024, actor),
    (req_id, resp_id, 'request_upload', 'evidence-request-files',
     farm_v || '/' || req_id || '/' || resp_id || '/e2/b.pdf',
     'pending_upload', 'b.pdf', 'application/pdf', 2048, actor),
    (req_id, resp_id, 'request_upload', 'evidence-request-files',
     farm_v || '/' || req_id || '/' || resp_id || '/e3/c.pdf',
     'pending_upload', 'c.pdf', 'application/pdf', 4096, actor);

  SELECT count(*) INTO n
  FROM public.evidence_request_attachments
  WHERE response_id = resp_id AND upload_state = 'pending_upload' AND sha256_hex IS NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: expected 3 coexisting pending uploads, found %', n;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: multiple digest-less pending uploads coexist on one response — the reserve/finalize flow is unaffected.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — a TOMBSTONED duplicate does not block re-attaching the same file.
-- Migration 24 treats removal_requested_at as an irreversible tombstone, so a
-- removed upload must not permanently reserve its digest against the response.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  actor   uuid;
  farm_v  uuid;
  prof_v  uuid;
  req_id  uuid;
  resp_id uuid;
  digest  char(64) := repeat('f', 64);
  live    integer;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_v) RETURNING id INTO prof_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;

  -- A tombstoned upload holding the digest.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at, removal_requested_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_id || '/' || resp_id || '/f1/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 1024, digest, actor, now(), now());

  -- Re-attaching the same bytes must be ACCEPTED — the tombstone is not live
  -- evidence.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_id || '/' || resp_id || '/f2/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 1024, digest, actor, now());

  SELECT count(*) INTO live
  FROM public.evidence_request_attachments
  WHERE response_id = resp_id AND sha256_hex = digest AND removal_requested_at IS NULL;
  IF live <> 1 THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: expected exactly 1 LIVE attachment holding the digest after re-attach, found %', live;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: a tombstoned upload does not reserve its digest; re-attaching the same file is accepted, and only one live copy exists.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- VERIFY G — farmer_documents digest shape and pairing.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  ok     boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;

  -- Control: a valid digest with its measurement time is accepted.
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_hex, sha256_recorded_at)
  VALUES (farm_v, 'coa', 'coa.pdf', repeat('a', 64), now())
  RETURNING id INTO fd_id;
  IF fd_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: control farmer_documents insert produced no row';
  END IF;

  -- Control: NULL/NULL — an unhashed legacy row stays legal.
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'legacy.pdf');

  -- G1: uppercase hex is refused (digests must be directly comparable across
  -- surfaces without normalisation).
  ok := false;
  BEGIN
    INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_hex, sha256_recorded_at)
    VALUES (farm_v, 'coa', 'upper.pdf', repeat('A', 64), now());
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: an uppercase-hex digest was accepted'; END IF;

  -- G2: a short digest is refused.
  ok := false;
  BEGIN
    INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_hex, sha256_recorded_at)
    VALUES (farm_v, 'coa', 'short.pdf', 'abc123', now());
  EXCEPTION WHEN check_violation OR string_data_right_truncation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: a malformed short digest was accepted'; END IF;

  -- G3: a digest with no measurement time is refused — a number with no
  -- provenance is not evidence.
  ok := false;
  BEGIN
    INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_hex)
    VALUES (farm_v, 'coa', 'unpaired.pdf', repeat('b', 64));
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: a digest without sha256_recorded_at was accepted'; END IF;

  -- G4: a measurement time with no digest is refused too.
  ok := false;
  BEGIN
    INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_recorded_at)
    VALUES (farm_v, 'coa', 'orphan-time.pdf', now());
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: sha256_recorded_at without a digest was accepted'; END IF;

  RAISE NOTICE 'VERIFY G PASSED: farmer_documents accepts a well-formed paired digest and NULL/NULL, and refuses uppercase, malformed, and unpaired digests.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- VERIFY H — a machine-extracted value MUST carry a confidence in [0,1].
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  ok     boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'coa.pdf') RETURNING id INTO fd_id;

  -- Control: with a confidence it is accepted.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
  VALUES ('farmer_document', fd_id, 'total_thc', '0.18', 'machine_extracted', 0.87);

  -- H1: no confidence — refused. An automated reading with no stated confidence
  -- is consumed downstream as though it were certain.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance)
    VALUES ('farmer_document', fd_id, 'total_cbd', '2.4', 'machine_extracted');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY H FAILED: machine_extracted without a confidence was accepted'; END IF;

  -- H2: confidence above 1 — refused.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
    VALUES ('farmer_document', fd_id, 'total_cbd', '2.4', 'machine_extracted', 1.5);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY H FAILED: a confidence above 1 was accepted'; END IF;

  -- H3: negative confidence — refused.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
    VALUES ('farmer_document', fd_id, 'total_cbd', '2.4', 'machine_extracted', -0.1);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY H FAILED: a negative confidence was accepted'; END IF;

  RAISE NOTICE 'VERIFY H PASSED: machine_extracted requires a confidence within [0,1]; absent, >1 and negative are all refused.';
END
$verify_h$;

-- -----------------------------------------------------------------------------
-- VERIFY I — a HUMAN provenance must NOT carry a confidence.
-- Writing 1.0 on a transcription manufactures a certainty score nobody measured,
-- which then gets averaged and thresholded downstream as if it meant something.
-- -----------------------------------------------------------------------------
DO $verify_i$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  p      text;
  ok     boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'coa.pdf') RETURNING id INTO fd_id;

  FOREACH p IN ARRAY ARRAY['reported','operator_entered'] LOOP
    -- Control: with confidence NULL it is accepted.
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance)
    VALUES ('farmer_document', fd_id, 'laboratory_name', 'Example Labs Ltd', p);

    -- Refused with any confidence, including a "certain" 1.0.
    ok := false;
    BEGIN
      INSERT INTO public.document_field_extractions
        (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
      VALUES ('farmer_document', fd_id, 'laboratory_name', 'Example Labs Ltd', p, 1.0);
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    IF NOT ok THEN
      RAISE EXCEPTION 'VERIFY I FAILED: provenance % accepted a fabricated confidence of 1.0', p;
    END IF;
  END LOOP;

  RAISE NOTICE 'VERIFY I PASSED: reported and operator_entered are accepted only with confidence NULL; a fabricated 1.0 is refused.';
END
$verify_i$;

-- -----------------------------------------------------------------------------
-- VERIFY J — an absent value must state why.
-- "No value, no warning" is indistinguishable from "the field is not on the
-- document" and from "we could not read it" — different compliance facts.
-- -----------------------------------------------------------------------------
DO $verify_j$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  ok     boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'coa.pdf') RETURNING id INTO fd_id;

  -- Control: NULL value WITH a warning is accepted.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text,
     provenance, confidence, extraction_warning)
  VALUES ('farmer_document', fd_id, 'mycotoxins_result', NULL,
          'machine_extracted', 0.10, 'page 3 is a scanned image; no text layer for this field');

  -- J1: NULL value with NO warning is refused.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
    VALUES ('farmer_document', fd_id, 'pesticides_result', NULL, 'machine_extracted', 0.10);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY J FAILED: a silent absent value (NULL, no warning) was accepted'; END IF;

  -- J2: a non-detect is preserved as written, not as a numeric zero. "ND" and
  -- "0.0" are different findings and must remain distinguishable.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text, provenance)
  VALUES ('farmer_document', fd_id, 'heavy_metals_result', 'ND', 'reported');

  IF NOT EXISTS (
    SELECT 1 FROM public.document_field_extractions
    WHERE farmer_document_id = fd_id AND field_name = 'heavy_metals_result'
      AND field_value_text = 'ND'
  ) THEN
    RAISE EXCEPTION 'VERIFY J FAILED: the literal value "ND" was not preserved verbatim';
  END IF;

  RAISE NOTICE 'VERIFY J PASSED: an absent value requires a warning; a non-detect "ND" is stored verbatim rather than coerced to zero.';
END
$verify_j$;

-- -----------------------------------------------------------------------------
-- VERIFY K — document_field_extractions is append-only.
-- -----------------------------------------------------------------------------
DO $verify_k$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  ext_id uuid;
  ok     boolean;
  n      integer;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'coa.pdf') RETURNING id INTO fd_id;
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text, provenance, confidence)
  VALUES ('farmer_document', fd_id, 'report_number', 'R-1001', 'machine_extracted', 0.90)
  RETURNING id INTO ext_id;

  IF ext_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY K FAILED: fixture extraction absent (test would be vacuous)';
  END IF;

  -- K1: UPDATE refused. This runs as the migration owner — a privileged role —
  -- and must still be refused.
  ok := false;
  BEGIN
    UPDATE public.document_field_extractions SET field_value_text = 'R-9999' WHERE id = ext_id;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY K FAILED: an extraction row was updated in place'; END IF;

  -- K2: DELETE refused.
  ok := false;
  BEGIN
    DELETE FROM public.document_field_extractions WHERE id = ext_id;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY K FAILED: an extraction row was deleted'; END IF;

  -- K3: the correction path — a NEW row supersedes without erasing.
  INSERT INTO public.document_field_extractions
    (document_surface, farmer_document_id, field_name, field_value_text, provenance)
  VALUES ('farmer_document', fd_id, 'report_number', 'R-1001-A', 'operator_entered');

  SELECT count(*) INTO n
  FROM public.document_field_extractions
  WHERE farmer_document_id = fd_id AND field_name = 'report_number';
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY K FAILED: expected the original AND the correction (2 rows), found %', n;
  END IF;

  RAISE NOTICE 'VERIFY K PASSED: UPDATE and DELETE are refused even for a privileged role; a correction is recorded as a new row alongside the original.';
END
$verify_k$;

-- -----------------------------------------------------------------------------
-- VERIFY L — surface discriminator and field-name vocabulary are enforced.
-- -----------------------------------------------------------------------------
DO $verify_l$
DECLARE
  actor  uuid;
  farm_v uuid;
  fd_id  uuid;
  doc_id uuid;
  ok     boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'coa.pdf') RETURNING id INTO fd_id;
  INSERT INTO public.documents (farm_id, document_type, file_name)
  VALUES (farm_v, 'coa', 'inv-coa.pdf') RETURNING id INTO doc_id;

  -- Control: the inventory_document surface works.
  INSERT INTO public.document_field_extractions
    (document_surface, inventory_document_id, field_name, field_value_text, provenance)
  VALUES ('inventory_document', doc_id, 'sample_name', 'Lot 7', 'reported');

  -- L1: surface says farmer_document but the inventory FK is the one set.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, inventory_document_id, field_name, field_value_text, provenance)
    VALUES ('farmer_document', doc_id, 'sample_name', 'Lot 7', 'reported');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: a surface/FK mismatch was accepted'; END IF;

  -- L2: both FKs set.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, inventory_document_id, field_name,
       field_value_text, provenance)
    VALUES ('farmer_document', fd_id, doc_id, 'sample_name', 'Lot 7', 'reported');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: a row naming two documents was accepted'; END IF;

  -- L3: neither FK set.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, field_name, field_value_text, provenance)
    VALUES ('farmer_document', 'sample_name', 'Lot 7', 'reported');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: an extraction naming no document was accepted'; END IF;

  -- L4: an unknown field name.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance)
    VALUES ('farmer_document', fd_id, 'terpene_vibes', 'high', 'reported');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: an unknown field_name was accepted'; END IF;

  -- L5: an unknown provenance.
  ok := false;
  BEGIN
    INSERT INTO public.document_field_extractions
      (document_surface, farmer_document_id, field_name, field_value_text, provenance)
    VALUES ('farmer_document', fd_id, 'sample_name', 'Lot 7', 'vibes_based');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY L FAILED: an unknown provenance was accepted'; END IF;

  RAISE NOTICE 'VERIFY L PASSED: exactly one document FK matching the declared surface is required; unknown field names and provenances are refused.';
END
$verify_l$;

-- -----------------------------------------------------------------------------
-- VERIFY M — the cross-surface digest lookup finds matches on BOTH surfaces.
-- This is the gap the migration exists to close: a COA uploaded through the
-- migration-8 path and the same bytes attached through migration 24 were
-- previously uncomparable.
-- -----------------------------------------------------------------------------
DO $verify_m$
DECLARE
  actor    uuid;
  farm_v   uuid;
  prof_v   uuid;
  req_id   uuid;
  resp_id  uuid;
  fd_id    uuid;
  digest   char(64) := repeat('e', 64);
  surfaces text[];
  n        integer;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_v) RETURNING id INTO prof_v;

  -- Surface 1: the migration-8 COA path.
  INSERT INTO public.farmer_documents (farm_id, document_type, file_name, sha256_hex, sha256_recorded_at)
  VALUES (farm_v, 'coa', 'calli-2026.pdf', digest, now()) RETURNING id INTO fd_id;

  -- Surface 2: the migration-24 attachment path, same bytes.
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_v, 'farm_profile', prof_v, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id, draft_owner_user_id)
  VALUES (req_id, 1, 'draft', actor, actor) RETURNING id INTO resp_id;
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_v || '/' || req_id || '/' || resp_id || '/m/calli-2026.pdf',
          'ready', 'calli-2026.pdf', 'application/pdf', 1024, digest, actor, now());

  SELECT array_agg(DISTINCT surface ORDER BY surface), count(*)
    INTO surfaces, n
  FROM public.find_document_digest_matches(digest);

  IF n < 2 THEN
    RAISE EXCEPTION 'VERIFY M FAILED: expected at least 2 matches for the shared digest, found %', n;
  END IF;
  IF NOT (surfaces @> ARRAY['evidence_request_attachment','farmer_document']) THEN
    RAISE EXCEPTION 'VERIFY M FAILED: lookup did not report both surfaces (got: %)',
      array_to_string(surfaces, ', ');
  END IF;

  -- Non-vacuity: an unrelated digest must return nothing, otherwise the function
  -- could be matching everything.
  SELECT count(*) INTO n FROM public.find_document_digest_matches(repeat('9', 64));
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY M FAILED: an unrelated digest returned % match(es)', n;
  END IF;

  RAISE NOTICE 'VERIFY M PASSED: one digest is matched across both the COA-upload and evidence-attachment surfaces, and an unrelated digest matches nothing.';
END
$verify_m$;

ROLLBACK;
