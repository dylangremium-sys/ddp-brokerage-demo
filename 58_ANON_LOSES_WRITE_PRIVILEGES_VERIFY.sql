-- =============================================================================
-- Migration 58 — VERIFY: anon can no longer write, at the privilege layer
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — anon holds INSERT, UPDATE or DELETE on NO public table
--   B — anon still holds SELECT, which is deliberate; the header says why
--   C — BEHAVIOURAL: an anon write now fails with `insufficient_privilege`, not
--       with an RLS violation. Different error, different layer — that IS the
--       second lock
--   D — anon still obtains no data. Either it reads zero rows or it is refused
--       outright; both are "no data", and which one happens depends on grants
--       this migration does not touch (see the section for why)
--   E — `authenticated` is untouched: a farmer can still create and update a
--       batch, which is the regression this migration could most easily cause
--   F — the default privilege is revoked, so a table created tomorrow does not
--       silently re-open the hole
--
-- Expected on success: six PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. No write privilege anywhere
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_offenders text;
BEGIN
  SELECT string_agg(DISTINCT c.relname || ' (' || a.privilege_type || ')', ', ')
    INTO v_offenders
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.grantee = 'anon'::regrole
     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: anon still holds write privileges: %', v_offenders;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: anon holds INSERT, UPDATE or DELETE on no public table.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. SELECT is still there, on purpose
--
-- Asserted rather than assumed. If a later change quietly removes it, an
-- anonymous read starts returning "permission denied for table X" instead of an
-- empty list — which is D17's failure mode, and a decision somebody should make
-- deliberately rather than inherit.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_with_select int;
BEGIN
  SELECT count(DISTINCT c.relname) INTO v_with_select
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.grantee = 'anon'::regrole AND a.privilege_type = 'SELECT';

  IF v_with_select = 0 THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: anon holds SELECT on no table at all. Migration 58 revokes writes ONLY; '
      'losing SELECT converts a silent empty result into an error naming the table.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: anon retains SELECT on % table(s) — deliberate, and the header says why.', v_with_select;
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- Fixture: a farm and a batch for the behavioural sections.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE v58_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

DO $seed$
DECLARE
  f uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (u);
  UPDATE public.profiles SET role = 'farmer' WHERE id = u;   -- handle_new_user() made it 'pending'
  INSERT INTO public.farms (id, farm_name, created_by) VALUES (f, 'VERIFY-58 farm', u);
  INSERT INTO public.farm_memberships (farm_id, user_id) VALUES (f, u);
  INSERT INTO public.inventory_batches (id, farm_id, created_by, product_name, quantity_kg)
  VALUES (b, f, u, 'VERIFY-58 batch', 50);
  INSERT INTO v58_ids VALUES ('farm', f), ('batch', b), ('farmer', u);
END
$seed$;

-- -----------------------------------------------------------------------------
-- C. The second lock, demonstrated
--
-- Before this migration an anon INSERT failed with "new row violates row-level
-- security policy" — RLS catching it. Now it must fail EARLIER, on privilege.
-- The distinction is the whole point: the privilege check does not depend on a
-- policy being correct.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_state    text;
  v_batch    uuid := (SELECT id FROM v58_ids WHERE name = 'batch');  -- before the role switch
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, product_name)
    VALUES (gen_random_uuid(), NULL, 'anon insert');
    v_problems := array_append(v_problems, 'anon INSERTED a batch');
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;                       -- the new lock
    WHEN others THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      v_problems := array_append(v_problems,
        format('anon INSERT was refused by %s, not by privilege — the table grant is still there',
               v_state));
  END;

  BEGIN
    EXECUTE format('UPDATE public.inventory_batches SET quantity_kg = 1 WHERE id = %L', v_batch);
    v_problems := array_append(v_problems, 'anon UPDATE was permitted at the privilege layer');
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      v_problems := array_append(v_problems, format('anon UPDATE refused by %s, not by privilege', v_state));
  END;

  BEGIN
    DELETE FROM public.inventory_batches;
    v_problems := array_append(v_problems, 'anon DELETE was permitted at the privilege layer');
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      v_problems := array_append(v_problems, format('anon DELETE refused by %s, not by privilege', v_state));
  END;
  RESET ROLE;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: anon INSERT, UPDATE and DELETE all fail with insufficient_privilege — refused BEFORE any policy is consulted.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Reads are unchanged: still permitted, still empty
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_seen    int;
  v_refused boolean := false;
  v_err     text;
