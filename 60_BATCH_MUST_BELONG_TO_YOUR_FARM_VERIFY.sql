-- =============================================================================
-- 60_BATCH_MUST_BELONG_TO_YOUR_FARM_VERIFY.sql
--
-- NOT read-only. Wrapped in BEGIN..ROLLBACK; commits nothing.
--
-- The hole is closed (D, E). Just as important: NOBODY IS LOCKED OUT (B, C).
-- A permission fix that refuses the people it was meant to serve is not a fix,
-- and the lockout case here is the subtle one — the creator of a brand-new farm
-- has no farm_memberships row, because nothing in this system creates one.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE v60 (name text PRIMARY KEY, id uuid);
INSERT INTO v60 VALUES
  ('member',    '00000000-0000-4000-8000-000000060001'),  -- member of farm_m
  ('creator',   '00000000-0000-4000-8000-000000060002'),  -- created farm_c, NO membership row
  ('rival',     '00000000-0000-4000-8000-000000060003'),
  ('farm_m',    '00000000-0000-4000-8000-000000060f01'),
  ('farm_c',    '00000000-0000-4000-8000-000000060f02'),
  ('farm_r',    '00000000-0000-4000-8000-000000060f03');

INSERT INTO auth.users (id, email)
SELECT id, name || '@v60.verify.invalid' FROM v60 WHERE name IN ('member','creator','rival')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, role)
SELECT id, 'farmer' FROM v60 WHERE name IN ('member','creator','rival')
ON CONFLICT (id) DO UPDATE SET role = 'farmer';

-- farm_m is created by the RIVAL and the member is added to it, so that "member"
-- holds it by membership ALONE. farm_c is created by "creator" with NO
-- membership row, which is the lockout case. Keeping the two branches on
-- different users is what stops one branch masking the other.
INSERT INTO public.farms (id, farm_name, created_by) VALUES
  ('00000000-0000-4000-8000-000000060f01', 'V60 Member Farm',  '00000000-0000-4000-8000-000000060003'),
  ('00000000-0000-4000-8000-000000060f02', 'V60 Creator Farm', '00000000-0000-4000-8000-000000060002'),
  ('00000000-0000-4000-8000-000000060f03', 'V60 Rival Farm',   '00000000-0000-4000-8000-000000060003');

INSERT INTO public.farm_memberships (farm_id, user_id)
VALUES ('00000000-0000-4000-8000-000000060f01', '00000000-0000-4000-8000-000000060001');

CREATE OR REPLACE FUNCTION pg_temp.v60_as(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
END $$;

-- -----------------------------------------------------------------------------
-- A. Structure — the predicate, and the privileges on it
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_ins text; v_upd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='has_farm_claim' AND p.prosecdef) THEN
    v_problems := array_append(v_problems, 'has_farm_claim missing or not SECURITY DEFINER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
                      unnest(coalesce(p.proconfig, ARRAY[]::text[])) cfg
                 WHERE n.nspname='public' AND p.proname='has_farm_claim' AND cfg LIKE 'search_path=%') THEN
    v_problems := array_append(v_problems, 'has_farm_claim has no pinned search_path');
  END IF;
  IF has_function_privilege('anon', 'public.has_farm_claim(uuid)', 'EXECUTE') THEN
    v_problems := array_append(v_problems, 'anon can EXECUTE has_farm_claim');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.has_farm_claim(uuid)', 'EXECUTE') THEN
    v_problems := array_append(v_problems, 'authenticated cannot EXECUTE has_farm_claim — every farmer is locked out');
  END IF;

  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer insert own';
  SELECT with_check INTO v_upd FROM pg_policies WHERE schemaname='public'
    AND tablename='inventory_batches' AND policyname='inventory_batches: farmer update own';
  IF v_ins LIKE '%created_by = auth.uid()%' THEN
    v_problems := array_append(v_problems, 'INSERT WITH CHECK still trusts a column the writer chooses');
  END IF;
  IF v_upd LIKE '%created_by = auth.uid()%' THEN
    v_problems := array_append(v_problems, 'UPDATE WITH CHECK still trusts a column the writer chooses');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: has_farm_claim is SECURITY DEFINER, search_path-pinned, closed to anon; neither WITH CHECK trusts created_by.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- B. NOT LOCKED OUT — a member can still place a batch on their farm
