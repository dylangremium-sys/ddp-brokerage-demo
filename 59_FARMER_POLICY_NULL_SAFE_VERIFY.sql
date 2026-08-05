-- =============================================================================
-- 59_FARMER_POLICY_NULL_SAFE_VERIFY.sql
--
-- NOT read-only. Wrapped in BEGIN..ROLLBACK; commits nothing.
--
-- Proves both halves, because only proving one would be worse than proving
-- neither: that the NULL cases are now ADMITTED, and that everything the
-- guardrails exist to REFUSE is still refused. A migration that loosened a
-- security policy and only tested the loosening would look green while handing
-- a farmer the ability to self-approve.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE v59 (name text PRIMARY KEY, id uuid);
INSERT INTO v59 VALUES
  ('farmer',  '00000000-0000-4000-8000-000000059001'),
  ('rival',   '00000000-0000-4000-8000-000000059002'),
  ('farm',    '00000000-0000-4000-8000-000000059f01'),
  ('rivalfarm','00000000-0000-4000-8000-000000059f02');

-- auth.users first: on staging/production profiles.id carries a FOREIGN KEY to
-- auth.users, and a handle_new_user() trigger pre-creates the profile as
-- 'pending'. The disposable substrate has neither. Insert the user, then upsert
-- the profile, so this runs identically in both worlds -- a plain INSERT into
-- profiles fails the FK on staging, and a plain INSERT with no ON CONFLICT
-- collides with the trigger's row.
INSERT INTO auth.users (id, email)
SELECT id, name || '@v59.verify.invalid' FROM v59 WHERE name IN ('farmer','rival')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, role)
SELECT id, 'farmer' FROM v59 WHERE name IN ('farmer','rival')
ON CONFLICT (id) DO UPDATE SET role = 'farmer';

INSERT INTO public.farms (id, farm_name, created_by)
VALUES ((SELECT id FROM v59 WHERE name='farm'),      'V59 Farm',  (SELECT id FROM v59 WHERE name='farmer')),
       ((SELECT id FROM v59 WHERE name='rivalfarm'), 'V59 Rival', (SELECT id FROM v59 WHERE name='rival'));

-- Read the ids into variables BEFORE any SET ROLE: a TEMP table belongs to the
-- session user, so a later `SET LOCAL ROLE authenticated` turns every read of it
-- into "permission denied for table v59" — an error that looks exactly like the
-- policy under test refusing something.
CREATE OR REPLACE FUNCTION pg_temp.v59_farmer() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT '00000000-0000-4000-8000-000000059001'::uuid $$;

-- -----------------------------------------------------------------------------
-- A. The premise, asserted rather than assumed
-- -----------------------------------------------------------------------------
DO $verify_a$
BEGIN
  IF (NULL::text <> 'Approved') IS TRUE THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: this PostgreSQL evaluates NULL <> ''Approved'' as TRUE, so the defect this '
      'migration fixes does not exist here and its reasoning needs revisiting.';
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: NULL <> ''Approved'' is not TRUE, which is why the old predicate refused.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. Structure: the NULL branches are in the catalogue, the guardrails survive
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_ins text; v_upd_u text; v_upd_c text; v_problems text[] := ARRAY[]::text[];
BEGIN
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  SELECT qual, with_check INTO v_upd_u, v_upd_c FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer update own';

  IF v_ins   NOT LIKE '%status IS NULL%'       THEN v_problems := array_append(v_problems, 'INSERT: no NULL branch for status'); END IF;
  IF v_upd_u NOT LIKE '%stock_status IS NULL%' THEN v_problems := array_append(v_problems, 'UPDATE USING: no NULL branch for stock_status'); END IF;
  IF v_upd_c NOT LIKE '%status IS NULL%'       THEN v_problems := array_append(v_problems, 'UPDATE CHECK: no NULL branch for status'); END IF;
  IF v_ins   NOT LIKE '%client_visible = false%' THEN v_problems := array_append(v_problems, 'INSERT: client_visible guard lost'); END IF;
  IF v_upd_c NOT LIKE '%client_visible = false%' THEN v_problems := array_append(v_problems, 'UPDATE: client_visible guard lost'); END IF;
  IF v_ins   NOT LIKE '%Approved%'             THEN v_problems := array_append(v_problems, 'INSERT: self-approval guard lost'); END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: both policies carry their NULL branches AND all four guardrails.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. THE DEFECT: a farmer can now create a batch without naming a status
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_farm uuid := '00000000-0000-4000-8000-000000059f01';
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000059001","role":"authenticated"}', true);
  BEGIN
    INSERT INTO public.inventory_batches (farm_id, created_by, batch_number)
    VALUES (v_farm, pg_temp.v59_farmer(), 'V59-NO-STATUS');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    RAISE EXCEPTION
      'VERIFY C FAILED: a farmer still cannot create a batch without a status — the defect this '
      'migration exists to fix is not fixed.';
  END;
  RESET ROLE;
  RAISE NOTICE 'VERIFY C PASSED: a batch with a NULL status is admitted.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. THE OTHER DEFECT: a batch with a NULL stock_status is editable by its owner
