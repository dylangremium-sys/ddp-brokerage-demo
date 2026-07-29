-- ===========================================================================
-- 36_FARMER_ACCESS_REQUEST_INTAKE_VERIFY.sql
-- ---------------------------------------------------------------------------
-- Verification for 36_FARMER_ACCESS_REQUEST_INTAKE_HARDENING.sql.
--
-- SECTIONS A-D are READ-ONLY (catalog + privilege state) and safe to run
-- anywhere, including Production. They RAISE if any required property is missing.
--
-- SECTIONS E-F are BEHAVIOURAL, inside one BEGIN ... ROLLBACK with NO COMMIT, so
-- they leave no residue.
--
-- Migration 34's own properties are verified by 34_..._VERIFY.sql. This file
-- checks only what migration 36 changes, plus the three things it must NOT have
-- changed (section D).
--
-- Sections: A B C D E F  (6)
-- ===========================================================================


-- ===========================================================================
-- SECTION A — the throttle ledger
-- ===========================================================================
DO $$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.public_intake_attempts') IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: public.public_intake_attempts does not exist';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'public_intake_attempts') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS is not enabled on public_intake_attempts';
  END IF;

  -- RLS-enabled with no policy reads as an oversight and is counted by the
  -- close-of-freeze sweep (freeze §4 G2.1).
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'public_intake_attempts';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: public_intake_attempts has RLS enabled and no policy';
  END IF;

  -- The lookup index the throttle depends on. Without it the window query is a
  -- sequential scan on a table a public endpoint appends to — the throttle would
  -- become the denial-of-service.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'public_intake_attempts'
       AND indexdef LIKE '%bucket_key%'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: no index on public_intake_attempts(bucket_key, ...)';
  END IF;

  -- bucket_key must be length-capped: it is written from a public-facing path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'public_intake_attempts' AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%bucket_key%'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: bucket_key carries no length CHECK';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: public_intake_attempts exists with RLS, a policy, the bucket lookup index and a length-capped bucket_key.';
END $$;


-- ===========================================================================
-- SECTION B — the throttle ledger is unreachable by client roles
-- ===========================================================================
DO $$
DECLARE v_bad text;
BEGIN
  -- A throttle a client can READ is one a client can plan around; one a client
  -- can WRITE is not a throttle at all. Supabase's baseline default privileges
  -- would have granted both, so this asserts the REVOKEs landed.
  SELECT string_agg(DISTINCT r.rolname || ':' || a.privilege_type, ', ')
    INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND c.relname = 'public_intake_attempts'
    AND r.rolname IN ('anon', 'authenticated');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: client roles hold privileges on public_intake_attempts — %', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND c.relname = 'public_intake_attempts'
      AND r.rolname = 'service_role' AND a.privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: service_role cannot INSERT into public_intake_attempts — the throttle could not record anything';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: anon and authenticated hold NO privilege on the throttle ledger; service_role can write it.';
END $$;


-- ===========================================================================
-- SECTION C — the direct browser -> Supabase intake path is closed
-- ===========================================================================
DO $$
DECLARE v_bad text;
BEGIN
  -- (i) The anon/authenticated INSERT policy is gone.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND policyname = 'farmer_access_requests: public submit'
  ) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: migration 34''s anon INSERT policy is still present';
  END IF;

  -- (ii) The replacement exists and is scoped to service_role.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND policyname = 'farmer_access_requests: server submit'
       AND cmd = 'INSERT' AND roles = '{service_role}'
  ) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the service_role INSERT policy is missing or not scoped to service_role';
  END IF;

  -- (iii) The table-level grant is revoked too. Leaving it would re-open the
  -- path the moment any other permissive INSERT policy appeared.
  SELECT string_agg(DISTINCT r.rolname, ', ') INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND c.relname = 'farmer_access_requests'
    AND a.privilege_type = 'INSERT' AND r.rolname IN ('anon', 'authenticated');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: % still hold(s) INSERT on farmer_access_requests', v_bad;
  END IF;

  -- (iv) The whole point of R5: no anon-satisfiable write policy remains on this
  -- table by any route.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
       AND coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'auth\.uid|is_ddp_admin|has_farm_membership|has_operational_farmer_access'
  ) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: an anon-satisfiable write policy still exists on farmer_access_requests';
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: the anon INSERT policy and grant are both gone, submission is service_role-only, and no anon-satisfiable write policy remains.';
END $$;