-- -----------------------------------------------------------------------------
DO $verify_b$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.v60_as('00000000-0000-4000-8000-000000060001');
  BEGIN
    INSERT INTO public.inventory_batches (farm_id, created_by, batch_number)
    VALUES ('00000000-0000-4000-8000-000000060f01', '00000000-0000-4000-8000-000000060001', 'V60-B');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY B FAILED: a MEMBER can no longer place a batch on their own farm.';
  END;
  RESET ROLE;
  RAISE NOTICE 'VERIFY B PASSED: a farm member can still place a batch on that farm.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. NOT LOCKED OUT — the creator of a farm with NO membership row
--
-- The case membership-only would have broken. Nothing in this system writes
-- farm_memberships, so this is the ordinary path for a farmer's first batch on a
-- farm they have just registered, not an edge case.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_has_membership boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.farm_memberships
                  WHERE farm_id='00000000-0000-4000-8000-000000060f02'
                    AND user_id='00000000-0000-4000-8000-000000060002') INTO v_has_membership;
  IF v_has_membership THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: the fixture gave the creator a membership row, so this section would pass '
      'via the wrong branch and prove nothing about the lockout case.';
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.v60_as('00000000-0000-4000-8000-000000060002');
  BEGIN
    INSERT INTO public.inventory_batches (farm_id, created_by, batch_number)
    VALUES ('00000000-0000-4000-8000-000000060f02', '00000000-0000-4000-8000-000000060002', 'V60-C');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    RAISE EXCEPTION
      'VERIFY C FAILED: the CREATOR of a farm, who has no membership row, cannot place a batch on '
      'it. This migration has locked farmers out of farms they just registered.';
  END;
  RESET ROLE;
  RAISE NOTICE 'VERIFY C PASSED: a farm''s creator can place a batch on it WITHOUT a membership row.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. THE FIX — a farmer cannot place a batch on a rival's farm
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_admitted boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.v60_as('00000000-0000-4000-8000-000000060001');
  BEGIN
    -- Naming yourself as created_by is exactly what used to work.
    INSERT INTO public.inventory_batches (farm_id, created_by, batch_number)
    VALUES ('00000000-0000-4000-8000-000000060f03', '00000000-0000-4000-8000-000000060001', 'V60-D');
    v_admitted := true;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    v_admitted := false;
  END;
  RESET ROLE;

  IF v_admitted THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: a farmer still attached a batch to a farm they neither created nor belong '
      'to, by naming themselves as created_by. The hole is open.';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: a batch on a rival''s farm is refused, even when the writer names themselves.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. The same door, from inside — a farmer cannot MOVE a batch onto a rival's farm
--
-- WITH CHECK governs the row as it will EXIST, so an UPDATE that re-points
-- farm_id is the same attack with an extra step. Tested separately because a fix
-- applied to INSERT alone would leave it wide open.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_id   uuid := '00000000-0000-4000-8000-0000000600e1';
  v_rows int;
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, created_by, batch_number, stock_status)
  VALUES (v_id, '00000000-0000-4000-8000-000000060f01',
                '00000000-0000-4000-8000-000000060001', 'V60-E', 'draft');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.v60_as('00000000-0000-4000-8000-000000060001');
  BEGIN
    UPDATE public.inventory_batches
       SET farm_id = '00000000-0000-4000-8000-000000060f03'
     WHERE id = v_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    v_rows := 0;
  END;
  RESET ROLE;

  IF v_rows <> 0 THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: a farmer moved their batch onto a rival''s farm (% row(s) updated).', v_rows;
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: a batch cannot be re-pointed at a farm the caller has no claim to.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. Migration 59's work survives — a NULL status is still admitted
-- -----------------------------------------------------------------------------
DO $verify_f$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.v60_as('00000000-0000-4000-8000-000000060001');
  BEGIN
    INSERT INTO public.inventory_batches (farm_id, created_by, batch_number)
    VALUES ('00000000-0000-4000-8000-000000060f01', '00000000-0000-4000-8000-000000060001', 'V60-F');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    RAISE EXCEPTION
      'VERIFY F FAILED: a batch with a NULL status is refused again — migration 60 undid 59.';
  END;
  RESET ROLE;
  RAISE NOTICE 'VERIFY F PASSED: migration 59''s NULL-safety is intact.';
END
$verify_f$;

ROLLBACK;
