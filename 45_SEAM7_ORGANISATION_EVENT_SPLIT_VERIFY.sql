-- =============================================================================
-- Migration 45 — VERIFY: the organisation event split
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — vocabularies: 26 compliance values, 6 commercial values, and the four
--       moved actions on exactly one side each
--   B — the narrowing is ENFORCED, not just declared: the compliance log now
--       refuses each moved action, and still accepts a regulatory one (the
--       control that proves section B can fail)
--   C — behavioural: creating an organisation writes to the COMMERCIAL log and
--       leaves the compliance log untouched
--   D — behavioural: an ordinary amendment is commercial
--   E — behavioural: a verification transition is COMPLIANCE, and appears in
--       neither log twice
--   F — actor types the trigger can emit are admissible in BOTH logs
--
-- Expected on success: six PASSED notices and no exception.
--
-- NOTE ON RAISE NOTICE: the Supabase dashboard SQL editor does not display
-- notices. Run this through psql, or a silent pass is indistinguishable from a
-- silent skip.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Vocabularies
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_comp  text;
  v_comm  text;
  v_n     int;
  a       text;
  v_moved text[] := ARRAY['organisation_created', 'organisation_updated',
                          'organisation_membership_granted', 'organisation_membership_revoked'];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_comp
  FROM pg_constraint WHERE conname = 'compliance_audit_log_action_check'
    AND conrelid = 'public.compliance_audit_log'::regclass;
  SELECT pg_get_constraintdef(oid) INTO v_comm
  FROM pg_constraint WHERE conname = 'commercial_audit_log_action_check'
    AND conrelid = 'public.commercial_audit_log'::regclass;

  IF v_comp IS NULL OR v_comm IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: an action CHECK is missing (compliance=%, commercial=%).',
      v_comp IS NOT NULL, v_comm IS NOT NULL;
  END IF;

  SELECT count(*) INTO v_n FROM regexp_matches(v_comp, '''([a-z_]+)''::text', 'g');
  IF v_n <> 26 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: compliance vocabulary has % values, expected 26.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM regexp_matches(v_comm, '''([a-z_]+)''::text', 'g');
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: commercial vocabulary has % values, expected 6.', v_n;
  END IF;

  FOREACH a IN ARRAY v_moved LOOP
    IF position('''' || a || '''' IN v_comp) > 0 THEN
      RAISE EXCEPTION 'VERIFY A FAILED: % is still in the compliance vocabulary.', a;
    END IF;
    IF position('''' || a || '''' IN v_comm) = 0 THEN
      RAISE EXCEPTION 'VERIFY A FAILED: % did not arrive in the commercial vocabulary.', a;
    END IF;
  END LOOP;

  -- The one that STAYS. Getting this backwards is the most likely way to
  -- implement Seam 7 wrongly, so it is asserted in both directions.
  IF position('''organisation_verification_changed''' IN v_comp) = 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: organisation_verification_changed must REMAIN in the compliance '
      'vocabulary — whether a counterparty is verified is a compliance fact.';
  END IF;
  IF position('''organisation_verification_changed''' IN v_comm) > 0 THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: organisation_verification_changed must NOT be in the commercial '
      'vocabulary.';
  END IF;

  -- The reservation actions from migration 44 must survive untouched.
  IF position('''reservation_created''' IN v_comm) = 0
     OR position('''reservation_released''' IN v_comm) = 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: migration 44''s reservation actions were lost.';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: 26 compliance values, 6 commercial values, split as specified.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. The narrowing is enforced
--
-- A vocabulary that lists the right values but does not reject the wrong ones
-- proves nothing. Each moved action is offered to the compliance log directly
-- and must be refused; then a regulatory action is offered and must be
-- accepted. Without that last step this section would also "pass" against a
-- table that rejects every insert for an unrelated reason.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  a         text;
  v_ok      boolean;
  v_moved   text[] := ARRAY['organisation_created', 'organisation_updated',
                            'organisation_membership_granted', 'organisation_membership_revoked'];
BEGIN
  FOREACH a IN ARRAY v_moved LOOP
    v_ok := false;
    BEGIN
      INSERT INTO public.compliance_audit_log (actor_type, action, entity_type, entity_id)
      VALUES ('system', a, 'organisation', 'verify-45');
    EXCEPTION WHEN check_violation THEN
      v_ok := true;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: compliance_audit_log accepted %, so the vocabulary is not enforced.', a;
    END IF;
  END LOOP;

  -- Control: the log must still accept a genuine regulatory action.
  INSERT INTO public.compliance_audit_log (actor_type, action, entity_type, entity_id)
  VALUES ('system', 'licence_state_changed', 'licence', 'verify-45');

  -- Control: the commercial log must now accept what the compliance log refused.
  INSERT INTO public.commercial_audit_log (actor_type, action, entity_type, entity_id)
  VALUES ('system', 'organisation_created', 'organisation', 'verify-45');

  RAISE NOTICE 'VERIFY B PASSED: four actions refused by the compliance log, regulatory and commercial controls accepted.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Creating an organisation is a COMMERCIAL event
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE v45 (k text PRIMARY KEY, v uuid) ON COMMIT DROP;

DO $verify_c$
DECLARE
  v_org   uuid;
  v_comm  bigint;
  v_comp  bigint;
BEGIN
  INSERT INTO public.organisations (org_type, legal_name, country_code)
  VALUES ('buyer', 'VERIFY 45 counterparty', 'TH')
  RETURNING id INTO v_org;
  INSERT INTO v45 VALUES ('org', v_org);

  SELECT count(*) INTO v_comm FROM public.commercial_audit_log
  WHERE entity_type = 'organisation' AND entity_id = v_org::text
    AND action = 'organisation_created';
  SELECT count(*) INTO v_comp FROM public.compliance_audit_log
  WHERE entity_type = 'organisation' AND entity_id = v_org::text;

  IF v_comm <> 1 THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: expected exactly 1 organisation_created row in commercial_audit_log, found %.',
      v_comm;
  END IF;
  IF v_comp <> 0 THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: creating an organisation wrote % row(s) to the compliance log; it must write none.',
      v_comp;
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: organisation_created went to the commercial log only.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. An ordinary amendment is COMMERCIAL
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_org  uuid := (SELECT v FROM v45 WHERE k = 'org');
  v_comm bigint;
  v_comp bigint;
BEGIN
  UPDATE public.organisations SET display_name = 'renamed by VERIFY 45' WHERE id = v_org;

  SELECT count(*) INTO v_comm FROM public.commercial_audit_log
  WHERE entity_id = v_org::text AND action = 'organisation_updated';
  SELECT count(*) INTO v_comp FROM public.compliance_audit_log
  WHERE entity_id = v_org::text;

  IF v_comm <> 1 THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: expected exactly 1 organisation_updated row in commercial_audit_log, found %.',
      v_comm;
  END IF;
  IF v_comp <> 0 THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: an ordinary amendment wrote % row(s) to the compliance log.', v_comp;
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: organisation_updated went to the commercial log only.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. A verification transition is COMPLIANCE
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_org  uuid := (SELECT v FROM v45 WHERE k = 'org');
  v_comp bigint;
  v_comm bigint;
BEGIN
  -- unverified → in_review. Deliberately not 'verified', which would require
  -- verified_by/verified_at evidence and drag an auth.users fixture into a test
  -- that is about routing, not about the verification CHECK.
  UPDATE public.organisations SET verification_state = 'in_review' WHERE id = v_org;

  SELECT count(*) INTO v_comp FROM public.compliance_audit_log
  WHERE entity_id = v_org::text AND action = 'organisation_verification_changed';
  SELECT count(*) INTO v_comm FROM public.commercial_audit_log
  WHERE entity_id = v_org::text AND action = 'organisation_verification_changed';

  IF v_comp <> 1 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: expected exactly 1 organisation_verification_changed row in '
      'compliance_audit_log, found %.', v_comp;
  END IF;
  IF v_comm <> 0 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: the verification transition also reached the commercial log (% row(s)). '
      'It is a compliance fact and belongs in one log only.', v_comm;
  END IF;

  -- And the amendment count must NOT have moved: a verification change is its
  -- own action, not an update as well.
  SELECT count(*) INTO v_comm FROM public.commercial_audit_log
  WHERE entity_id = v_org::text AND action = 'organisation_updated';
  IF v_comm <> 1 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: expected the organisation_updated count to stay at 1, found %.', v_comm;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: organisation_verification_changed went to the compliance log only.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. Actor types the trigger can emit are admissible in BOTH logs
--
-- fn_audit_organisation_change emits 'admin' or 'system' and now writes to
-- either table depending on the action. The two logs have DIFFERENT actor_type
-- vocabularies (compliance: admin/ai_assistant/system/legal_reviewer;
-- commercial: admin/buyer/farmer/system), so routing across them is only safe
-- inside the intersection. Narrowing either one later breaks the trigger at
-- runtime rather than at deploy time — this asserts the intersection directly.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_comp text;
  v_comm text;
  t      text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_comp FROM pg_constraint
  WHERE conrelid = 'public.compliance_audit_log'::regclass AND conname LIKE '%actor_type%';
  SELECT pg_get_constraintdef(oid) INTO v_comm FROM pg_constraint
  WHERE conrelid = 'public.commercial_audit_log'::regclass AND conname LIKE '%actor_type%';

  IF v_comp IS NULL OR v_comm IS NULL THEN
    RAISE EXCEPTION 'VERIFY F FAILED: an actor_type CHECK is missing.';
  END IF;

  FOREACH t IN ARRAY ARRAY['admin', 'system'] LOOP
    IF position('''' || t || '''' IN v_comp) = 0 THEN
      RAISE EXCEPTION 'VERIFY F FAILED: compliance_audit_log does not admit actor_type %.', t;
    END IF;
    IF position('''' || t || '''' IN v_comm) = 0 THEN
      RAISE EXCEPTION 'VERIFY F FAILED: commercial_audit_log does not admit actor_type %.', t;
    END IF;
  END LOOP;

  RAISE NOTICE 'VERIFY F PASSED: actor types admin and system are admissible in both logs.';
END
$verify_f$;

ROLLBACK;
