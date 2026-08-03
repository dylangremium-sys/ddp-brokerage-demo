-- =============================================================================
-- Migration 52 — VERIFY (COA multi-report grouping)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- These are BEHAVIOURAL checks. Section B is the one that matters and the one
-- that would have caught the defect migration 52 exists to close: it writes a
-- two-report pack through the sanctioned RPC and proves the two reports read
-- back apart. Run section B against the pre-52 database and it fails — the
-- reports collapse into one.
--
-- Sections C–E prove the constraints refuse what they claim to refuse AND still
-- permit the adjacent legitimate case. A CHECK that over-blocked would pass a
-- refusal-only test while making every migration-28 row unwritable.
--
-- Section G re-proves the admin gate. Migration 52 DROPs and recreates the write
-- function, and a dropped function loses its ACL; a recreate that forgot the
-- REVOKE would leave a SECURITY DEFINER writer reachable by anon. Migration 28's
-- own VERIFY would not notice, because it never calls the function — it only
-- checks that the function exists and is SECURITY DEFINER.
--
-- Each section RAISEs `VERIFY <L> FAILED` on the spot rather than accumulating,
-- so the first genuine failure aborts under ON_ERROR_STOP=1 and the harness's
-- pass-count guard sees exactly the sections that really ran. A section that
-- cannot build its fixture RAISEs too, so the script can never pass vacuously.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 52_COA_REPORT_GROUPING_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — catalogue shape, signature and ACL.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing    text[] := ARRAY[]::text[];
  c          text;
  cols       text[] := ARRAY['report_ordinal','report_label'];
  con        text;
  cons       text[] := ARRAY['dfe_report_ordinal_positive_check',
                             'dfe_report_label_needs_ordinal_check'];
  idx        text;
  idxs       text[] := ARRAY['idx_dfe_farmer_document_report',
                             'idx_dfe_inventory_document_report'];
  secdef_ok  boolean;
  acl        aclitem[];
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                     AND table_name   = 'document_field_extractions'
                     AND column_name  = c)
    THEN missing := missing || ('column ' || c); END IF;
  END LOOP;

  FOREACH con IN ARRAY cons LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.document_field_extractions'::regclass
                     AND conname  = con)
    THEN missing := missing || ('constraint ' || con); END IF;
  END LOOP;

  FOREACH idx IN ARRAY idxs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = 'public' AND indexname = idx)
    THEN missing := missing || ('index ' || idx); END IF;
  END LOOP;

  -- The NINE-argument signature must exist.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)'
     ) IS NULL THEN
    missing := missing || 'function record_document_field_extraction(...,integer,text)';
  END IF;

  -- ...and the SEVEN-argument one must NOT.
  --
  -- This is the assertion that makes the migration safe rather than cosmetic.
  -- PostgreSQL overloads on signature: had migration 52 used CREATE OR REPLACE
  -- and merely appended two defaulted parameters, BOTH functions would exist.
  -- Every existing seven-argument caller would bind to the OLD one and write
  -- report_ordinal NULL — the exact defect this migration closes — while every
  -- other check in this section passed.
  IF to_regprocedure(
       'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text)'
     ) IS NOT NULL THEN
    missing := missing || 'STALE 7-arg record_document_field_extraction still exists (overload hazard)';
  END IF;

  SELECT p.prosecdef AND p.proconfig::text LIKE '%search_path%'
    INTO secdef_ok
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(
    'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)');

  IF secdef_ok IS NOT TRUE THEN
    missing := missing || 'record_document_field_extraction is not SECURITY DEFINER with a pinned search_path';
  END IF;

  -- The recreate must not have left EXECUTE at PostgreSQL's PUBLIC default.
  SELECT p.proacl INTO acl
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(
    'public.record_document_field_extraction(text,uuid,text,text,text,numeric,text,integer,text)');

  IF acl IS NULL THEN
    missing := missing || 'record_document_field_extraction has a NULL ACL (EXECUTE defaults to PUBLIC)';
  ELSE
    IF EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE '=X/%') THEN
      missing := missing || 'record_document_field_extraction grants EXECUTE to PUBLIC';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE 'anon=%') THEN
      missing := missing || 'record_document_field_extraction grants EXECUTE to anon';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(acl) a WHERE a::text LIKE 'authenticated=X%') THEN
      missing := missing || 'record_document_field_extraction does not grant EXECUTE to authenticated';
    END IF;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: columns, constraints, indexes, 9-arg signature, no stale 7-arg overload, ACL correct.';
END
$verify_a$;


