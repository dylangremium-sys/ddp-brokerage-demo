-- =============================================================================
-- Migration 52 — PRE-MIGRATION DEFECT CHARACTERISATION
--
-- This script runs as the VERIFY stage of a fixture that applies migrations 24
-- and 28 and NOT 52. It asserts that the defect migration 52 closes is really
-- there, on a real PostgreSQL cluster, using only migration 28's own sanctioned
-- write path.
--
-- WHY THIS FILE EXISTS
-- 52's VERIFY passing tells us the new database behaves. It does NOT tell us the
-- old one misbehaved — a test can pass because the thing it checks was never
-- broken, and a migration justified by a defect nobody demonstrated is a
-- migration justified by an argument. This is the counterfactual: the same
-- five-report scenario, on the schema as it stands in production today.
--
-- It is deliberately written to FAIL if the defect is absent. If migration 28
-- somehow already distinguished reports, this script raises and the premise of
-- migration 52 is wrong — which is exactly what we would want to find out.
--
-- No tracked migration file is modified to produce this failure; the pre-52
-- state is reached by simply not applying 52.
--
-- Runs inside one transaction ending in ROLLBACK. No COMMIT.
-- =============================================================================

BEGIN;

DO $characterise$
DECLARE
  v_admin_user  uuid := '00520000-0000-4000-a000-00000000d001';
  v_farm        uuid;
  v_doc         uuid;
  v_thc_values  bigint;
  v_thc_latest  bigint;
  v_name_latest bigint;
  v_distinct    bigint;
  v_findings    text[] := ARRAY[]::text[];
BEGIN
  -- The 9-argument function must NOT exist here. If it does, the fixture has
  -- applied migration 52 by mistake and everything below would be meaningless.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: migration 52 appears to be applied — this fixture must run on the PRE-52 schema, so the run would be meaningless.';
  END IF;

  INSERT INTO auth.users (id, email) VALUES (v_admin_user, 'char52@verify.test')
  ON CONFLICT (id) DO NOTHING;

  -- DO UPDATE, not DO NOTHING: handle_new_user() has already made this profile
  -- 'pending'. See migration 46's VERIFY for the full account.
  INSERT INTO public.profiles (id, email, role)
  VALUES (v_admin_user, 'char52@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

  INSERT INTO public.farms (status) VALUES ('approved') RETURNING id INTO v_farm;

  INSERT INTO public.documents (farm_id, document_type, file_name)
  VALUES (v_farm, 'coa', 'pack-of-two.pdf')
  RETURNING id INTO v_doc;

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'VERIFY A FAILED: fixture admin not recognised; the run would be vacuous.';
  END IF;

  -- ── The scenario ─────────────────────────────────────────────────────────
  --
  -- One PDF, two laboratory reports, written through migration 28's function
  -- exactly as a correct pre-52 implementation would have to write them. There
  -- is no parameter in which to record that these are two different reports,
  -- because that is the defect.
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'sample_name', 'Gelato', 'machine_extracted', 0.97);
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'total_thc', '24.5', 'machine_extracted', 0.98);
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'report_number', 'TH-2411-0031', 'machine_extracted', 0.99);

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'sample_name', 'Jell Breath', 'machine_extracted', 0.95);
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'total_thc', '19.8', 'machine_extracted', 0.96);
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'report_number', 'TH-2411-0032', 'machine_extracted', 0.99);

  -- ── Finding 1: both readings are stored, and nothing groups them ─────────
  SELECT count(*) INTO v_thc_values
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND field_name = 'total_thc';

  IF v_thc_values <> 2 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: expected 2 total_thc rows, found % — the fixture did not write what it intended.', v_thc_values;
  END IF;

  -- Is there ANY column that could separate them? Migration 28's table has no
  -- report discriminator, so the only candidate is extracted_at.
  --
  -- ── Finding 2: extracted_at cannot separate them either ──────────────────
  --
  -- Migration 28 §3.3 defines the current value of a field as "its most recent
  -- row by extracted_at". The column defaults to now(), which in PostgreSQL is
  -- the TRANSACTION timestamp — constant for every row written in one
  -- transaction. A whole pack is persisted in one transaction, so every row
  -- ties, and "the most recent row" does not identify a row at all.
  SELECT count(*) INTO v_thc_latest
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc
    AND field_name = 'total_thc'
    AND extracted_at = (
      SELECT max(extracted_at) FROM public.document_field_extractions
      WHERE inventory_document_id = v_doc AND field_name = 'total_thc');

  SELECT count(*) INTO v_name_latest
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc
    AND field_name = 'sample_name'
    AND extracted_at = (
      SELECT max(extracted_at) FROM public.document_field_extractions
      WHERE inventory_document_id = v_doc AND field_name = 'sample_name');

  IF v_thc_latest < 2 THEN
    v_findings := v_findings || format(
      'total_thc has a UNIQUE latest row (%s tied) — extracted_at does separate the reports, so the premise of migration 52 needs revisiting',
      v_thc_latest);
  END IF;

  IF v_name_latest < 2 THEN
    v_findings := v_findings || format(
      'sample_name has a UNIQUE latest row (%s tied) — extracted_at does separate the reports',
      v_name_latest);
  END IF;

  -- ── Finding 3: the harm, stated directly ─────────────────────────────────
  --
  -- A consumer assembling "this document's COA" gets one strain name and one
  -- THC figure. Which ones is decided by physical row order, because every
  -- candidate ties on the only ordering column available. Two distinct
  -- certificates have become one, and the surviving pair need not even come
  -- from the same report.
  SELECT count(DISTINCT field_value_text) INTO v_distinct
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND field_name = 'total_thc';

  IF v_distinct <> 2 THEN
    v_findings := v_findings || format('expected 2 distinct total_thc readings, found %s', v_distinct);
  END IF;

  IF array_length(v_findings, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the pre-52 defect was NOT reproduced — %', array_to_string(v_findings, ' | ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: pre-52 defect reproduced on real PostgreSQL — two reports, % tied total_thc rows and % tied sample_name rows under one document, with no column able to tell them apart. Any "current value" read is indeterminate.',
    v_thc_latest, v_name_latest;
END
$characterise$;

ROLLBACK;
