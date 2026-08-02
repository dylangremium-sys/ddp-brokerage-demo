-- ===========================================================================
-- 35_STATUS_TRANSITION_ATOMIC_VERIFY.sql
-- ---------------------------------------------------------------------------
-- Verification for 35_STATUS_TRANSITION_ATOMIC_HARDENING.sql.
--
-- SECTIONS A-B (object state and ACL) are READ-ONLY and safe to run anywhere,
-- including Production. They RAISE if any required property is missing.
--
-- SECTIONS C-J are BEHAVIOURAL. They build an ephemeral fixture and exercise the
-- happy path, the atomicity guarantee, every authorisation branch, and the
-- server-authoritative-input rules. The whole block is one BEGIN ... ROLLBACK
-- with NO COMMIT, so it leaves no residue. Run as postgres/superuser against a
-- NON-PRODUCTION database with migration 35 applied. Fixed test ids are asserted
-- absent up front so a partial previous run cannot make a section vacuous.
--
-- Sections: A B C D E F G H I J  (10)
-- ===========================================================================


-- ===========================================================================
-- SECTION A — OBJECT STATE (read-only; RAISEs on drift)
-- ===========================================================================
DO $$
DECLARE
  v_oid       oid;
  v_secdef    boolean;
  v_config    text[];
  v_rettype   text;
BEGIN
  -- to_regprocedure resolves an exact signature and returns NULL (rather than
  -- raising) when it does not exist, which is what lets the RAISE below carry a
  -- useful message. NOTE: pg_get_function_identity_arguments() is NOT usable for
  -- this match — for a function with named parameters it returns
  -- "p_entity_type text, p_entity_id uuid, ..." including the names, not the
  -- bare type list.
  v_oid := to_regprocedure('public.record_status_transition(text, uuid, text, text, uuid)');

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: public.record_status_transition(text, uuid, text, text, uuid) does not exist';
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_catalog.format_type(p.prorettype, NULL)
    INTO v_secdef, v_config, v_rettype
  FROM pg_proc p WHERE p.oid = v_oid;

  -- SECURITY DEFINER is what lets one function hold both writes. Without it the
  -- function would be a wrapper with no added guarantee over the two-call path.
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VERIFY A FAILED: record_status_transition is not SECURITY DEFINER';
  END IF;

  -- An unpinned search_path on a SECURITY DEFINER function is the classic
  -- privilege-escalation vector: a caller-controlled schema can shadow `public`.
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) c WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: record_status_transition has no pinned search_path';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_config) c
    WHERE replace(c, ' ', '') = 'search_path=public,auth,pg_temp'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: search_path is % — expected public, auth, pg_temp',
      array_to_string(v_config, ',');
  END IF;

  IF v_rettype <> 'uuid' THEN
    RAISE EXCEPTION 'VERIFY A FAILED: return type is %, expected uuid (the status_history id)', v_rettype;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: record_status_transition exists, is SECURITY DEFINER, pins search_path = public, auth, pg_temp, and returns the history id.';
END $$;


-- ===========================================================================
-- SECTION B — ACL (read-only; RAISEs on drift)
-- ===========================================================================
DO $$
DECLARE
  v_oid          oid;
  v_bad          text;
  v_has_authn    boolean;
BEGIN
  v_oid := to_regprocedure('public.record_status_transition(text, uuid, text, text, uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: record_status_transition does not exist (section A should have caught this)';
  END IF;

  -- Supabase default-grants EXECUTE on a new public function to PUBLIC, which
  -- includes anon. If the migration's REVOKEs did not land, an unauthenticated
  -- caller holds EXECUTE on a SECURITY DEFINER function.
  SELECT string_agg(DISTINCT coalesce(r.rolname, 'PUBLIC'), ', ')
    INTO v_bad
  FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE p.oid = v_oid
    AND a.privilege_type = 'EXECUTE'
    AND (a.grantee = 0 OR coalesce(r.rolname, '') = 'anon');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: EXECUTE is held by % — must be revoked from PUBLIC and anon', v_bad;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE' AND r.rolname = 'authenticated'
  ) INTO v_has_authn;

  IF NOT v_has_authn THEN
    RAISE EXCEPTION 'VERIFY B FAILED: `authenticated` does not hold EXECUTE — the application could not call the RPC at all';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: EXECUTE granted to authenticated only; revoked from PUBLIC and anon.';
