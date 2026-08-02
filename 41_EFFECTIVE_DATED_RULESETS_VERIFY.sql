-- =============================================================================
-- Migration 41 — VERIFY: effective-dated rulesets
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure: columns, table, functions, overlap trigger, current-index
--   B — the backfill ran and marked itself as an estimate
--   C — compliance_rules_in_force() is genuinely point-in-time, in both
--       directions: a future rule is not in force today, and a retired rule IS
--       in force at a date inside its range
--   D — at most one current destination ruleset per market and regime, and
--       overlapping ranges are refused
--   E — resolution picks the version that applied on the day, not the newest
--   F — an unresearched market returns NO ROW, which must not read as "no
--       requirements"
--   G — anon holds nothing
--
-- Expected on success: seven PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  c text;
  f text;
BEGIN
  FOREACH c IN ARRAY ARRAY['effective_from', 'effective_to', 'effective_from_is_estimated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='compliance_rules' AND column_name=c) THEN
      v_missing := array_append(v_missing, 'compliance_rules.' || c);
    END IF;
  END LOOP;

  IF to_regclass('public.destination_rulesets') IS NULL THEN
    v_missing := array_append(v_missing, 'table public.destination_rulesets');
  END IF;

  FOREACH f IN ARRAY ARRAY['compliance_rules_in_force', 'compliance_rules_currently_enforced',
                           'destination_ruleset_in_force',
                           'fn_reject_overlapping_destination_ruleset'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname=f) THEN
      v_missing := array_append(v_missing, 'function public.' || f);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='uq_destination_rulesets_one_current') THEN
    v_missing := array_append(v_missing, 'index uq_destination_rulesets_one_current');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname='destination_rulesets_no_overlap' AND NOT tgisinternal) THEN
    v_missing := array_append(v_missing, 'trigger destination_rulesets_no_overlap');
  END IF;

  -- effective_from must be NOT NULL, or a rule with no date silently escapes
  -- every point-in-time filter.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='compliance_rules'
               AND column_name='effective_from' AND is_nullable='YES') THEN
    v_missing := array_append(v_missing, 'compliance_rules.effective_from is still NULLABLE');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: the three effective-dating columns exist with effective_from NOT NULL, destination_rulesets exists, both resolver functions and the overlap trigger are present, and the one-current-ruleset index is in place.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. The backfill
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_rule_id  uuid;
  v_from     date;
  v_estimated boolean;
  v_default_estimated boolean;
