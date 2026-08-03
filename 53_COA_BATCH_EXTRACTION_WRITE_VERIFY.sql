-- =============================================================================
-- Migration 53 — VERIFY (batch COA extraction write)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- Section C is the one this migration exists for. It builds a pack whose LAST
-- element is admissible to the shape validator but inadmissible to the table,
-- so the failure happens during the INSERT rather than before it, and then
-- proves that NONE of the earlier rows survive. Under the per-row loop this
-- replaces, every earlier row would have been committed by its own transaction
-- and the count would be non-zero.
--
-- Sections D-F prove the refusals, G the admin gate, and H that migration 28's
-- table constraints are still the authority — a batch path that validated shape
-- and then bypassed the constraints would pass every other section here.
--
-- Each section RAISEs `VERIFY <L> FAILED` on the spot, so the first genuine
-- failure aborts under ON_ERROR_STOP=1 and the harness's pass-count guard sees
-- exactly the sections that really ran.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 53_COA_BATCH_EXTRACTION_WRITE_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — catalogue shape and ACL.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing   text[] := ARRAY[]::text[];
  secdef_ok boolean;
  acl       aclitem[];
BEGIN
  IF to_regprocedure('public.record_document_field_extractions_batch(text,uuid,jsonb)') IS NULL THEN
    missing := missing || 'function record_document_field_extractions_batch(text,uuid,jsonb)';
  END IF;

  IF to_regprocedure('public.document_extraction_batch_row_keys()') IS NULL THEN
    missing := missing || 'function document_extraction_batch_row_keys()';
  END IF;

  -- Migration 52's single-row path must SURVIVE. This migration adds a second
  -- write path; it does not replace the first, and a rollback of 53 must be
  -- able to leave a working system behind.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)'
     ) IS NULL THEN
    missing := missing || 'MISSING migration 52 single-row record_document_field_extraction';
  END IF;

  SELECT p.prosecdef AND p.proconfig::text LIKE '%search_path%'
    INTO secdef_ok
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.record_document_field_extractions_batch(text,uuid,jsonb)');

  IF secdef_ok IS NOT TRUE THEN
    missing := missing || 'batch writer is not SECURITY DEFINER with a pinned search_path';
  END IF;

  SELECT p.proacl INTO acl
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.record_document_field_extractions_batch(text,uuid,jsonb)');

  IF acl IS NULL THEN
    missing := missing || 'batch writer has a NULL ACL (EXECUTE defaults to PUBLIC)';
  ELSE
    IF EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE '=X/%') THEN
      missing := missing || 'batch writer grants EXECUTE to PUBLIC';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE 'anon=%') THEN
      missing := missing || 'batch writer grants EXECUTE to anon';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE 'authenticated=X%') THEN
      missing := missing || 'batch writer does not grant EXECUTE to authenticated';
    END IF;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: batch writer exists, is SECURITY DEFINER with a pinned search_path, has a correct ACL, and migration 52''s single-row path survives.';
END
$verify_a$;


-- -----------------------------------------------------------------------------
-- VERIFY B–H — behavioural.
-- -----------------------------------------------------------------------------
DO $verify_behaviour$
DECLARE
  v_admin_user uuid := '00530000-0000-4000-a000-00000000e001';
  v_other_user uuid := '00530000-0000-4000-a000-00000000e002';
  v_farm       uuid;
  v_doc        uuid;
  v_doc2       uuid;
  v_written    integer;
  v_rows       bigint;
  v_thc_1      text;
  v_thc_2      text;
  v_big        jsonb;
  v_bad        text[] := ARRAY[]::text[];
