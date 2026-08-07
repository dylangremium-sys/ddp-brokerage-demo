-- =============================================================================
-- 61_RULE_ENFORCEMENT_STATUS_PARITY_VERIFY.sql
--
-- Proves migration 61 made the database agree with the application about which
-- rule statuses are enforced, WITHOUT loosening anything else.
--
-- The section that matters is B. Every other section exists to stop B passing
-- for the wrong reason: A pins the security properties, C proves the statuses
-- that must STILL be excluded are excluded, D proves the effective window is
-- untouched, and E proves the historical question widened in step with the
-- present-tense one rather than being left behind.
--
-- Read-only apart from its own fixture rows, which are removed at the end.
-- =============================================================================

DO $verify$
DECLARE
  v_problems text[] := '{}';
  v_secdef   boolean;
  v_path     text;
  v_anon     boolean;
  v_count    int;
BEGIN
  -- ── Fixture ────────────────────────────────────────────────────────────────
  -- One rule per status, all inside a wide effective window, plus two window
  -- edge cases at status 'approved' so section D cannot be satisfied by status
  -- filtering alone.
  DELETE FROM public.compliance_rules WHERE rule_code LIKE 'V61_%';

  INSERT INTO public.compliance_rules
    (rule_code, title, description, entity_type, severity, is_blocking, status,
     effective_from, effective_to)
  VALUES
    ('V61_DRAFT',     'v61 draft',     '', 'batch', 'low', true, 'draft',     current_date - 10, NULL),
    ('V61_SUGGESTED', 'v61 suggested', '', 'batch', 'low', true, 'suggested', current_date - 10, NULL),
    ('V61_APPROVED',  'v61 approved',  '', 'batch', 'low', true, 'approved',  current_date - 10, NULL),
    ('V61_ACTIVE',    'v61 active',    '', 'batch', 'low', true, 'active',    current_date - 10, NULL),
    ('V61_PAUSED',    'v61 paused',    '', 'batch', 'low', true, 'paused',    current_date - 10, NULL),
    ('V61_RETIRED',   'v61 retired',   '', 'batch', 'low', true, 'retired',   current_date - 10, NULL),
    ('V61_REJECTED',  'v61 rejected',  '', 'batch', 'low', true, 'rejected',  current_date - 10, NULL),
    -- Window edges, both 'approved' so a status-only implementation fails D.
    ('V61_FUTURE',    'v61 future',    '', 'batch', 'low', true, 'approved',  current_date + 30, NULL),
    ('V61_EXPIRED',   'v61 expired',   '', 'batch', 'low', true, 'approved',  current_date - 60, current_date - 30);

  -- ── A. Security properties survived the replace ────────────────────────────
  FOR v_secdef, v_path, v_anon IN
    SELECT p.prosecdef,
           array_to_string(p.proconfig, ','),
           has_function_privilege('anon', p.oid, 'EXECUTE')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('compliance_rules_in_force', 'compliance_rules_currently_enforced')
  LOOP
    IF NOT v_secdef THEN
      v_problems := v_problems || 'a rule resolver lost SECURITY DEFINER';
    END IF;
    IF v_path IS NULL OR v_path NOT LIKE '%search_path=public, pg_temp%' THEN
      v_problems := v_problems || format('a rule resolver has an unpinned search_path (%s)', coalesce(v_path, 'NULL'));
    END IF;
    IF v_anon THEN
      v_problems := v_problems || 'anon can EXECUTE a rule resolver';
    END IF;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: both resolvers are SECURITY DEFINER, search_path-pinned, and closed to anon.';

  -- ── B. THE POINT OF THIS MIGRATION ─────────────────────────────────────────
  -- 'approved' is enforced right now, exactly as the application's
  -- isRuleEnforcedNow already treats it.
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_currently_enforced()
  WHERE rule_code = 'V61_APPROVED';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: an approved rule inside its effective window is NOT reported as currently '
      'enforced (% row(s)). The database still disagrees with the application, which blocks buyer '
      'packs on exactly this rule.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.compliance_rules_currently_enforced()
  WHERE rule_code = 'V61_ACTIVE';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: an ACTIVE rule stopped being reported as enforced — 61 broke 41.';
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: both approved and active rules are reported as currently enforced.';

  -- ── C. What must STILL be excluded ─────────────────────────────────────────
  -- Widening by one status must not have widened by five.
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_currently_enforced()
  WHERE rule_code IN ('V61_DRAFT', 'V61_SUGGESTED', 'V61_REJECTED', 'V61_PAUSED', 'V61_RETIRED');

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: % rule(s) at draft/suggested/rejected/paused/retired are reported as '
      'currently enforced. A paused rule must not block a shipment today.', v_count;
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: draft, suggested, rejected, paused and retired are still not enforced.';

  -- ── D. The effective window is untouched ───────────────────────────────────
  -- Both rows here are 'approved', so a status-only implementation passes B and
  -- C and fails HERE.
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_currently_enforced()
  WHERE rule_code IN ('V61_FUTURE', 'V61_EXPIRED');

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: % approved rule(s) outside the effective window are reported as enforced. '
      'A rule that starts in 30 days, or ended 30 days ago, must not block anything today.', v_count;
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: effective_from/effective_to still bound enforcement.';

  -- ── E. The historical question widened in step ─────────────────────────────
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_in_force(current_date)
  WHERE rule_code = 'V61_APPROVED';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: compliance_rules_in_force() does not report an approved rule, so the two '
      'resolvers now disagree with each other — the divergence was moved, not closed.';
  END IF;

  -- and it must still answer the PAST correctly: the expired rule was in force
  -- inside its own window even though it is not enforced today.
  SELECT count(*) INTO v_count
  FROM public.compliance_rules_in_force(current_date - 45)
  WHERE rule_code = 'V61_EXPIRED';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: an approved rule that ran from -60d to -30d is not reported as in force at '
      '-45d. Judging a past shipment by the rules of its own date is the whole purpose of this '
      'function.';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: in_force() reports approved rules, and still answers point-in-time questions.';

  DELETE FROM public.compliance_rules WHERE rule_code LIKE 'V61_%';
  RAISE NOTICE 'VERIFY 61 COMPLETE: 5 sections passed.';
END
$verify$;