-- ===========================================================================
-- SECTION D — what migration 36 must NOT have touched
-- ===========================================================================
DO $$
BEGIN
  -- The admin triage path is what the UI affordance in this change set drives.
  -- If migration 36 disturbed it, spam would be unreachable AND undeletable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND policyname = 'farmer_access_requests: admin triage' AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the admin triage UPDATE policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND policyname = 'farmer_access_requests: admin read' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the admin read policy is missing';
  END IF;

  -- Migration 34's "deliberately NO delete policy" must still hold. An enquiry
  -- is a record of who asked for access; spam is dispositioned, not erased.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'farmer_access_requests'
       AND cmd IN ('DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a DELETE-capable policy was added — enquiries must be durable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.farmer_access_requests'::regclass
       AND tgname = 'farmer_access_requests_stamp_review' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY D FAILED: the reviewer-stamping trigger is missing';
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: admin read/triage policies, the no-delete posture and the stamping trigger are all intact.';
END $$;


-- ===========================================================================
-- SECTIONS E-F — BEHAVIOUR (ephemeral; no COMMIT)
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- E — the throttle ledger supports the exact query the server function runs:
--     "how many attempts for this bucket since T".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_recent int;
  v_other  int;
BEGIN
  INSERT INTO public.public_intake_attempts (bucket_key, occurred_at) VALUES
    ('36aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW() - interval '30 seconds'),
    ('36aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW() - interval '2 minutes'),
    -- Outside a 10-minute window: must NOT be counted, or the throttle would
    -- never release a bucket.
    ('36aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW() - interval '3 hours'),
    -- A different client must not be affected by this one's attempts.
    ('36bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NOW() - interval '30 seconds');

  SELECT count(*) INTO v_recent FROM public.public_intake_attempts
   WHERE bucket_key = '36aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     AND occurred_at > NOW() - interval '10 minutes';
  IF v_recent <> 2 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: window count is %, expected 2 (the 3-hour-old row must fall outside)', v_recent;
  END IF;

  SELECT count(*) INTO v_other FROM public.public_intake_attempts
   WHERE bucket_key = '36bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
     AND occurred_at > NOW() - interval '10 minutes';
  IF v_other <> 1 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a second bucket counted %, expected 1 — buckets are not isolated', v_other;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: the ledger answers per-bucket windowed counts, ages rows out, and isolates buckets from each other.';
END $$;


-- ---------------------------------------------------------------------------
-- F — the triage dispositions the UI offers are accepted by the status CHECK.
--     A UI option the database rejects is a dead control.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_id     uuid;
  v_status text;
  v_raised boolean := false;
BEGIN
  INSERT INTO public.farmer_access_requests (full_name, email, phone, province, position, note)
  VALUES ('Spam Sender', 'spam36@disposable.test', '0000000000', '', '', '')
  RETURNING id INTO v_id;

  -- The trigger requires an authenticated actor for any status change, so a
  -- disposition without one must be refused — triage has to be attributable.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    UPDATE public.farmer_access_requests SET status = 'declined' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY F FAILED: an unattributed status change was accepted';
  END IF;

  -- With an actor, every disposition the UI offers must land.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-a000-000000000001', true);

  FOREACH v_status IN ARRAY ARRAY['contacted', 'invited', 'declined', 'duplicate'] LOOP
    UPDATE public.farmer_access_requests SET status = v_status WHERE id = v_id;
    IF NOT EXISTS (SELECT 1 FROM public.farmer_access_requests
                    WHERE id = v_id AND status = v_status
                      AND reviewed_by = '00000000-0000-4000-a000-000000000001'
                      AND reviewed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'VERIFY F FAILED: disposition % did not land, or was not attributed', v_status;
    END IF;
  END LOOP;

  RAISE NOTICE 'VERIFY F PASSED: every triage disposition the UI offers is accepted and attributed; an unattributed one is refused.';
END $$;


-- ---------------------------------------------------------------------------
-- G — the atomic reservation reserves BEFORE it evaluates, and admits no more
--     than the ceiling. This is the Codex P1 finding: counting first and
--     recording later is check-then-act, and a concurrent burst passes it.
--
--     A single session cannot demonstrate true concurrency, so this asserts the
--     property that makes concurrency safe — the reservation is counted by its
--     own check, so the Nth caller cannot see fewer than N attempts. The
--     genuinely-parallel proof lives in
--     scripts/disposable-pg/migration-36-throttle-concurrency.test.mjs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_key    text := repeat('e', 64);
  v_rules  jsonb := '[{"scope":"client","windowSeconds":600,"max":3}]'::jsonb;
  v_result jsonb;
  v_rows   int;
  v_admitted int := 0;
  i int;
BEGIN
  FOR i IN 1..5 LOOP
    v_result := public.reserve_public_intake_slot(v_key, 'verify-global-ceiling', v_rules);
    IF (v_result->>'allowed')::boolean THEN
      v_admitted := v_admitted + 1;
    END IF;
  END LOOP;

  IF v_admitted <> 3 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: 5 reservations against a ceiling of 3 admitted %, expected 3', v_admitted;
  END IF;

  -- Every attempt is reserved, including refused ones — otherwise a flood would
  -- reset its own allowance and the ceiling would never bind.
  SELECT count(*) INTO v_rows FROM public.public_intake_attempts WHERE bucket_key = v_key;
  IF v_rows <> 5 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: expected 5 reservations recorded, found %', v_rows;
  END IF;

  -- A refusal must always name a window for Retry-After.
  IF (v_result->>'windowSeconds') IS NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: a refusal did not name the window it exceeded';
  END IF;

  -- The global bucket key the application uses must satisfy the ledger's own
  -- length CHECK. The original 'global' was six characters and would have been
  -- rejected on every submission.
  IF length('global-intake-ceiling') NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: the global bucket key violates the bucket_key length CHECK';
  END IF;

  -- ---- FAIL CLOSED on a malformed policy ---------------------------------
  -- The rules are a parameter supplied by the application, so a typo in
  -- THROTTLE_RULES is a live failure mode. Before this guard, a mistyped key
  -- made `(rule->>'max')::int` NULL, `count > NULL` NULL, and PL/pgSQL's IF
  -- treated that as false — the loop fell through every rule and returned
  -- allowed=true, silently removing the whole throttle with no error anywhere.
  DECLARE
    v_bad     jsonb;
    v_refused int := 0;
  BEGIN
    FOREACH v_bad IN ARRAY ARRAY[
      '[{"scope":"client","windowSeconds":600,"maxx":3}]'::jsonb,  -- typo'd key
      '[{"scope":"client","max":3}]'::jsonb,                        -- no window
      '[]'::jsonb,                                                  -- empty set
      '[null]'::jsonb,                                              -- null rule
      '[{"scope":"client","windowSeconds":-600,"max":3}]'::jsonb,   -- negative
      '[{"scope":"clint","windowSeconds":600,"max":3}]'::jsonb      -- bad scope
    ]
    LOOP
      BEGIN
        PERFORM public.reserve_public_intake_slot(repeat('f', 64), 'verify-global-ceiling', v_bad);
        RAISE EXCEPTION 'VERIFY G FAILED: a malformed rule set was ADMITTED (%) — the throttle failed open', v_bad;
      EXCEPTION
        WHEN invalid_parameter_value THEN
          v_refused := v_refused + 1;
      END;
    END LOOP;

    IF v_refused <> 6 THEN
      RAISE EXCEPTION 'VERIFY G FAILED: expected 6 malformed rule sets to be refused, got %', v_refused;
    END IF;

    -- A refused policy must not have consumed a reservation either: validation
    -- runs before the insert.
    IF EXISTS (SELECT 1 FROM public.public_intake_attempts WHERE bucket_key = repeat('f', 64)) THEN
      RAISE EXCEPTION 'VERIFY G FAILED: a refused policy still burned a reservation';
    END IF;
  END;

  RAISE NOTICE 'VERIFY G PASSED: reservations are counted by their own check, the ceiling binds at 3/5, refusals still consume the allowance, the global key is storable, and a malformed rule set fails CLOSED without burning a reservation.';
END $$;


-- ---------------------------------------------------------------------------
-- H — the duplicate lookup compares a LITERAL address, not a pattern.
--
--     The defect: .ilike('email', <address>) sent the address to SQL ILIKE as a
--     PATTERN. `_` is legal in an email local part, so a_b@example.com matched a
--     stored axb@example.com; the endpoint reported success and wrote nothing,
--     silently losing a real supplier's enquiry.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO public.farmer_access_requests
    (full_name, email, phone, province, position, preferred_language, note, status)
  VALUES ('Verify H', 'axb@verify36.test', '+66 81 000 0000', 'Buriram', 'Owner', 'en', '', 'new');

  -- `_` must be a character, not a single-character wildcard.
  IF public.has_open_access_request('a_b@verify36.test') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: `_` still behaves as a wildcard — a new enquiry would be discarded as a duplicate';
  END IF;

  -- `%` must not match everything.
  IF public.has_open_access_request('%@verify36.test') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: `%%` still behaves as a wildcard';
  END IF;

  -- A backslash must not reintroduce escape/pattern semantics.
  IF public.has_open_access_request('a\_b@verify36.test') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a backslash-escaped pattern still matched';
  END IF;

  -- The genuine duplicate must still be found...
  IF NOT public.has_open_access_request('axb@verify36.test') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: an exact duplicate was not detected';
  END IF;

  -- ...case-insensitively, which is the semantics ILIKE provided and which this
  -- deliberately preserves.
  IF NOT public.has_open_access_request('AXB@Verify36.TEST') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: matching is no longer case-insensitive';
  END IF;

  -- A resolved request must not suppress a fresh enquiry.
  UPDATE public.farmer_access_requests SET status = 'declined' WHERE email = 'axb@verify36.test';
  IF public.has_open_access_request('axb@verify36.test') THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a closed request still suppresses a new one';
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: duplicate detection is a case-insensitive LITERAL comparison; _, %% and \ are ordinary characters.';
END $$;

ROLLBACK;

-- Residue check — run AFTER the rollback above. Every count must be zero.
SELECT
  (SELECT count(*) FROM public.public_intake_attempts WHERE bucket_key LIKE '36%') AS attempts_left,
  (SELECT count(*) FROM public.farmer_access_requests WHERE email = 'spam36@disposable.test') AS requests_left;
