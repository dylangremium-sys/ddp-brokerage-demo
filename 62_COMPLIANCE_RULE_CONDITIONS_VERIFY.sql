-- =============================================================================
-- 62_COMPLIANCE_RULE_CONDITIONS_VERIFY.sql
--
-- Proves the condition column exists, accepts what it should, refuses what it
-- should, and changes nothing about existing rules.
--
-- Section C is the one that matters. It asserts the CHECK is a SHAPE guard and
-- NOT a semantic one — a condition naming a field that does not exist is stored
-- happily, because validating that here would create a second definition of
-- "valid condition" alongside parseRuleCondition, and two definitions is the
-- defect migration 61 just finished closing. A future reader who "fixes" this
-- by tightening the CHECK should read section C first.
-- =============================================================================

DO $verify$
DECLARE
  v_ok      boolean;
  v_count   int;
  v_refused boolean;
BEGIN
  DELETE FROM public.compliance_rules WHERE rule_code LIKE 'V62_%';

  -- ── A. The column and its guard exist ──────────────────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'compliance_rules'
      AND column_name = 'condition' AND data_type = 'jsonb'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'VERIFY A FAILED: compliance_rules.condition is missing or is not jsonb.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.compliance_rules'::regclass
      AND conname = 'compliance_rules_condition_shape'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the condition shape CHECK is missing.';
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: condition jsonb column and its shape CHECK exist.';

  -- ── B. NULL is normal, and existing rules are untouched ────────────────────
  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, is_blocking, status)
  VALUES ('V62_NULL', 'v62 no condition', '', 'batch', 'low', true, 'active');

  SELECT count(*) INTO v_count
  FROM public.compliance_rules WHERE rule_code = 'V62_NULL' AND condition IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a rule could not be created without a condition. The column must stay optional.';
  END IF;

  -- and such a rule is still enforced, i.e. 62 did not disturb 61.
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_currently_enforced() WHERE rule_code = 'V62_NULL';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: an active rule with no condition stopped being enforced — 62 disturbed 61.';
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: condition is optional, and a rule without one is still enforced.';

  -- ── C. SHAPE is guarded; SEMANTICS deliberately are not ────────────────────
  -- Well-formed nodes of each kind are accepted.
  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, is_blocking, status, condition)
  VALUES
    ('V62_LEAF', 'v62 leaf', '', 'batch', 'low', true, 'draft',
     '{"field":"thcPct","op":"gt","value":0.2}'::jsonb),
    ('V62_ALL',  'v62 all',  '', 'batch', 'low', true, 'draft',
     '{"all":[{"field":"thcPct","op":"gt","value":0.2}]}'::jsonb),
    ('V62_ANY',  'v62 any',  '', 'batch', 'low', true, 'draft',
     '{"any":[{"field":"thcPct","op":"gt","value":0.2}]}'::jsonb),
    ('V62_NOT',  'v62 not',  '', 'batch', 'low', true, 'draft',
     '{"not":{"field":"thcPct","op":"gt","value":0.2}}'::jsonb);

  SELECT count(*) INTO v_count
  FROM public.compliance_rules WHERE rule_code IN ('V62_LEAF','V62_ALL','V62_ANY','V62_NOT');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a well-formed condition node was refused (% of 4 stored).', v_count;
  END IF;

  -- A condition naming a field that does not exist IS ACCEPTED, on purpose.
  -- parseRuleCondition is the single authority on field names; duplicating that
  -- knowledge in a CHECK would create a second definition that drifts.
  BEGIN
    INSERT INTO public.compliance_rules
      (rule_code, title, description, entity_type, severity, is_blocking, status, condition)
    VALUES ('V62_UNKNOWN_FIELD', 'v62 unknown field', '', 'batch', 'low', true, 'draft',
            '{"field":"noSuchField","op":"gt","value":1}'::jsonb);
    v_refused := false;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF v_refused THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: the CHECK refused a condition naming an unknown field. It is a SHAPE guard only '
      'and must stay one — validating field names here would create a second definition of a valid '
      'condition alongside parseRuleCondition, which is exactly the divergence migration 61 closed.';
  END IF;

  -- Malformed SHAPES are refused: a scalar, an array, and an object with none
  -- of the four recognised keys.
  BEGIN
    INSERT INTO public.compliance_rules
      (rule_code, title, description, entity_type, severity, is_blocking, status, condition)
    VALUES ('V62_SCALAR', 'v62 scalar', '', 'batch', 'low', true, 'draft', '"thcPct > 0.2"'::jsonb);
    v_refused := false;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a bare JSON string was stored as a condition. An expression string is exactly what option A rejects.';
  END IF;

  BEGIN
    INSERT INTO public.compliance_rules
      (rule_code, title, description, entity_type, severity, is_blocking, status, condition)
    VALUES ('V62_ARRAY', 'v62 array', '', 'batch', 'low', true, 'draft', '[{"field":"thcPct","op":"gt","value":1}]'::jsonb);
    v_refused := false;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY C FAILED: a bare array was stored as a condition.';
  END IF;

  BEGIN
    INSERT INTO public.compliance_rules
      (rule_code, title, description, entity_type, severity, is_blocking, status, condition)
    VALUES ('V62_JUNK', 'v62 junk', '', 'batch', 'low', true, 'draft', '{"whatever":true}'::jsonb);
    v_refused := false;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY C FAILED: an object with none of field/all/any/not was stored as a condition.';
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: shape is guarded (scalar, array and unrecognised object refused); semantics are deliberately left to the application.';

  -- ── D. The partial index exists and is partial ─────────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'compliance_rules'
      AND indexname = 'idx_compliance_rules_with_condition'
      AND indexdef ILIKE '%WHERE (condition IS NOT NULL)%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'VERIFY D FAILED: idx_compliance_rules_with_condition is missing or is not partial on condition IS NOT NULL.';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: the evaluation-sweep index exists and is partial.';

  DELETE FROM public.compliance_rules WHERE rule_code LIKE 'V62_%';
  RAISE NOTICE 'VERIFY 62 COMPLETE: 4 sections passed.';
END
$verify$;