BEGIN
  -- ── Fixtures ─────────────────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_admin_user, 'admin53@verify.test'), (v_other_user, 'other53@verify.test')
  ON CONFLICT (id) DO NOTHING;

  -- DO UPDATE, not DO NOTHING: handle_new_user() (migration 21) has already
  -- created these profiles as 'pending'. See migration 46's VERIFY.
  INSERT INTO public.profiles (id, email, role) VALUES
    (v_admin_user, 'admin53@verify.test', 'ddp_admin'),
    (v_other_user, 'other53@verify.test', 'farmer')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

  -- PORTABLE COLUMN SETS ONLY — the harness substrate has public.documents as
  -- (id, farm_id, inventory_batch_id, document_type, file_name) and public.farms
  -- as (id, created_by, status, reviewed_by, updated_at).
  INSERT INTO public.farms (status) VALUES ('approved') RETURNING id INTO v_farm;

  INSERT INTO public.documents (farm_id, document_type, file_name)
  VALUES (v_farm, 'coa', 'pack-of-two.pdf') RETURNING id INTO v_doc;

  INSERT INTO public.documents (farm_id, document_type, file_name)
  VALUES (v_farm, 'coa', 'atomicity-probe.pdf') RETURNING id INTO v_doc2;

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'VERIFY B FAILED: fixture admin is not recognised by is_ddp_admin(); every section below would be vacuous.';
  END IF;

  -- ── B. A whole pack in one call ──────────────────────────────────────────
  v_written := public.record_document_field_extractions_batch(
    'inventory_document', v_doc,
    jsonb_build_array(
      jsonb_build_object('field_name','sample_name','field_value_text','Gelato',
        'provenance','machine_extracted','confidence',0.97,'report_ordinal',1,'report_label','TH-2411-0031'),
      jsonb_build_object('field_name','total_thc','field_value_text','24.5',
        'provenance','machine_extracted','confidence',0.98,'report_ordinal',1,'report_label','TH-2411-0031'),
      jsonb_build_object('field_name','sample_name','field_value_text','Jell Breath',
        'provenance','machine_extracted','confidence',0.95,'report_ordinal',2,'report_label','TH-2411-0032'),
      jsonb_build_object('field_name','total_thc','field_value_text','19.8',
        'provenance','machine_extracted','confidence',0.96,'report_ordinal',2,'report_label','TH-2411-0032')
    ));

  IF v_written <> 4 THEN
    v_bad := v_bad || format('the batch writer reported %s rows written, expected 4', v_written);
  END IF;

  SELECT count(*) INTO v_rows
  FROM public.document_field_extractions WHERE inventory_document_id = v_doc;
  IF v_rows <> 4 THEN
    v_bad := v_bad || format('found %s rows in the table, expected 4', v_rows);
  END IF;

  -- Migration 52's grouping must survive the batch path.
  SELECT max(field_value_text) INTO v_thc_1
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND report_ordinal = 1 AND field_name = 'total_thc';
  SELECT max(field_value_text) INTO v_thc_2
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND report_ordinal = 2 AND field_name = 'total_thc';

  IF v_thc_1 IS DISTINCT FROM '24.5' OR v_thc_2 IS DISTINCT FROM '19.8' THEN
    v_bad := v_bad || format('grouping lost through the batch path (report 1 thc=%L, report 2 thc=%L)', v_thc_1, v_thc_2);
  END IF;

  -- Attribution must come from auth.uid(), not from the payload.
  IF EXISTS (SELECT 1 FROM public.document_field_extractions
             WHERE inventory_document_id = v_doc AND recorded_by_user_id IS DISTINCT FROM v_admin_user) THEN
    v_bad := v_bad || 'recorded_by_user_id was not stamped from auth.uid()';
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: a four-row two-report pack was written in ONE call, grouped correctly, attributed to auth.uid().';

  -- ── C. ATOMICITY — the reason this migration exists ──────────────────────
  --
  -- The last element carries a field_name that is NOT in
  -- document_extraction_field_names(). It passes the shape validator (it is a
  -- non-null string under a permitted key) and is refused by the table's
  -- dfe_field_name_check DURING the INSERT — so this proves the insert itself
  -- is all-or-nothing, not merely that validation runs first.
  --
  -- Under the per-row loop this replaces, the three good rows would each have
  -- been committed by their own transaction before the fourth failed.
  v_bad := ARRAY[]::text[];
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(
        jsonb_build_object('field_name','sample_name','field_value_text','Good One',
          'provenance','machine_extracted','confidence',0.9,'report_ordinal',1),
        jsonb_build_object('field_name','total_thc','field_value_text','20.0',
          'provenance','machine_extracted','confidence',0.9,'report_ordinal',1),
        jsonb_build_object('field_name','total_cbd','field_value_text','1.1',
          'provenance','machine_extracted','confidence',0.9,'report_ordinal',1),
        jsonb_build_object('field_name','not_a_real_field','field_value_text','x',
          'provenance','machine_extracted','confidence',0.9,'report_ordinal',1)
      ));
    v_bad := v_bad || 'a pack containing an inadmissible field_name was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT count(*) INTO v_rows
  FROM public.document_field_extractions WHERE inventory_document_id = v_doc2;

  IF v_rows <> 0 THEN
    v_bad := v_bad || format(
      'PARTIAL WRITE: %s rows survived a failed pack — the batch is not atomic, which is the defect this migration exists to close', v_rows);
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: a pack failing on its LAST row wrote ZERO rows — no partial write survives.';

  -- ── D. An empty array is refused ─────────────────────────────────────────
  v_bad := ARRAY[]::text[];
  BEGIN
    PERFORM public.record_document_field_extractions_batch('inventory_document', v_doc2, '[]'::jsonb);
    v_bad := v_bad || 'an empty array was ACCEPTED (success reported for a write of nothing)';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.record_document_field_extractions_batch('inventory_document', v_doc2, '{}'::jsonb);
    v_bad := v_bad || 'a JSON object was ACCEPTED where an array is required';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: an empty array and a non-array payload are both refused.';

  -- ── E. An unknown key is refused, not ignored ────────────────────────────
  v_bad := ARRAY[]::text[];
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(
        jsonb_build_object('field_name','sample_name','field_value_text','Typo',
          'provenance','machine_extracted','confidence',0.9,'report_ordnal',1)
      ));
    v_bad := v_bad || 'a row with a misspelled key was ACCEPTED (it would have been stored with a NULL ordinal)';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: a misspelled key is refused rather than silently producing an ungrouped row.';

  -- ── F. The per-call ceiling holds ────────────────────────────────────────
  v_bad := ARRAY[]::text[];
  SELECT jsonb_agg(jsonb_build_object(
           'field_name','other','field_value_text','x',
           'provenance','machine_extracted','confidence',0.9,'report_ordinal',1))
    INTO v_big
  FROM generate_series(1, 1001);

  BEGIN
    PERFORM public.record_document_field_extractions_batch('inventory_document', v_doc2, v_big);
    v_bad := v_bad || '1001 rows were ACCEPTED past the per-call maximum of 1000';
  EXCEPTION WHEN program_limit_exceeded THEN
    NULL;
  END;

  SELECT count(*) INTO v_rows
  FROM public.document_field_extractions WHERE inventory_document_id = v_doc2;
  IF v_rows <> 0 THEN
    v_bad := v_bad || format('%s rows survived the over-size refusal', v_rows);
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: a payload above the per-call ceiling is refused and writes nothing.';

  -- ── G. The admin gate ────────────────────────────────────────────────────
  v_bad := ARRAY[]::text[];
  PERFORM set_config('request.jwt.claim.sub', v_other_user::text, true);
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(jsonb_build_object('field_name','sample_name','field_value_text','Not Admin',
        'provenance','machine_extracted','confidence',0.9,'report_ordinal',1)));
    v_bad := v_bad || 'a non-admin WROTE a pack';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- The case a service-role connection presents: a valid role, no auth.uid().
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(jsonb_build_object('field_name','sample_name','field_value_text','No Session',
        'provenance','machine_extracted','confidence',0.9,'report_ordinal',1)));
    v_bad := v_bad || 'a caller with NO auth.uid() WROTE a pack';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY G PASSED: non-admin and session-less callers are both refused by the batch path.';

  -- ── H. The table is still the authority ──────────────────────────────────
  --
  -- A batch path that validated shape and then slipped past migration 28's
  -- constraints would have passed every section above. These three are the
  -- constraints most worth re-proving through the new door.
  v_bad := ARRAY[]::text[];

  -- 28 §3.5: a missing value must say why.
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(jsonb_build_object('field_name','total_cbd','field_value_text',NULL,
        'provenance','machine_extracted','confidence',0.4,'report_ordinal',1)));
    v_bad := v_bad || 'a NULL value with no warning was ACCEPTED (28 §3.5 bypassed)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 28 §3.4: machine_extracted requires a confidence.
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(jsonb_build_object('field_name','sample_name','field_value_text','No Confidence',
        'provenance','machine_extracted','report_ordinal',1)));
    v_bad := v_bad || 'machine_extracted with a NULL confidence was ACCEPTED (28 §3.4 bypassed)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 52: the ordinal bound.
  BEGIN
    PERFORM public.record_document_field_extractions_batch(
      'inventory_document', v_doc2,
      jsonb_build_array(jsonb_build_object('field_name','sample_name','field_value_text','Zero Ordinal',
        'provenance','machine_extracted','confidence',0.9,'report_ordinal',0)));
    v_bad := v_bad || 'report_ordinal 0 was ACCEPTED (migration 52 bypassed)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT count(*) INTO v_rows
  FROM public.document_field_extractions WHERE inventory_document_id = v_doc2;
  IF v_rows <> 0 THEN
    v_bad := v_bad || format('%s rows survived the constraint refusals', v_rows);
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY H FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY H PASSED: migrations 28 and 52 constraints are still enforced through the batch path, and no refusal wrote anything.';
END
$verify_behaviour$;

ROLLBACK;