END $$;


-- ===========================================================================
-- SECTIONS C-J — BEHAVIOUR (ephemeral fixture; no COMMIT)
-- ===========================================================================
BEGIN;

-- Fixed ids, asserted absent first so a leftover row cannot make a later section
-- pass without having tested anything.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM auth.users
   WHERE id IN ('00350000-0000-4000-a000-000000000001','00350000-0000-4000-a000-000000000002');
  IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY setup FAILED: test auth.users rows already exist'; END IF;

  SELECT count(*) INTO v_n FROM public.status_history WHERE entity_id
   IN ('00350000-0000-4000-b000-000000000001','00350000-0000-4000-c000-000000000001');
  IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY setup FAILED: test status_history rows already exist'; END IF;
END $$;

INSERT INTO auth.users (id, email) VALUES
  ('00350000-0000-4000-a000-000000000001', 'admin35@disposable.test'),
  ('00350000-0000-4000-a000-000000000002', 'farmer35@disposable.test');

-- ON CONFLICT … DO UPDATE, and it is not optional on hosted Supabase.
--
-- The INSERT INTO auth.users above fires `on_auth_user_created` ->
-- handle_new_user(), which has ALREADY created both profile rows with role
-- 'pending'. A plain INSERT therefore raises
--   duplicate key value violates unique constraint "profiles_pkey"
-- and the whole VERIFY dies at this line — measured against staging 2026-08-02.
-- It passes on the disposable PostgreSQL harness only because that cluster has
-- no such trigger, which is precisely the class of false PASS the harness gives.
--
-- DO NOTHING would not fix it either: it would leave both roles as 'pending',
-- is_ddp_admin() would return false, and the assertions below would fail with
-- messages blaming the migration rather than the fixture.
INSERT INTO public.profiles (id, email, role) VALUES
  ('00350000-0000-4000-a000-000000000001', 'admin35@disposable.test',  'ddp_admin'),
  ('00350000-0000-4000-a000-000000000002', 'farmer35@disposable.test', 'farmer')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

-- ACT AS THE ADMIN BEFORE CREATING THE FIXTURES, OR THE FIELD GUARD REWRITES THEM.
--
-- `trg_protect_farm_admin_fields` (migrations 19/20) forces, on any INSERT by a
-- caller that is not a DDP admin:
--     new.status := 'Submitted to DDP'
-- So without this line the farm below is created as 'Submitted to DDP' rather
-- than 'Pending Review', and section C then fails with
--   "history says Submitted to DDP -> Approved, expected Pending Review -> Approved"
-- which reads as a defect in record_status_transition() when the migration is
-- perfectly correct and the FIXTURE was silently rewritten. Measured on staging
-- 2026-08-02.
--
-- Setting the claim is legitimate rather than a workaround: 'Pending Review' is
-- an admin-assigned status in this schema, so an admin is the only actor who
-- could have produced the state this section is written to test.
SELECT set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);

INSERT INTO public.farms (id, created_by, status)
  VALUES ('00350000-0000-4000-b000-000000000001', '00350000-0000-4000-a000-000000000002', 'Pending Review');

INSERT INTO public.inventory_batches (id, farm_id, created_by, status)
  VALUES ('00350000-0000-4000-c000-000000000001', '00350000-0000-4000-b000-000000000001',
          '00350000-0000-4000-a000-000000000002', 'Pending Review');


-- ---------------------------------------------------------------------------
-- C — happy path, farm: one call moves the row AND writes the history record.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_history_id uuid;
  v_status     text;
  v_old        text;
  v_new        text;
  v_reviewer   uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);

  v_history_id := public.record_status_transition(
    'farm', '00350000-0000-4000-b000-000000000001', 'Approved');

  IF v_history_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the function returned no status_history id';
  END IF;

  SELECT status, reviewed_by INTO v_status, v_reviewer
    FROM public.farms WHERE id = '00350000-0000-4000-b000-000000000001';
  IF v_status <> 'Approved' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: farm status is %, expected Approved', v_status;
  END IF;
  IF v_reviewer <> '00350000-0000-4000-a000-000000000001' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: farm reviewed_by is %, expected the calling admin', v_reviewer;
  END IF;

  SELECT old_status, new_status INTO v_old, v_new
    FROM public.status_history WHERE id = v_history_id;
  IF v_old <> 'Pending Review' OR v_new <> 'Approved' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: history says % -> %, expected Pending Review -> Approved', v_old, v_new;
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a farm transition applies the row change and writes its history record in one call.';
END $$;


