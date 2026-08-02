-- =============================================================================
-- Migration 42 — VERIFY: the export eligibility gate
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure
--   B — FAIL CLOSED: against an empty world every one of the seven conditions
--       fails and the gate blocks. This is the single most important assertion
--       in the migration, because the three likeliest early production states
--       (no ruleset researched, screening never run, permit not captured) are
--       all "absence", and absence must never read as permission.
--   C — a fully-satisfied scenario PASSES. Without this, B could be satisfied by
--       a gate that blocks everything unconditionally.
--   D — ONE-AT-A-TIME: from the passing scenario, break each condition
--       individually and assert that exactly that condition flips to false.
--   E — headroom arithmetic at the gate, including the exact-fit boundary
--   F — point-in-time: the same consignment passes on a date when the permit was
--       in force and blocks today
--   G — evaluations are append-only; overrides are immutable, need a real
--       reason, must name specific conditions, and cannot be self-reviewed
--   H — the pending-review report surfaces unreviewed overrides and clears them
--       once reviewed
--   I — a non-admin cannot run the gate, and anon holds nothing
--
-- Expected on success: nine PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- Shared fixture identities.
CREATE TEMP TABLE v42 (k text PRIMARY KEY, v uuid) ON COMMIT DROP;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['screening_checks', 'export_eligibility_evaluations', 'export_gate_overrides'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN v_missing := array_append(v_missing, 'table ' || t); END IF;
  END LOOP;

  IF to_regclass('public.export_gate_overrides_pending_review') IS NULL THEN
    v_missing := array_append(v_missing, 'view export_gate_overrides_pending_review');
  END IF;

  FOREACH f IN ARRAY ARRAY['evaluate_export_eligibility', 'screening_is_clear',
                           'fn_guard_override_mutation', 'prevent_evaluation_mutation'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname=f) THEN
      v_missing := array_append(v_missing, 'function ' || f);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: three tables, the pending-review view, the gate function and all three guard functions are present.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. Fail closed against an empty world
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_admin  uuid := '00420000-0000-4000-a000-00000000ad01';
  v_buyer  uuid;
  v_export uuid;
  v_result jsonb;
  v_cond   text;
  v_failed_all boolean := true;
  v_conditions text[] := ARRAY['destination_ruleset_resolved', 'buyer_verified',
                               'buyer_import_permit_valid', 'permit_headroom_sufficient',
                               'exporter_licence_valid', 'batch_releasable', 'screening_clear'];
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_admin, 'admin42@verify.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES (v_admin, 'admin42@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- An unverified buyer and an unlicensed exporter, nothing else on file.
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Empty World Import GmbH', 'DE') RETURNING id INTO v_buyer;
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('broker', 'Empty World Exporter Co', 'TH') RETURNING id INTO v_export;

  INSERT INTO v42 VALUES ('empty_buyer', v_buyer), ('empty_export', v_export), ('admin', v_admin);

  v_result := public.evaluate_export_eligibility(
    'CONS-EMPTY', v_buyer, v_export, 'controlled_herb', 'DE', 10.000, NULL, current_date);

  IF v_result->>'outcome' <> 'blocked' THEN
    RAISE EXCEPTION 'VERIFY B FAILED: the gate PASSED a consignment with no ruleset, no permit, no licence, no COA and no screening. Outcome was %.', v_result->>'outcome';
  END IF;

  FOREACH v_cond IN ARRAY v_conditions LOOP
    IF (v_result->'conditions'->v_cond->>'pass')::boolean IS DISTINCT FROM false THEN
      v_failed_all := false;
      RAISE NOTICE 'condition % did not fail: %', v_cond, v_result->'conditions'->v_cond;
    END IF;
  END LOOP;

  IF NOT v_failed_all THEN
    RAISE EXCEPTION 'VERIFY B FAILED: at least one condition did not fail closed against an empty world. See the notices above.';
  END IF;

  IF jsonb_array_length(v_result->'blocking_reasons') < 7 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: expected at least 7 blocking reasons, got %.',
      jsonb_array_length(v_result->'blocking_reasons');
  END IF;

  -- The evaluation must have been RECORDED, not merely returned.
  IF NOT EXISTS (SELECT 1 FROM public.export_eligibility_evaluations
                 WHERE id = (v_result->>'evaluation_id')::uuid AND outcome = 'blocked') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: the blocked evaluation was not recorded.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: against an empty world all seven conditions fail, the gate blocks with seven or more reasons, and the refusal is recorded.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. A fully-satisfied scenario passes
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_admin  uuid := (SELECT v FROM v42 WHERE k='admin');
  v_buyer  uuid;
  v_export uuid;
  v_farm   uuid := '00420000-0000-4000-a000-0000000000f1';
  v_batch  uuid := '00420000-0000-4000-a000-0000000000b1';
  v_result jsonb;
  v_cond   text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.organisations (org_type, legal_name, country_code, verification_state, verified_by, verified_at)
  VALUES ('buyer', 'Good Standing Import GmbH', 'DE', 'verified', v_admin, now())
  RETURNING id INTO v_buyer;

  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('broker', 'Good Standing Exporter Co', 'TH') RETURNING id INTO v_export;

  INSERT INTO v42 VALUES ('ok_buyer', v_buyer), ('ok_export', v_export), ('ok_batch', v_batch);

  -- Ruleset
  INSERT INTO public.destination_rulesets (country_code, regime, version, effective_from, source_reference)
  VALUES ('DE', 'controlled_herb', 1, current_date - 200, 'BfArM guidance');

  -- Buyer import permit: 100 kg, in force.
  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_buyer, 'import', 'controlled_herb', 'DE', 'DE-GOOD-1',
    current_date - 30, date_part('year', current_date - 30)::int + 543,
    current_date + 30, date_part('year', current_date + 30)::int + 543,
    100.000, 'vault://de-good-1');

  -- Exporter export licence, in force.
  INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
  VALUES (v_export, 'export', 'thai_fda', 'controlled_herb', 'TH-EXP-1',
    current_date - 60, date_part('year', current_date - 60)::int + 543,
    current_date + 60, date_part('year', current_date + 60)::int + 543,
    'vault://th-exp-1');

  -- Batch with an accepted, clean COA.
  INSERT INTO public.farms (id) VALUES (v_farm) ON CONFLICT DO NOTHING;
  INSERT INTO public.inventory_batches (id, farm_id, status) VALUES (v_batch, v_farm, 'Approved')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.farmer_documents (farm_id, inventory_batch_id, document_type, review_status,
    heavy_metals_status, pesticides_status, microbial_status, mycotoxins_status)
  VALUES (v_farm, v_batch, 'coa', 'accepted', 'pass', 'pass', 'pass', 'pass');

  -- Clear screening, in date.
  INSERT INTO public.screening_checks (organisation_id, provider, result, valid_until, evidence_ref)
  VALUES (v_buyer, 'DemoScreen', 'clear', current_date + 90, 'vault://screen-1');

  v_result := public.evaluate_export_eligibility(
    'CONS-GOOD', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);

  IF v_result->>'outcome' <> 'pass' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a fully-satisfied consignment was BLOCKED. Reasons: %',
      v_result->>'blocking_reasons';
  END IF;

  FOREACH v_cond IN ARRAY ARRAY['destination_ruleset_resolved', 'buyer_verified',
                                'buyer_import_permit_valid', 'permit_headroom_sufficient',
                                'exporter_licence_valid', 'batch_releasable', 'screening_clear'] LOOP
    IF (v_result->'conditions'->v_cond->>'pass')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'VERIFY C FAILED: condition % did not pass in the fully-satisfied scenario: %',
        v_cond, v_result->'conditions'->v_cond;
    END IF;
  END LOOP;

  RAISE NOTICE 'VERIFY C PASSED: a consignment with a resolved ruleset, verified buyer, valid permit with headroom, valid export licence, accepted clean COA and current screening passes on all seven conditions.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. One broken thing at a time
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_admin  uuid := (SELECT v FROM v42 WHERE k='admin');
  v_buyer  uuid := (SELECT v FROM v42 WHERE k='ok_buyer');
  v_export uuid := (SELECT v FROM v42 WHERE k='ok_export');
  v_batch  uuid := (SELECT v FROM v42 WHERE k='ok_batch');
  v_result jsonb;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- (a) Wrong destination: a German permit must not clear a shipment to Australia.
  v_result := public.evaluate_export_eligibility(
    'CONS-D-A', v_buyer, v_export, 'controlled_herb', 'AU', 25.000, v_batch, current_date);
  IF v_result->>'outcome' <> 'blocked' THEN
    v_problems := array_append(v_problems, 'a shipment to AU passed on a DE permit');
  END IF;
  IF (v_result->'conditions'->'buyer_import_permit_valid'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'the DE permit was accepted for an AU destination');
  END IF;

  -- (b) Wrong regime: a controlled-herb permit must not clear a Category 5 extract.
  v_result := public.evaluate_export_eligibility(
    'CONS-D-B', v_buyer, v_export, 'narcotic_cat5', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'buyer_import_permit_valid'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a controlled_herb permit was accepted for a narcotic_cat5 consignment');
  END IF;
  IF (v_result->'conditions'->'exporter_licence_valid'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a controlled_herb export licence was accepted for a narcotic_cat5 consignment');
  END IF;

  -- (c) Buyer verification withdrawn.
  UPDATE public.organisations
     SET verification_state = 'suspended', verification_basis = 'licence under review'
   WHERE id = v_buyer;
  v_result := public.evaluate_export_eligibility(
    'CONS-D-C', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'buyer_verified'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a SUSPENDED buyer still passed verification');
  END IF;
  UPDATE public.organisations
     SET verification_state = 'verified', verified_by = v_admin, verified_at = now()
   WHERE id = v_buyer;

  -- (d) A failed contaminant result on the batch.
  INSERT INTO public.farmer_documents (farm_id, inventory_batch_id, document_type, review_status,
    heavy_metals_status, pesticides_status, microbial_status, mycotoxins_status)
  SELECT farm_id, v_batch, 'coa', 'accepted', 'pass', 'fail', 'pass', 'pass'
  FROM public.inventory_batches WHERE id = v_batch;

  v_result := public.evaluate_export_eligibility(
    'CONS-D-D', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'batch_releasable'->>'pass')::boolean THEN
    v_problems := array_append(v_problems,
      'a batch carrying a FAILED pesticide result was releasable because another COA on it was clean');
  END IF;
  DELETE FROM public.farmer_documents WHERE inventory_batch_id = v_batch AND pesticides_status = 'fail';

  -- (e) Stale screening.
  UPDATE public.screening_checks SET valid_until = current_date - 1 WHERE organisation_id = v_buyer;
  v_result := public.evaluate_export_eligibility(
    'CONS-D-E', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'screening_clear'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a screening that expired yesterday still read as clear');
  END IF;
  UPDATE public.screening_checks SET valid_until = current_date + 90 WHERE organisation_id = v_buyer;

  -- (f) A confirmed denied-party match.
  INSERT INTO public.screening_checks (organisation_id, provider, result, valid_until, evidence_ref, notes)
  VALUES (v_buyer, 'DemoScreen', 'confirmed_match', current_date + 90, 'vault://screen-2',
          'Matched against consolidated list entry 4412; escalated to counsel.');
  v_result := public.evaluate_export_eligibility(
    'CONS-D-F', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'screening_clear'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a CONFIRMED denied-party match still read as clear');
  END IF;
  DELETE FROM public.screening_checks WHERE organisation_id = v_buyer AND result = 'confirmed_match';

  -- (g) No batch named at all.
  v_result := public.evaluate_export_eligibility(
    'CONS-D-G', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, NULL, current_date);
  IF (v_result->'conditions'->'batch_releasable'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'a consignment with NO batch was judged releasable');
  END IF;

  -- Sanity: after all repairs the scenario passes again, so the failures above
  -- were caused by what was broken and not by cumulative fixture damage.
  v_result := public.evaluate_export_eligibility(
    'CONS-D-RESTORED', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF v_result->>'outcome' <> 'pass' THEN
    v_problems := array_append(v_problems,
      format('the restored scenario no longer passes, so section D''s results are unreliable: %s',
             v_result->>'blocking_reasons'));
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: wrong destination, wrong regime, suspended buyer, failed contaminant result, stale screening, confirmed denied-party match and a missing batch each block the correct condition — and the scenario passes again once repaired.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Headroom at the gate
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_admin  uuid := (SELECT v FROM v42 WHERE k='admin');
  v_buyer  uuid := (SELECT v FROM v42 WHERE k='ok_buyer');
  v_export uuid := (SELECT v FROM v42 WHERE k='ok_export');
  v_batch  uuid := (SELECT v FROM v42 WHERE k='ok_batch');
  v_permit uuid;
  v_result jsonb;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT id INTO v_permit FROM public.permits WHERE permit_number = 'DE-GOOD-1';

  -- Draw 90 of the 100 kg.
  INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
  VALUES (v_permit, 90.000, 'CONS-EARLIER', 'earlier shipment');

  -- 25 kg no longer fits.
  v_result := public.evaluate_export_eligibility(
    'CONS-E-OVER', v_buyer, v_export, 'controlled_herb', 'DE', 25.000, v_batch, current_date);
  IF (v_result->'conditions'->'permit_headroom_sufficient'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, '25 kg passed against 10 kg of headroom');
  END IF;
  IF v_result->>'outcome' <> 'blocked' THEN
    v_problems := array_append(v_problems, 'the consignment was not blocked despite insufficient headroom');
  END IF;

  -- Exactly 10 kg fits.
  v_result := public.evaluate_export_eligibility(
    'CONS-E-EXACT', v_buyer, v_export, 'controlled_herb', 'DE', 10.000, v_batch, current_date);
  IF NOT (v_result->'conditions'->'permit_headroom_sufficient'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, 'an exact-fit 10 kg consignment was refused');
  END IF;

  -- One gram more does not.
  v_result := public.evaluate_export_eligibility(
    'CONS-E-ONEGRAM', v_buyer, v_export, 'controlled_herb', 'DE', 10.001, v_batch, current_date);
  IF (v_result->'conditions'->'permit_headroom_sufficient'->>'pass')::boolean THEN
    v_problems := array_append(v_problems, '10.001 kg passed against 10 kg of headroom');
  END IF;

  -- A quantity that cannot be compared must be refused outright, not evaluated.
  BEGIN
    v_result := public.evaluate_export_eligibility(
      'CONS-E-NAN', v_buyer, v_export, 'controlled_herb', 'DE', 'NaN'::numeric, v_batch, current_date);
    v_problems := array_append(v_problems, 'a NaN quantity was ACCEPTED by the gate');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: the gate reads live headroom from the draw-down ledger — 25 kg blocked, exactly 10 kg allowed, 10.001 kg blocked, and a NaN quantity refused outright.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. Point in time
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_admin  uuid := (SELECT v FROM v42 WHERE k='admin');
  v_buyer  uuid := (SELECT v FROM v42 WHERE k='ok_buyer');
  v_export uuid := (SELECT v FROM v42 WHERE k='ok_export');
  v_batch  uuid := (SELECT v FROM v42 WHERE k='ok_batch');
  v_result_then jsonb;
  v_result_now  jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Move the permit's window into the past: it was in force a fortnight ago and
  -- lapsed a week ago. Nothing about its stored state changes.
  UPDATE public.permits
     SET issued_on = current_date - 21, issued_on_be_year = date_part('year', current_date - 21)::int + 543,
         expires_on = current_date - 7, expires_on_be_year = date_part('year', current_date - 7)::int + 543
   WHERE permit_number = 'DE-GOOD-1';

  v_result_now := public.evaluate_export_eligibility(
    'CONS-F-NOW', v_buyer, v_export, 'controlled_herb', 'DE', 1.000, v_batch, current_date);
  v_result_then := public.evaluate_export_eligibility(
    'CONS-F-THEN', v_buyer, v_export, 'controlled_herb', 'DE', 1.000, v_batch, current_date - 14);

  IF (v_result_now->'conditions'->'buyer_import_permit_valid'->>'pass')::boolean THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a permit that lapsed a week ago is still accepted today.';
  END IF;
  IF NOT (v_result_then->'conditions'->'buyer_import_permit_valid'->>'pass')::boolean THEN
    RAISE EXCEPTION 'VERIFY F FAILED: the same permit is not accepted on a date when it WAS in force. The gate is not evaluating as-of the shipment date.';
  END IF;

  -- And the record must show which date was used, or the evaluation cannot be
  -- defended later.
  IF NOT EXISTS (SELECT 1 FROM public.export_eligibility_evaluations
                 WHERE consignment_ref = 'CONS-F-THEN' AND evaluated_as_of = current_date - 14) THEN
    RAISE EXCEPTION 'VERIFY F FAILED: the evaluation record does not carry the as-of date it was run for.';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: the same consignment blocks today and passes the permit condition as at a date inside the permit''s term, and the as-of date is recorded on the evaluation.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. Immutability and override discipline
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_admin    uuid := (SELECT v FROM v42 WHERE k='admin');
  v_admin2   uuid := '00420000-0000-4000-a000-00000000ad02';
  v_eval     uuid;
  v_override uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_admin2, 'admin42b@verify.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES (v_admin2, 'admin42b@verify.test', 'ddp_admin')
  ON CONFLICT (id) DO NOTHING;

  SELECT id INTO v_eval FROM public.export_eligibility_evaluations
   WHERE consignment_ref = 'CONS-F-NOW' LIMIT 1;

  -- Evaluations are append-only.
  BEGIN
    UPDATE public.export_eligibility_evaluations SET outcome = 'pass' WHERE id = v_eval;
    v_problems := array_append(v_problems, 'an evaluation outcome was UPDATED');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    DELETE FROM public.export_eligibility_evaluations WHERE id = v_eval;
    v_problems := array_append(v_problems, 'an evaluation was DELETED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- A reason too short to be a reason.
  BEGIN
    INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
    VALUES (v_eval, v_admin, 'ok', ARRAY['buyer_import_permit_valid']);
    v_problems := array_append(v_problems, 'an override with a two-character reason was ADMITTED');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A blanket override naming no conditions.
  BEGIN
    INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
    VALUES (v_eval, v_admin, 'Permit renewal confirmed verbally by the competent authority.', ARRAY[]::text[]);
    v_problems := array_append(v_problems, 'a blanket override naming NO conditions was ADMITTED');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A proper override.
  INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
  VALUES (v_eval, v_admin,
          'Renewed permit received by email from BfArM; scan being filed under vault://de-good-2.',
          ARRAY['buyer_import_permit_valid'])
  RETURNING id INTO v_override;

  -- Immutable in every field that matters.
  BEGIN
    UPDATE public.export_gate_overrides SET reason = 'changed my mind' WHERE id = v_override;
    v_problems := array_append(v_problems, 'an override REASON was rewritten');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    UPDATE public.export_gate_overrides SET approved_by = v_admin2 WHERE id = v_override;
    v_problems := array_append(v_problems, 'an override APPROVER was rewritten');
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    DELETE FROM public.export_gate_overrides WHERE id = v_override;
    v_problems := array_append(v_problems, 'an override was DELETED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Self-review defeats the purpose.
  BEGIN
    UPDATE public.export_gate_overrides
       SET reviewed_by = v_admin, reviewed_at = now() WHERE id = v_override;
    v_problems := array_append(v_problems, 'the approver was allowed to review their OWN override');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A second person may review, once.
  UPDATE public.export_gate_overrides
     SET reviewed_by = v_admin2, reviewed_at = now(), review_note = 'Scan sighted and filed.'
   WHERE id = v_override;

  BEGIN
    UPDATE public.export_gate_overrides
       SET reviewed_at = now() - interval '1 day' WHERE id = v_override;
    v_problems := array_append(v_problems, 'a completed review stamp was REWRITTEN');
  EXCEPTION WHEN others THEN NULL;
  END;

  INSERT INTO v42 VALUES ('override', v_override), ('eval_f', v_eval), ('admin2', v_admin2);

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: evaluations cannot be updated or deleted; overrides reject a trivial reason and a blanket waiver, are immutable in approver/reason/conditions, cannot be self-reviewed, and their review stamp cannot be rewritten.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- H. The standing exceptions report
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  v_admin  uuid := (SELECT v FROM v42 WHERE k='admin');
  v_eval   uuid := (SELECT v FROM v42 WHERE k='eval_f');
  v_new    uuid;
  v_before bigint;
  v_after  bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.export_gate_overrides_pending_review;

  INSERT INTO public.export_gate_overrides (evaluation_id, approved_by, reason, conditions_overridden)
  VALUES (v_eval, v_admin,
          'Headroom confirmed by the authority pending the amended permit document.',
          ARRAY['permit_headroom_sufficient'])
  RETURNING id INTO v_new;

  SELECT count(*) INTO v_after FROM public.export_gate_overrides_pending_review;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a new unreviewed override did not appear on the pending-review report (% then %).', v_before, v_after;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.export_gate_overrides_pending_review
                 WHERE id = v_new AND consignment_ref IS NOT NULL AND array_length(blocking_reasons,1) >= 1) THEN
    RAISE EXCEPTION 'VERIFY H FAILED: the report does not carry the consignment and the reasons the override waived.';
  END IF;

  -- Reviewing it clears it from the report.
  UPDATE public.export_gate_overrides
     SET reviewed_by = (SELECT v FROM v42 WHERE k='admin2'), reviewed_at = now()
   WHERE id = v_new;

  IF EXISTS (SELECT 1 FROM public.export_gate_overrides_pending_review WHERE id = v_new) THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a reviewed override is still on the pending-review report.';
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: an unreviewed override appears on the standing exceptions report with its consignment and waived reasons, and drops off once a second person reviews it.';
END
$verify_h$;

-- -----------------------------------------------------------------------------
-- I. Authorisation
-- -----------------------------------------------------------------------------
DO $verify_i$
DECLARE
  v_farmer  uuid := '00420000-0000-4000-a000-00000000fa01';
  v_buyer   uuid := (SELECT v FROM v42 WHERE k='ok_buyer');
  v_export  uuid := (SELECT v FROM v42 WHERE k='ok_export');
  v_blocked boolean := false;
  v_grants  text[] := ARRAY[]::text[];
  t text;
  p text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_farmer, 'farmer42@verify.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES (v_farmer, 'farmer42@verify.test', 'farmer')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_farmer::text, true);
  BEGIN
    PERFORM public.evaluate_export_eligibility(
      'CONS-I', v_buyer, v_export, 'controlled_herb', 'DE', 1.000, NULL, current_date);
    v_blocked := false;
  EXCEPTION WHEN others THEN
    v_blocked := true;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'VERIFY I FAILED: a farmer identity was able to run the export gate.';
  END IF;

  FOREACH t IN ARRAY ARRAY['screening_checks', 'export_eligibility_evaluations', 'export_gate_overrides'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', 'public.' || t, p) THEN
        v_grants := array_append(v_grants, format('anon has %s on %s', p, t));
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon',
      'public.evaluate_export_eligibility(text, uuid, uuid, text, char, numeric, uuid, date)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE the export gate');
  END IF;

  IF has_table_privilege('authenticated', 'public.export_eligibility_evaluations', 'UPDATE') THEN
    v_grants := array_append(v_grants, 'authenticated holds UPDATE on the evaluation log');
  END IF;
  IF has_table_privilege('authenticated', 'public.export_eligibility_evaluations', 'DELETE') THEN
    v_grants := array_append(v_grants, 'authenticated holds DELETE on the evaluation log');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY I FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY I PASSED: a farmer identity cannot run the gate, anon holds nothing on any of the three tables, and authenticated holds neither UPDATE nor DELETE on the evaluation log.';
END
$verify_i$;

ROLLBACK;