--
-- The silent one. Before 59 this UPDATE affected 0 rows and raised nothing, so
-- the row count is the assertion — an exception handler would never have fired.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_farm uuid := '00000000-0000-4000-8000-000000059f01';
  v_id   uuid := '00000000-0000-4000-8000-0000000590d1';
  v_rows int;
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, created_by, batch_number, status, stock_status)
  VALUES (v_id, v_farm, pg_temp.v59_farmer(), 'V59-NULL-STOCK', 'Pending', NULL);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000059001","role":"authenticated"}', true);
  UPDATE public.inventory_batches SET quantity_kg = 7 WHERE id = v_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: a farmer updating their own batch with a NULL stock_status changed % row(s), '
      'expected 1. This is the failure that reports no error at all.', v_rows;
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: a batch with a NULL stock_status is editable by its owner.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. The guardrails still REFUSE. Loosening NULL must not loosen anything else.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_farm  uuid := '00000000-0000-4000-8000-000000059f01';
  v_rival uuid := '00000000-0000-4000-8000-000000059f02';
  v_problems text[] := ARRAY[]::text[];
  v_case text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000059001","role":"authenticated"}', true);

  FOREACH v_case IN ARRAY ARRAY['self_approve', 'publish', 'admin_state'] LOOP
    BEGIN
      IF v_case = 'self_approve' THEN
        INSERT INTO public.inventory_batches (farm_id, created_by, batch_number, status)
        VALUES (v_farm, pg_temp.v59_farmer(), 'V59-X1', 'Approved');
      ELSIF v_case = 'publish' THEN
        INSERT INTO public.inventory_batches (farm_id, created_by, batch_number, client_visible)
        VALUES (v_farm, pg_temp.v59_farmer(), 'V59-X2', true);
      ELSE
        INSERT INTO public.inventory_batches (farm_id, created_by, batch_number, stock_status)
        VALUES (v_farm, pg_temp.v59_farmer(), 'V59-X3', 'sold');
      END IF;
      v_problems := array_append(v_problems, v_case || ' was ADMITTED');
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN
      NULL;
    END;
  END LOOP;
  RESET ROLE;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: self-approval, self-publishing and admin-only lifecycle states are all still refused.';
END
$verify_e$;

-- The gap section F used to pin -- a farmer attaching a batch to a farm they do
-- not belong to -- is CLOSED by migration 60, which replaces the self-referential
-- `created_by = auth.uid()` branch with has_farm_claim(). Its proof lives in
-- 60_BATCH_MUST_BELONG_TO_YOUR_FARM_VERIFY.sql sections D and E. This section was
-- written to fail once the gap closed, so that closing it could not be forgotten;
-- it has done its job and been removed rather than left asserting the opposite of
-- what is now true.


ROLLBACK;