-- -----------------------------------------------------------------------------
-- VERIFY B–H — behavioural. One transaction, fixtures discarded at ROLLBACK.
-- -----------------------------------------------------------------------------
DO $verify_behaviour$
DECLARE
  v_admin_user uuid := '00520000-0000-4000-a000-00000000e001';
  v_other_user uuid := '00520000-0000-4000-a000-00000000e002';
  v_farm       uuid;
  v_doc        uuid;
  v_strain_1   text;
  v_strain_2   text;
  v_thc_1      text;
  v_thc_2      text;
  v_num_1      text;
  v_num_2      text;
  v_label_1    text;
  v_rows       bigint;
  v_id         uuid;
  v_bad        text[] := ARRAY[]::text[];
BEGIN
  -- ── Fixtures ─────────────────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_admin_user, 'admin52@verify.test'), (v_other_user, 'other52@verify.test')
  ON CONFLICT (id) DO NOTHING;

  -- DO UPDATE, NOT DO NOTHING — load-bearing, and documented at length in
  -- migration 46's VERIFY. auth.users carries on_auth_user_created ->
  -- handle_new_user() (migration 21), which has ALREADY inserted a profile with
  -- role 'pending' by the time this runs. ON CONFLICT DO NOTHING would silently
  -- leave it 'pending', is_ddp_admin() would return false, and every section
  -- below would fail as though migration 52 were broken.
  INSERT INTO public.profiles (id, email, role) VALUES
    (v_admin_user, 'admin52@verify.test', 'ddp_admin'),
    (v_other_user, 'other52@verify.test', 'farmer')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

  -- PORTABLE COLUMN SETS ONLY. The disposable harness bootstraps a minimal
  -- substrate: public.farms is (id, created_by, status, reviewed_by,
  -- updated_at) and public.documents is (id, farm_id, inventory_batch_id,
  -- document_type, file_name). file_url, expiry_date and review_status exist on
  -- Supabase and NOT there; naming them passes against staging and fails the
  -- harness. Nothing here needs them.
  INSERT INTO public.farms (status) VALUES ('approved') RETURNING id INTO v_farm;

  INSERT INTO public.documents (farm_id, document_type, file_name)
  VALUES (v_farm, 'coa', 'pack-of-five.pdf')
  RETURNING id INTO v_doc;

  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: fixture document could not be created; the run would be vacuous.';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'VERIFY B FAILED: fixture admin is not recognised by is_ddp_admin(); every section below would be vacuous.';
  END IF;

  -- ── B. The defect this migration closes ──────────────────────────────────
  --
  -- Two reports from one PDF, written INTERLEAVED on purpose: report 2's
  -- sample_name lands before report 1's total_thc. Writing them grouped would
  -- let a broken implementation pass by accident of insertion order.
  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'sample_name', 'Gelato',
    'machine_extracted', 0.97, NULL, 1, 'TH-2411-0031');

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'sample_name', 'Jell Breath',
    'machine_extracted', 0.95, NULL, 2, 'TH-2411-0032');

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'total_thc', '24.5',
    'machine_extracted', 0.98, NULL, 1, 'TH-2411-0031');

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'total_thc', '19.8',
    'machine_extracted', 0.96, NULL, 2, 'TH-2411-0032');

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'report_number', 'TH-2411-0031',
    'machine_extracted', 0.99, NULL, 1, 'TH-2411-0031');

  PERFORM public.record_document_field_extraction(
    'inventory_document', v_doc, 'report_number', 'TH-2411-0032',
    'machine_extracted', 0.99, NULL, 2, 'TH-2411-0032');

  SELECT max(field_value_text) FILTER (WHERE field_name = 'sample_name'),
         max(field_value_text) FILTER (WHERE field_name = 'total_thc'),
         max(field_value_text) FILTER (WHERE field_name = 'report_number'),
         max(report_label)
    INTO v_strain_1, v_thc_1, v_num_1, v_label_1
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND report_ordinal = 1;

  SELECT max(field_value_text) FILTER (WHERE field_name = 'sample_name'),
         max(field_value_text) FILTER (WHERE field_name = 'total_thc'),
         max(field_value_text) FILTER (WHERE field_name = 'report_number')
    INTO v_strain_2, v_thc_2, v_num_2
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc AND report_ordinal = 2;

  IF v_strain_1 IS DISTINCT FROM 'Gelato' OR v_thc_1 IS DISTINCT FROM '24.5'
     OR v_num_1 IS DISTINCT FROM 'TH-2411-0031' THEN
    v_bad := v_bad || format('report 1 did not read back intact (sample_name=%L total_thc=%L report_number=%L)',
                             v_strain_1, v_thc_1, v_num_1);
  END IF;

  IF v_strain_2 IS DISTINCT FROM 'Jell Breath' OR v_thc_2 IS DISTINCT FROM '19.8'
     OR v_num_2 IS DISTINCT FROM 'TH-2411-0032' THEN
    v_bad := v_bad || format('report 2 did not read back intact (sample_name=%L total_thc=%L report_number=%L)',
                             v_strain_2, v_thc_2, v_num_2);
  END IF;

  -- The headline assertion, stated as the harm: one strain's cannabinoid figure
  -- must never surface under another strain's report number.
  IF v_thc_1 = v_thc_2 THEN
    v_bad := v_bad || 'both reports carry the SAME total_thc — the pack has been merged';
  END IF;

  IF v_label_1 IS DISTINCT FROM 'TH-2411-0031' THEN
    v_bad := v_bad || format('report_label not stored (got %L)', v_label_1);
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: a two-report pack written interleaved reads back as two intact reports.';

  -- ── C. Ordinal below 1 is refused ────────────────────────────────────────
  v_bad := ARRAY[]::text[];
  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'sample_name', 'Zero Ordinal',
      'machine_extracted', 0.9, NULL, 0, NULL);
    v_bad := v_bad || 'report_ordinal 0 was ACCEPTED (two encodings of "the first report")';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'sample_name', 'Negative Ordinal',
      'machine_extracted', 0.9, NULL, -1, NULL);
    v_bad := v_bad || 'report_ordinal -1 was ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: report_ordinal 0 and -1 are refused.';

  -- ── D. A label with no ordinal is refused ────────────────────────────────
  v_bad := ARRAY[]::text[];
  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'sample_name', 'Orphan Label',
      'machine_extracted', 0.9, NULL, NULL, 'TH-2411-0099');
    v_bad := v_bad || 'report_label with NULL report_ordinal was ACCEPTED (names a report it is not grouped with)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: a report_label without a report_ordinal is refused.';

  -- ── E. The adjacent legitimate cases still work ──────────────────────────
  --
  -- Every row written before migration 52 has a NULL ordinal. A CHECK that
  -- over-blocked would make the whole pre-existing table unwritable, and a
  -- refusal-only test would not notice.
  v_bad := ARRAY[]::text[];
  BEGIN
    v_id := public.record_document_field_extraction(
      'inventory_document', v_doc, 'laboratory_name', 'Bangkok Analytical',
      'machine_extracted', 0.93, NULL, NULL, NULL);
    IF v_id IS NULL THEN
      v_bad := v_bad || 'an unattributed row returned a NULL id';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_bad := v_bad || format('a migration-28-shaped row (NULL ordinal) was REFUSED: %s', SQLERRM);
  END;

  -- Migration 28 §3.5 must survive: a missing value still has to name a reason.
  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'total_cbd', NULL,
      'machine_extracted', 0.4, NULL, 1, 'TH-2411-0031');
    v_bad := v_bad || 'a NULL value with a NULL warning was ACCEPTED (migration 28 §3.5 lost)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: unattributed (NULL-ordinal) rows still write, and migration 28 §3.5 still holds.';

  -- ── F. Append-only survives the new columns ──────────────────────────────
  v_bad := ARRAY[]::text[];
  BEGIN
    UPDATE public.document_field_extractions
       SET report_ordinal = 2
     WHERE inventory_document_id = v_doc AND report_ordinal = 1;
    v_bad := v_bad || 'UPDATE of report_ordinal was ACCEPTED (append-only trigger bypassed)';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: the append-only trigger still refuses UPDATE, including of the new columns.';

  -- ── G. The admin gate survived the DROP/CREATE ───────────────────────────
  v_bad := ARRAY[]::text[];
  PERFORM set_config('request.jwt.claim.sub', v_other_user::text, true);
  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'sample_name', 'Not An Admin',
      'machine_extracted', 0.9, NULL, 3, NULL);
    v_bad := v_bad || 'a non-admin WROTE an extraction row (admin gate lost in the recreate)';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- A caller with no session at all must also be refused. This is the case a
  -- service-role connection presents: a valid database role, no auth.uid().
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.record_document_field_extraction(
      'inventory_document', v_doc, 'sample_name', 'No Session',
      'machine_extracted', 0.9, NULL, 4, NULL);
    v_bad := v_bad || 'a caller with NO auth.uid() WROTE an extraction row';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_bad, ' | ');
  END IF;
  RAISE NOTICE 'VERIFY G PASSED: non-admin and session-less callers are both refused by the recreated function.';

  -- ── H. No refusal above wrote anyway ─────────────────────────────────────
  --
  -- Six rows from B, one from E. Every other call in C, D, E and G was supposed
  -- to be refused; this counts them rather than trusting that the EXCEPTION
  -- handlers were reached.
  SELECT count(*) INTO v_rows
  FROM public.document_field_extractions
  WHERE inventory_document_id = v_doc;

  IF v_rows <> 7 THEN
    RAISE EXCEPTION 'VERIFY H FAILED: expected exactly 7 rows for the fixture document, found % — a refusal above wrote anyway', v_rows;
  END IF;
  RAISE NOTICE 'VERIFY H PASSED: exactly 7 rows written; every refusal above left the table unchanged.';
END
$verify_behaviour$;

ROLLBACK;