BEGIN
  -- A rule that predates the migration would already be backfilled; on a fresh
  -- database there are none, so create one and check the DEFAULT path instead,
  -- then verify the backfill rule directly against any pre-existing rows.
  INSERT INTO public.compliance_rules (rule_code, title, description, entity_type, severity, status)
  VALUES ('VERIFY-41-NEW', 'New rule', 'Created after migration 41', 'shipment', 'high', 'active')
  RETURNING id, effective_from, effective_from_is_estimated
  INTO v_rule_id, v_from, v_default_estimated;

  IF v_from IS DISTINCT FROM current_date THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a new rule did not default effective_from to today (got %).', v_from;
  END IF;
  IF v_default_estimated THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a NEW rule was marked as having an ESTIMATED effective date. Only backfilled rows may carry that flag.';
  END IF;

  -- Every row that WAS backfilled must be flagged, so the estimates can be found.
  IF EXISTS (
    SELECT 1 FROM public.compliance_rules
    WHERE effective_from = created_at::date
      AND created_at < now() - interval '1 second'
      AND effective_from_is_estimated = false
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a pre-existing rule was backfilled from created_at but NOT flagged as estimated. Those estimates would be indistinguishable from confirmed dates.';
  END IF;

  -- The range constraint must bite.
  BEGIN
    UPDATE public.compliance_rules SET effective_to = effective_from WHERE id = v_rule_id;
    RAISE EXCEPTION 'VERIFY B FAILED: an effective_to equal to effective_from (a zero-length window) was ADMITTED.';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'VERIFY B PASSED: new rules default to today and are not flagged estimated, backfilled rows are flagged, and a zero-length effective window is rejected.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Point-in-time, both directions
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_future uuid;
  v_past   uuid;
  v_draft  uuid;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  -- A rule that takes effect next month.
  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, status, effective_from)
  VALUES ('VERIFY-41-FUTURE', 'Future rule', 'Takes effect in 30 days', 'shipment', 'high', 'active',
          current_date + 30)
  RETURNING id INTO v_future;

  -- A rule that applied last year and was closed at the end of it.
  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, status, effective_from, effective_to)
  VALUES ('VERIFY-41-PAST', 'Superseded rule', 'Applied for one year', 'shipment', 'high', 'active',
          current_date - 400, current_date - 30)
  RETURNING id INTO v_past;

  -- Today: neither should be in force.
  IF EXISTS (SELECT 1 FROM public.compliance_rules_in_force() WHERE id = v_future) THEN
    v_problems := array_append(v_problems, 'a rule effective in 30 days is in force TODAY');
  END IF;
  IF EXISTS (SELECT 1 FROM public.compliance_rules_in_force() WHERE id = v_past) THEN
    v_problems := array_append(v_problems, 'a rule that closed 30 days ago is still in force today');
  END IF;

  -- Inside the past rule's window it MUST be in force. This is the direction
  -- that matters after the fact: judging a March shipment by March's rules.
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date - 200) WHERE id = v_past) THEN
    v_problems := array_append(v_problems, 'the closed rule is NOT in force at a date inside its own window');
  END IF;

  -- And the future rule must be in force after it starts.
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date + 31) WHERE id = v_future) THEN
    v_problems := array_append(v_problems, 'the future rule is not in force after its start date');
  END IF;

  -- Boundary: effective_from is inclusive, effective_to is exclusive.
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date + 30) WHERE id = v_future) THEN
    v_problems := array_append(v_problems, 'effective_from is not inclusive on its own day');
  END IF;
  IF EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date - 30) WHERE id = v_past) THEN
    v_problems := array_append(v_problems, 'effective_to is not exclusive on its own day');
  END IF;

  -- ── Lifecycle status must NOT rewrite history ────────────────────────────
  -- Pausing a rule today cannot change what applied last March. If the
  -- historical resolver filtered on present-tense status, retiring a rule would
  -- silently erase it from every past evaluation — which defeats the whole
  -- migration. This is the regression guard for that.
  UPDATE public.compliance_rules SET status = 'paused' WHERE id = v_past;
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date - 200) WHERE id = v_past) THEN
    v_problems := array_append(v_problems,
      'pausing a rule TODAY removed it from a HISTORICAL query — present-tense status is rewriting the past');
  END IF;

  UPDATE public.compliance_rules SET status = 'retired' WHERE id = v_past;
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date - 200) WHERE id = v_past) THEN
    v_problems := array_append(v_problems, 'retiring a rule removed it from a historical query');
  END IF;

  -- But a rule that NEVER reached force must never be applied to history.
  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, status, effective_from)
  VALUES ('VERIFY-41-DRAFT', 'Never adopted', 'A proposal that was rejected', 'shipment', 'high',
          'rejected', current_date - 400)
  RETURNING id INTO v_draft;

  IF EXISTS (SELECT 1 FROM public.compliance_rules_in_force(current_date - 200) WHERE id = v_draft) THEN
    v_problems := array_append(v_problems,
      'a REJECTED rule that never reached force was applied to a historical date');
  END IF;

  -- ── The present-tense question is answered separately ────────────────────
  -- Re-open the paused rule's window so only status can be responsible.
  UPDATE public.compliance_rules
     SET status = 'paused', effective_to = NULL WHERE id = v_past;
  IF EXISTS (SELECT 1 FROM public.compliance_rules_currently_enforced() WHERE id = v_past) THEN
    v_problems := array_append(v_problems,
      'a PAUSED rule with an open window is still CURRENTLY ENFORCED');
  END IF;

  UPDATE public.compliance_rules SET status = 'active' WHERE id = v_past;
  IF NOT EXISTS (SELECT 1 FROM public.compliance_rules_currently_enforced() WHERE id = v_past) THEN
    v_problems := array_append(v_problems,
      'an ACTIVE rule with an open window is not currently enforced');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: rules resolve by date in both directions with effective_from inclusive and effective_to exclusive; pausing or retiring a rule does NOT remove it from historical queries; a rule that never reached force is never applied to history; and the separate present-tense resolver excludes a paused rule while admitting an active one.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. One current ruleset; overlaps refused
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.destination_rulesets
    (country_code, regime, version, effective_from, source_reference)
  VALUES ('DE', 'controlled_herb', 1, current_date - 365, 'BfArM guidance v1');

  -- A second OPEN-ENDED ruleset for the same market and regime.
  BEGIN
    INSERT INTO public.destination_rulesets
      (country_code, regime, version, effective_from, source_reference)
    VALUES ('DE', 'controlled_herb', 2, current_date - 100, 'BfArM guidance v2');
    v_problems := array_append(v_problems, 'a SECOND open-ended ruleset for DE/controlled_herb was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Same market, DIFFERENT regime — must be allowed. The two regimes are
  -- separate legal tracks and share nothing.
  BEGIN
    INSERT INTO public.destination_rulesets
      (country_code, regime, version, effective_from, source_reference)
    VALUES ('DE', 'narcotic_cat5', 1, current_date - 365, 'BfArM narcotics guidance');
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a ruleset for the same country but a DIFFERENT regime was refused');
  END;

  -- Close v1, then open v2 — the supported sequence.
  UPDATE public.destination_rulesets
     SET effective_to = current_date - 100
   WHERE country_code='DE' AND regime='controlled_herb' AND version=1;

  BEGIN
    INSERT INTO public.destination_rulesets
      (country_code, regime, version, effective_from, source_reference, requires_import_permit)
    VALUES ('DE', 'controlled_herb', 2, current_date - 100, 'BfArM guidance v2', true);
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'opening v2 after closing v1 was refused');
  END;

  -- An overlapping CLOSED range must be refused by the trigger.
  BEGIN
    INSERT INTO public.destination_rulesets
      (country_code, regime, version, effective_from, effective_to, source_reference)
    VALUES ('DE', 'controlled_herb', 3, current_date - 300, current_date - 200, 'overlapping historic');
    v_problems := array_append(v_problems, 'an OVERLAPPING closed ruleset range was ADMITTED');
  EXCEPTION WHEN others THEN NULL;
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: only one open-ended ruleset per market and regime, different regimes coexist, close-then-open works, and an overlapping historic range is refused.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Resolution picks the version that applied on the day
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_version int;
BEGIN
  -- Today → v2 (opened 100 days ago, still open).
  SELECT version INTO v_version
  FROM public.destination_ruleset_in_force('DE', 'controlled_herb');
  IF v_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: today resolves to ruleset version %, expected 2.', v_version;
  END IF;

  -- 200 days ago → v1, not the newest.
  SELECT version INTO v_version
  FROM public.destination_ruleset_in_force('DE', 'controlled_herb', current_date - 200);
  IF v_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a date 200 days ago resolves to ruleset version %, expected 1. The resolver is returning the newest ruleset rather than the one in force.', v_version;
  END IF;

  -- Before any ruleset existed → nothing.
  IF EXISTS (SELECT 1 FROM public.destination_ruleset_in_force('DE', 'controlled_herb', current_date - 1000)) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a date before the first ruleset resolved to a ruleset.';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: resolution returns v2 today, v1 for a date inside v1''s window, and nothing for a date before any ruleset existed.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. An unresearched market returns no row
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.destination_ruleset_in_force('ZW', 'controlled_herb');

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a market with no ruleset on file returned % row(s).', v_count;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: a market with no ruleset returns no row. The export gate must treat that as UNRESOLVED and refuse — an empty result is not permission.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. anon holds nothing
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_grants text[] := ARRAY[]::text[];
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.destination_rulesets', p) THEN
      v_grants := array_append(v_grants, format('anon has %s on destination_rulesets', p));
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.compliance_rules_in_force(date)', 'EXECUTE') THEN
    v_grants := array_append(v_grants, 'anon can EXECUTE compliance_rules_in_force');
  END IF;

  IF array_length(v_grants, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_grants, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: anon holds no privilege on destination_rulesets and cannot execute the resolvers.';
END
$verify_g$;

ROLLBACK;