-- ---------------------------------------------------------------------------
-- D — happy path, inventory_batch.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_history_id uuid;
  v_status     text;
  v_n          int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);

  v_history_id := public.record_status_transition(
    'inventory_batch', '00350000-0000-4000-c000-000000000001', 'Approved', 'Pending Review',
    '00350000-0000-4000-a000-000000000001');

  SELECT status INTO v_status FROM public.inventory_batches
   WHERE id = '00350000-0000-4000-c000-000000000001';
  IF v_status <> 'Approved' THEN
    RAISE EXCEPTION 'VERIFY D FAILED: batch status is %, expected Approved', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.status_history
   WHERE id = v_history_id AND entity_type = 'inventory_batch';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: expected exactly 1 inventory_batch history row, found %', v_n;
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: an inventory_batch transition applies the row change and writes its history record in one call.';
END $$;


-- ---------------------------------------------------------------------------
-- E — THE POINT OF THE MIGRATION. A failure part-way through must leave NOTHING
--     behind: no status change without its history row, no history row without
--     its status change. Exercised on a non-existent entity, which fails AFTER
--     authorisation has passed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_before_hist int;
  v_after_hist  int;
  v_raised      boolean := false;
  v_sqlstate    text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);
  SELECT count(*) INTO v_before_hist FROM public.status_history;

  BEGIN
    PERFORM public.record_status_transition(
      'farm', '00350000-0000-4000-b000-0000000000ff', 'Approved');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    v_sqlstate := SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a transition on a non-existent farm did not raise';
  END IF;
  IF v_sqlstate <> 'P0002' THEN
    RAISE EXCEPTION 'VERIFY E FAILED: expected SQLSTATE P0002 (no_data_found), got %', v_sqlstate;
  END IF;

  SELECT count(*) INTO v_after_hist FROM public.status_history;
  IF v_after_hist <> v_before_hist THEN
    RAISE EXCEPTION 'VERIFY E FAILED: a failed transition wrote % history row(s) — the two writes are NOT atomic',
      v_after_hist - v_before_hist;
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: a failed transition writes neither half — the status change and its history record are atomic.';
END $$;


-- ---------------------------------------------------------------------------
-- F — a farmer is refused. status_history has no permissive INSERT policy for
--     any role but ddp_admin, so admitting a farmer here would grant through a
--     SECURITY DEFINER function a write RLS refuses directly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_raised   boolean := false;
  v_sqlstate text;
  v_status   text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000002', true);

  BEGIN
    PERFORM public.record_status_transition(
      'farm', '00350000-0000-4000-b000-000000000001', 'Rejected');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    v_sqlstate := SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY F FAILED: a farmer was permitted to record a status transition — this is privilege escalation';
  END IF;
  IF v_sqlstate <> '42501' THEN
    RAISE EXCEPTION 'VERIFY F FAILED: expected SQLSTATE 42501 (insufficient_privilege), got %', v_sqlstate;
  END IF;

  SELECT status INTO v_status FROM public.farms WHERE id = '00350000-0000-4000-b000-000000000001';
  IF v_status <> 'Approved' THEN
    RAISE EXCEPTION 'VERIFY F FAILED: the refused call still changed the farm status to %', v_status;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: a farmer is refused with 42501 and the row is unchanged.';
END $$;


-- ---------------------------------------------------------------------------
-- G — an unauthenticated caller is refused. auth.uid() is NULL, so there is no
--     identity to attribute the transition to.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_raised   boolean := false;
  v_sqlstate text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);

  BEGIN
    PERFORM public.record_status_transition(
      'farm', '00350000-0000-4000-b000-000000000001', 'Rejected');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    v_sqlstate := SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY G FAILED: an unauthenticated caller recorded a status transition';
  END IF;
  IF v_sqlstate <> '42501' THEN
    RAISE EXCEPTION 'VERIFY G FAILED: expected SQLSTATE 42501, got %', v_sqlstate;
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: an unauthenticated caller is refused with 42501.';
END $$;