BEGIN
  -- Two outcomes are acceptable, and WHICH one occurs is not this migration's
  -- doing. Migration 58 revokes table INSERT/UPDATE/DELETE and touches neither
  -- SELECT nor function EXECUTE.
  --
  -- On production, anon reading inventory_batches returns an empty list
  -- (measured on staging 2026-08-05). Against the disposable substrate the same
  -- read raises `permission denied for function has_farm_membership`, because
  -- the substrate grants anon less EXECUTE than production does — the RLS
  -- predicate is evaluated with the CALLER's privileges, so a policy that calls
  -- a function anon cannot execute fails instead of filtering.
  --
  -- That divergence is a real gap in the substrate and is recorded as such; it
  -- is not something to paper over by loosening the assertion to nothing. What
  -- this section must prove is that anon obtains NO DATA, and both outcomes are
  -- that. What would fail it is a row.
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_seen FROM public.inventory_batches;
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  RESET ROLE;

  IF NOT v_refused AND v_seen <> 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: anon can see % batch row(s). RLS is not holding.', v_seen;
  END IF;

  IF v_refused THEN
    RAISE NOTICE 'VERIFY D PASSED: anon obtains no data — refused outright (%). Production returns an empty list instead; the substrate grants anon less function EXECUTE than production, which is a substrate gap, not a migration-58 effect.', v_err;
  ELSE
    RAISE NOTICE 'VERIFY D PASSED: anon still reads inventory_batches without error and still gets zero rows — nothing was traded away.';
  END IF;
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. authenticated is untouched
--
-- The regression this migration could most easily cause: revoking too widely and
-- taking the farmer's own write path with it.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_id       uuid := gen_random_uuid();
  v_farm     uuid := (SELECT id FROM v58_ids WHERE name = 'farm');
  v_farmer   uuid := (SELECT id FROM v58_ids WHERE name = 'farmer');
  v_q        numeric;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_farmer)::text, true);

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, created_by, product_name, quantity_kg)
    VALUES (v_id, v_farm, v_farmer, 'VERIFY-58 farmer batch', 5);
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a FARMER could no longer create a batch: ' || SQLERRM);
  END;

  BEGIN
    UPDATE public.inventory_batches SET quantity_kg = 7 WHERE id = v_id;
    SELECT quantity_kg INTO v_q FROM public.inventory_batches WHERE id = v_id;
    IF v_q IS DISTINCT FROM 7 THEN
      v_problems := array_append(v_problems, 'a FARMER could no longer update their own batch');
    END IF;
  EXCEPTION WHEN others THEN
    v_problems := array_append(v_problems, 'a FARMER update raised: ' || SQLERRM);
  END;
  RESET ROLE;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: an authenticated farmer can still create and update their own batch — the revoke did not overreach.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. A table created tomorrow does not re-open the hole
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_privs text;
BEGIN
  CREATE TABLE public.v58_future_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

  SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '')
    INTO v_privs
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE n.nspname = 'public' AND c.relname = 'v58_future_table'
     AND a.grantee = 'anon'::regrole
     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  DROP TABLE public.v58_future_table;

  IF v_privs <> '' THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: a newly created table granted anon %. The default privilege was not '
      'revoked, so the next migration to add a table re-opens this silently.', v_privs;
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: a table created after this migration grants anon no write privilege.';
END
$verify_f$;

ROLLBACK;
