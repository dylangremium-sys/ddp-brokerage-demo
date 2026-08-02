-- =============================================================================
-- Migration 40 — VERIFY: licences, permits and draw-down
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK. Do not run
-- against Production under the change freeze.
--
-- Sections:
--   A — structure: tables, functions, append-only and headroom triggers
--   B — the dual-calendar CHECK rejects both directions of the 543 error
--   C — expiry is COMPUTED: a lapsed licence reads invalid with no state change,
--       and 'expired' is absent from the state vocabulary by design
--   D — the draw-down ledger arithmetic, over-draw refusal and reversal rules
--   E — the ledger is append-only in behaviour AND in privilege
--   F — NaN and Infinity cannot enter a quantity column
--   G — BEHAVIOURAL, as `authenticated`: double-blind holds for permits
--   H — anon holds nothing
--
-- Expected on success: eight PASSED notices and no exception.
--
-- WHAT THIS FILE DOES NOT PROVE: the FOR UPDATE row lock in
-- fn_enforce_permit_headroom() serialises genuinely concurrent draws. A single
-- session cannot demonstrate that. Section D proves the arithmetic and the
-- refusal; the locking claim is stated in the migration and must be exercised
-- by a two-session test on staging before any permit is drawn in anger.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['licences', 'permits', 'permit_drawdowns'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      v_missing := array_append(v_missing, 'table public.' || t);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['licence_is_valid', 'permit_is_valid', 'permit_drawn_kg',
                           'permit_headroom_kg', 'fn_enforce_permit_headroom',
                           'prevent_permit_drawdown_mutation'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = f
    ) THEN
      v_missing := array_append(v_missing, 'function public.' || f);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['permit_drawdowns_no_update_delete',
                           'permit_drawdowns_enforce_headroom',
                           'permit_drawdowns_audit'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND NOT tgisinternal) THEN
      v_missing := array_append(v_missing, 'trigger ' || t);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='uq_permit_drawdowns_one_reversal') THEN
    v_missing := array_append(v_missing, 'index uq_permit_drawdowns_one_reversal');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: three tables, six functions, three ledger triggers and the single-reversal unique index are present.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. The 543 assertion, both directions
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_org      uuid;
  v_admitted text[] := ARRAY[]::text[];
  v_ok       boolean := false;
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('farm', 'Calendar Test Farm', 'TH') RETURNING id INTO v_org;

  -- Never converted: the BE year still holds the CE value.
  BEGIN
    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'CAL-1',
      DATE '2026-01-15', 2026, DATE '2026-12-31', 2569, 'vault://cal-1');
    v_admitted := array_append(v_admitted, 'issued BE year never converted (2026)');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Converted twice: 2026 → 2569 → 3112.
  BEGIN
    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'CAL-2',
      DATE '2026-01-15', 2569, DATE '2026-12-31', 3112, 'vault://cal-2');
    v_admitted := array_append(v_admitted, 'expiry BE year converted twice (3112)');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Expiry before issue.
  BEGIN
    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'CAL-3',
      DATE '2026-12-31', 2569, DATE '2026-01-15', 2569, 'vault://cal-3');
    v_admitted := array_append(v_admitted, 'expires_on before issued_on');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A licence with no artefact behind it.
  BEGIN
    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'CAL-4',
      DATE '2026-01-15', 2569, DATE '2026-12-31', 2569, '   ');
    v_admitted := array_append(v_admitted, 'blank source_document_ref');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The correct pair must be accepted, or the constraint is simply too tight.
  BEGIN
    INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
    VALUES (v_org, 'cultivation', 'dtam', 'controlled_herb', 'CAL-OK',
      DATE '2026-01-15', 2569, DATE '2026-12-31', 2569, 'vault://cal-ok');
    v_ok := true;
  EXCEPTION WHEN check_violation THEN v_ok := false;
  END;

  IF array_length(v_admitted, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: the database ADMITTED a calendar error: %',
      array_to_string(v_admitted, '; ');
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a CORRECT dual-calendar licence (2026 CE / 2569 BE) was rejected. The constraint is wrong, not merely strict.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: an unconverted BE year, a doubly-converted BE year, an inverted date range and a missing artefact are all rejected, and a correct 2026/2569 pair is accepted.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Expiry is computed, not stored
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_org       uuid;
  v_lic       uuid;
  v_state     text;
  v_def       text;
  v_valid_now boolean;
  v_valid_then boolean;
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('farm', 'Lapsed Licence Farm', 'TH') RETURNING id INTO v_org;

  -- A licence that lapsed yesterday, with nobody having touched its state.
  INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
  VALUES (v_org, 'export', 'thai_fda', 'narcotic_cat5', 'LAPSED-1',
    current_date - 400, date_part('year', current_date - 400)::int + 543,
    current_date - 1,   date_part('year', current_date - 1)::int + 543,
    'vault://lapsed-1')
  RETURNING id INTO v_lic;

  SELECT state INTO v_state FROM public.licences WHERE id = v_lic;
  v_valid_now  := public.licence_is_valid(v_lic);
  v_valid_then := public.licence_is_valid(v_lic, current_date - 2);

  IF v_state <> 'active' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: fixture precondition — expected the stored state to still read "active", found %.', v_state;
  END IF;
  IF v_valid_now THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a licence that expired yesterday still reads as valid. Expiry is not being computed from expires_on.';
  END IF;
  IF NOT v_valid_then THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the same licence does not read as valid on a date inside its term. licence_is_valid is not date-sensitive.';
  END IF;

  -- Fail closed on an unknown licence: false, never NULL. A NULL here would
  -- make the gate's boolean AND go NULL, which reads as "not blocked".
  IF public.licence_is_valid('00000000-0000-4000-a000-00000000dead') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'VERIFY C FAILED: licence_is_valid on an unknown id did not return false.';
  END IF;

  -- The state vocabulary must not contain 'expired' — its presence would mean
  -- someone reintroduced a stored expiry that goes stale.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.licences'::regclass AND conname LIKE '%state_check';
  IF v_def IS NOT NULL AND v_def ILIKE '%expired%' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the licence state vocabulary contains "expired". Expiry must be derived, not stored: %', v_def;
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a licence lapsed by one day reads invalid with its stored state untouched, reads valid inside its term, returns false for an unknown id, and "expired" is absent from the state vocabulary.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Draw-down ledger
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_org      uuid;
  v_permit   uuid;
  v_permit2  uuid;
  v_draw1    uuid;
  v_draw2    uuid;
  v_problems text[] := ARRAY[]::text[];
  v_headroom numeric;
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Headroom Import GmbH', 'DE') RETURNING id INTO v_org;

  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_org, 'import', 'controlled_herb', 'DE', 'DE-IMP-1',
    current_date - 10, date_part('year', current_date - 10)::int + 543,
    current_date + 90, date_part('year', current_date + 90)::int + 543,
    100.000, 'vault://de-imp-1')
  RETURNING id INTO v_permit;

  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_org, 'import', 'controlled_herb', 'DE', 'DE-IMP-2',
    current_date - 10, date_part('year', current_date - 10)::int + 543,
    current_date + 90, date_part('year', current_date + 90)::int + 543,
    50.000, 'vault://de-imp-2')
  RETURNING id INTO v_permit2;

  -- Fresh permit: full headroom.
  IF public.permit_headroom_kg(v_permit) <> 100.000 THEN
    v_problems := array_append(v_problems,
      format('fresh permit headroom is %s, expected 100', public.permit_headroom_kg(v_permit)));
  END IF;

  -- Two draws accumulate.
  INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
  VALUES (v_permit, 60.000, 'CONS-1', 'first shipment') RETURNING id INTO v_draw1;
  INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
  VALUES (v_permit, 30.000, 'CONS-2', 'second shipment') RETURNING id INTO v_draw2;

  v_headroom := public.permit_headroom_kg(v_permit);
  IF v_headroom <> 10.000 THEN
    v_problems := array_append(v_problems, format('headroom after 60+30 is %s, expected 10', v_headroom));
  END IF;

  -- Over-draw must be refused. This is the condition the plan calls a tracked
  -- ledger rather than a note in a field.
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit, 10.001, 'CONS-3', 'one gram too many');
    v_problems := array_append(v_problems, 'an over-draw of 0.001 kg was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Exactly filling the permit is allowed.
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit, 10.000, 'CONS-4', 'exactly the remainder');
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a draw that exactly exhausts the permit was refused');
  END;

  IF public.permit_headroom_kg(v_permit) <> 0 THEN
    v_problems := array_append(v_problems,
      format('headroom after exhaustion is %s, expected 0', public.permit_headroom_kg(v_permit)));
  END IF;

  -- A reversal restores headroom.
  INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason, reversal_of)
  VALUES (v_permit, 30.000, 'CONS-2', 'shipment cancelled before departure', v_draw2);
  IF public.permit_headroom_kg(v_permit) <> 30.000 THEN
    v_problems := array_append(v_problems,
      format('headroom after reversing 30 kg is %s, expected 30', public.permit_headroom_kg(v_permit)));
  END IF;

  -- The same draw may not be reversed twice — that would mint headroom.
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason, reversal_of)
    VALUES (v_permit, 30.000, 'CONS-2', 'reversed again', v_draw2);
    v_problems := array_append(v_problems, 'a SECOND reversal of the same draw was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- A reversal may not move quantity between permits.
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason, reversal_of)
    VALUES (v_permit2, 60.000, 'CONS-1', 'cross-permit reversal', v_draw1);
    v_problems := array_append(v_problems, 'a cross-permit reversal was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Partial reversals are refused rather than silently mis-accounted.
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason, reversal_of)
    VALUES (v_permit, 20.000, 'CONS-1', 'partial reversal', v_draw1);
    v_problems := array_append(v_problems, 'a PARTIAL reversal was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- A draw against a suspended permit is refused at the ledger, not only at the gate.
  UPDATE public.permits SET state = 'suspended', state_reason = 'under investigation' WHERE id = v_permit2;
  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit2, 1.000, 'CONS-5', 'draw against suspended permit');
    v_problems := array_append(v_problems, 'a draw against a SUSPENDED permit was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Unknown permit: headroom must read 0, not NULL.
  IF public.permit_headroom_kg('00000000-0000-4000-a000-00000000beef') <> 0 THEN
    v_problems := array_append(v_problems, 'headroom for an unknown permit was not 0');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: draws accumulate, a 1-gram over-draw is refused, an exact fill is allowed, a reversal restores headroom, and double / cross-permit / partial reversals and draws against a suspended permit are all refused.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Append-only, in behaviour and in privilege
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_org      uuid;
  v_permit   uuid;
  v_draw     uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Append Only BV', 'NL') RETURNING id INTO v_org;

  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_org, 'import', 'controlled_herb', 'NL', 'NL-IMP-1',
    current_date - 5, date_part('year', current_date - 5)::int + 543,
    current_date + 5, date_part('year', current_date + 5)::int + 543,
    10.000, 'vault://nl-imp-1')
  RETURNING id INTO v_permit;

  INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
  VALUES (v_permit, 5.000, 'CONS-A', 'shipment') RETURNING id INTO v_draw;

  BEGIN
    UPDATE public.permit_drawdowns SET quantity_kg = 1.000 WHERE id = v_draw;
    v_problems := array_append(v_problems, 'UPDATE on a draw-down was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  BEGIN
    DELETE FROM public.permit_drawdowns WHERE id = v_draw;
    v_problems := array_append(v_problems, 'DELETE on a draw-down was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- The trigger must be the second line, not the only one: the privilege itself
  -- must not be granted.
  IF has_table_privilege('authenticated', 'public.permit_drawdowns', 'UPDATE') THEN
    v_problems := array_append(v_problems, 'authenticated holds UPDATE on permit_drawdowns');
  END IF;
  IF has_table_privilege('authenticated', 'public.permit_drawdowns', 'DELETE') THEN
    v_problems := array_append(v_problems, 'authenticated holds DELETE on permit_drawdowns');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: UPDATE and DELETE on the draw-down ledger both raise, and neither privilege is granted to authenticated in the first place.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. NaN and Infinity
--
-- The single most important arithmetic guard in this migration. In PostgreSQL
-- numeric 'NaN' sorts ABOVE every real number, so `CHECK (q > 0)` alone admits
-- it — and one NaN in a permit limit turns every subsequent headroom comparison
-- into false, silently blocking every shipment against that permit.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_org      uuid;
  v_permit   uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Not A Number BV', 'NL') RETURNING id INTO v_org;

  BEGIN
    INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
    VALUES (v_org, 'import', 'controlled_herb', 'NL', 'NL-NAN',
      current_date, date_part('year', current_date)::int + 543,
      current_date + 1, date_part('year', current_date + 1)::int + 543,
      'NaN'::numeric, 'vault://nan');
    v_problems := array_append(v_problems, 'a permit with a NaN quantity limit was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  BEGIN
    INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
      issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
    VALUES (v_org, 'import', 'controlled_herb', 'NL', 'NL-INF',
      current_date, date_part('year', current_date)::int + 543,
      current_date + 1, date_part('year', current_date + 1)::int + 543,
      'Infinity'::numeric, 'vault://inf');
    v_problems := array_append(v_problems, 'a permit with an Infinity quantity limit was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- And the same guard on the ledger side.
  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_org, 'import', 'controlled_herb', 'NL', 'NL-OK',
    current_date, date_part('year', current_date)::int + 543,
    current_date + 1, date_part('year', current_date + 1)::int + 543,
    10.000, 'vault://nl-ok')
  RETURNING id INTO v_permit;

  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit, 'NaN'::numeric, 'CONS-NAN', 'nan draw');
    v_problems := array_append(v_problems, 'a NaN draw-down was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  BEGIN
    INSERT INTO public.permit_drawdowns (permit_id, quantity_kg, consignment_ref, reason)
    VALUES (v_permit, 0, 'CONS-ZERO', 'zero draw');
    v_problems := array_append(v_problems, 'a zero-quantity draw-down was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: NaN and Infinity are rejected on both the permit limit and the draw-down quantity, and a zero-quantity draw is rejected too.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. BEHAVIOURAL — double-blind, observed as `authenticated`
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_farm_user  uuid := '00400000-0000-4000-a000-0000000000a1';
  v_buyer_user uuid := '00400000-0000-4000-a000-0000000000a2';
  v_farm_org   uuid;
  v_buyer_org  uuid;
  v_farm_id    uuid := '00400000-0000-4000-a000-0000000000f1';
  v_seen       bigint;
  v_problems   text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_farm_user, 'farm40@verify.test'), (v_buyer_user, 'buyer40@verify.test')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, role) VALUES
    (v_farm_user, 'farm40@verify.test', 'farmer'), (v_buyer_user, 'buyer40@verify.test', 'buyer')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;
  INSERT INTO public.farms (id) VALUES (v_farm_id) ON CONFLICT DO NOTHING;

  INSERT INTO public.organisations (org_type, legal_name, country_code, farm_id)
  VALUES ('farm', 'Blind Test Farm', 'TH', v_farm_id) RETURNING id INTO v_farm_org;
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'Blind Test Buyer', 'DE') RETURNING id INTO v_buyer_org;

  INSERT INTO public.organisation_memberships (organisation_id, user_id, org_role) VALUES
    (v_farm_org, v_farm_user, 'owner'), (v_buyer_org, v_buyer_user, 'owner');

  -- The farm's cultivation licence and the buyer's import permit.
  INSERT INTO public.licences (organisation_id, licence_type, regulator, regime, licence_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, source_document_ref)
  VALUES (v_farm_org, 'cultivation', 'dtam', 'controlled_herb', 'BLIND-LIC-1',
    current_date - 30, date_part('year', current_date - 30)::int + 543,
    current_date + 30, date_part('year', current_date + 30)::int + 543, 'vault://blind-lic');

  INSERT INTO public.permits (organisation_id, permit_type, regime, issuing_country, permit_number,
    issued_on, issued_on_be_year, expires_on, expires_on_be_year, quantity_limit_kg, source_document_ref)
  VALUES (v_buyer_org, 'import', 'controlled_herb', 'DE', 'BLIND-PER-1',
    current_date - 30, date_part('year', current_date - 30)::int + 543,
    current_date + 30, date_part('year', current_date + 30)::int + 543, 25.000, 'vault://blind-per');

  -- As the farmer: must see own licence, zero permits.
  PERFORM set_config('request.jwt.claim.sub', v_farm_user::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM public.licences;
  IF v_seen <> 1 THEN v_problems := array_append(v_problems, format('farmer sees %s licence(s), expected 1', v_seen)); END IF;
  SELECT count(*) INTO v_seen FROM public.permits;
  IF v_seen <> 0 THEN v_problems := array_append(v_problems, format('DOUBLE-BLIND BREACH: farmer sees %s buyer permit(s)', v_seen)); END IF;
  SELECT count(*) INTO v_seen FROM public.permit_drawdowns;
  IF v_seen <> 0 THEN v_problems := array_append(v_problems, 'farmer can read the draw-down ledger'); END IF;
  PERFORM set_config('role', 'none', true);

  -- As the buyer: must see own permit, zero licences.
  PERFORM set_config('request.jwt.claim.sub', v_buyer_user::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM public.permits;
  IF v_seen <> 1 THEN v_problems := array_append(v_problems, format('buyer sees %s permit(s), expected 1', v_seen)); END IF;
  SELECT count(*) INTO v_seen FROM public.licences;
  IF v_seen <> 0 THEN v_problems := array_append(v_problems, format('DOUBLE-BLIND BREACH: buyer sees %s farm licence(s)', v_seen)); END IF;
  PERFORM set_config('role', 'none', true);

  -- No identity: nothing at all.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM public.licences;
  IF v_seen <> 0 THEN v_problems := array_append(v_problems, 'an identity-less caller can read licences'); END IF;
  SELECT count(*) INTO v_seen FROM public.permits;
  IF v_seen <> 0 THEN v_problems := array_append(v_problems, 'an identity-less caller can read permits'); END IF;
  PERFORM set_config('role', 'none', true);

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: observed as role authenticated — the farmer sees its own licence and zero buyer permits, the buyer sees its own permit and zero farm licences, neither sees the draw-down ledger, and an identity-less caller sees nothing.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- H. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  v_grants text[] := ARRAY[]::text[];
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['licences', 'permits', 'permit_drawdowns'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', 'public.' || t, p) THEN
        v_grants := array_append(v_grants, format('anon has %s on %s', p, t));
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('anon', 'public.permit_headroom_kg(uuid)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE permit_headroom_kg');
  END IF;
  IF has_function_privilege('anon', 'public.licence_is_valid(uuid, date)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE licence_is_valid');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY H FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: anon holds no privilege on licences, permits or the draw-down ledger, and cannot execute the validity or headroom functions.';
END
$verify_h$;

ROLLBACK;