-- ---------------------------------------------------------------------------
-- H — a transition cannot be attributed to a DIFFERENT administrator. The same
--     standard migrations 17, 30 and 34 set for their own actor columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_raised   boolean := false;
  v_sqlstate text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);

  BEGIN
    PERFORM public.record_status_transition(
      'farm', '00350000-0000-4000-b000-000000000001', 'Rejected', 'Approved',
      '00350000-0000-4000-a000-000000000002');   -- someone else
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    v_sqlstate := SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY H FAILED: a transition was attributed to an administrator who did not make it';
  END IF;
  IF v_sqlstate <> '42501' THEN
    RAISE EXCEPTION 'VERIFY H FAILED: expected SQLSTATE 42501, got %', v_sqlstate;
  END IF;

  RAISE NOTICE 'VERIFY H PASSED: a reviewer_id that is not the authenticated caller is refused, not silently rewritten.';
END $$;


-- ---------------------------------------------------------------------------
-- I — old_status is read from the row, not taken from the caller. A stale or
--     dishonest client value must never enter the compliance record.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_history_id uuid;
  v_old        text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);

  -- The farm is at 'Approved' (section C). Claim it was something else entirely.
  v_history_id := public.record_status_transition(
    'farm', '00350000-0000-4000-b000-000000000001', 'Missing Document',
    'THIS-VALUE-IS-A-LIE');

  SELECT old_status INTO v_old FROM public.status_history WHERE id = v_history_id;

  IF v_old = 'THIS-VALUE-IS-A-LIE' THEN
    RAISE EXCEPTION 'VERIFY I FAILED: the caller-supplied old_status was written to the audit record';
  END IF;
  IF v_old <> 'Approved' THEN
    RAISE EXCEPTION 'VERIFY I FAILED: old_status is %, expected the row''s actual prior value ''Approved''', v_old;
  END IF;

  RAISE NOTICE 'VERIFY I PASSED: old_status is read from the row under lock; the caller-supplied value is advisory and never recorded.';
END $$;


-- ---------------------------------------------------------------------------
-- J — input validation. An unknown entity_type must be refused rather than
--     silently treated as one of the two known tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_raised   boolean := false;
  v_sqlstate text;
  v_before   int;
  v_after    int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00350000-0000-4000-a000-000000000001', true);
  SELECT count(*) INTO v_before FROM public.status_history;

  BEGIN
    PERFORM public.record_status_transition(
      'buyer_pack', '00350000-0000-4000-b000-000000000001', 'Approved');
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    v_sqlstate := SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'VERIFY J FAILED: an unknown entity_type was accepted';
  END IF;
  IF v_sqlstate <> '22023' THEN
    RAISE EXCEPTION 'VERIFY J FAILED: expected SQLSTATE 22023 (invalid_parameter_value), got %', v_sqlstate;
  END IF;

  SELECT count(*) INTO v_after FROM public.status_history;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'VERIFY J FAILED: a rejected entity_type still wrote a history row';
  END IF;

  RAISE NOTICE 'VERIFY J PASSED: an unknown entity_type is refused with 22023 and writes nothing.';
END $$;

ROLLBACK;

-- Residue check — run AFTER the rollback above. Every count must be zero.
SELECT
  (SELECT count(*) FROM auth.users
    WHERE id IN ('00350000-0000-4000-a000-000000000001','00350000-0000-4000-a000-000000000002')) AS users_left,
  (SELECT count(*) FROM public.profiles
    WHERE id IN ('00350000-0000-4000-a000-000000000001','00350000-0000-4000-a000-000000000002')) AS profiles_left,
  (SELECT count(*) FROM public.farms
    WHERE id = '00350000-0000-4000-b000-000000000001') AS farms_left,
  (SELECT count(*) FROM public.inventory_batches
    WHERE id = '00350000-0000-4000-c000-000000000001') AS batches_left,
  (SELECT count(*) FROM public.status_history
    WHERE entity_id IN ('00350000-0000-4000-b000-000000000001','00350000-0000-4000-c000-000000000001')) AS history_left;
