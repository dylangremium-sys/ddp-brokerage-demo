-- =============================================================================
-- Migration 56 — VERIFY: batch dates are real dates in the right calendar
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure: all four columns are `date`, and all seven constraints exist
--   B — an ordinary batch with sensible dates is admitted, so every refusal
--       below is a refusal of the value
--   C — a Buddhist-Era year is refused on all four columns — the case this
--       migration exists for, and the one converting to `date` does NOT catch
--   D — the type itself now refuses what text accepted: 2026-02-30, 2026-13-01,
--       and 'sometime in March'
--   E — ordering: cured, tested or expiring before harvest is refused, and a
--       zero-day shelf life is refused
--   F — the rules are inert when a date is missing, so a half-entered batch is
--       still admitted, and same-day harvest-and-test is allowed
--   G — the boundary years 2000 and 2100 are both admitted, so the bound is
--       inclusive and not off by one
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
  v_col     text;
  v_name    text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['harvest_date', 'cure_date', 'test_date', 'expiry_date'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                     AND column_name = v_col AND data_type = 'date') THEN
      v_missing := array_append(v_missing, format('inventory_batches.%s is not of type date', v_col));
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY['inventory_batches_harvest_date_ce_year',
                                'inventory_batches_cure_date_ce_year',
                                'inventory_batches_test_date_ce_year',
                                'inventory_batches_expiry_date_ce_year',
                                'inventory_batches_cure_after_harvest',
                                'inventory_batches_test_after_harvest',
                                'inventory_batches_expiry_after_harvest'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.inventory_batches'::regclass
                     AND conname = v_name AND contype = 'c') THEN
      v_missing := array_append(v_missing, 'CHECK ' || v_name);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: all four batch dates are of type date, and all seven constraints (four calendar bounds, three ordering rules) are present.';
END
$verify_a$;

CREATE TEMP TABLE v56_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

DO $seed$
DECLARE
  v_farm uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.farms (id, farm_name) VALUES (v_farm, 'VERIFY-56 farm');
  INSERT INTO v56_ids VALUES ('farm', v_farm);
END
$seed$;

-- -----------------------------------------------------------------------------
-- B. An ordinary batch is admitted
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_id   uuid := gen_random_uuid();
  v_farm uuid := (SELECT id FROM v56_ids WHERE name = 'farm');
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, harvest_date, cure_date, test_date, expiry_date)
  VALUES (v_id, v_farm, DATE '2026-01-10', DATE '2026-02-01', DATE '2026-02-14', DATE '2027-01-10');

  IF NOT EXISTS (SELECT 1 FROM public.inventory_batches
                 WHERE id = v_id AND harvest_date = DATE '2026-01-10') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a batch with an entirely ordinary date sequence was not stored.';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: harvest, cure, test and expiry in a sensible sequence are admitted, so the refusals below are refusals of the value.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. The Buddhist-Era year — the case this migration exists for
--
-- B.E. 2569 is 2026 CE. As a `date` it is a perfectly valid year 2569, which is
-- exactly why converting the column type alone would not have caught it.
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v56_ids WHERE name = 'farm');
  v_col      text;
  v_valid    boolean;
BEGIN
  -- The premise, asserted rather than assumed: PostgreSQL really does accept a
  -- year-2569 date without complaint, so the type is not the guard.
  BEGIN
    PERFORM DATE '2569-03-14';
    v_valid := true;
  EXCEPTION WHEN others THEN
    v_valid := false;
  END;
  IF NOT v_valid THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: this PostgreSQL rejects DATE ''2569-03-14'' on its own, so the premise '
      'behind the year bound no longer holds and the constraint should be revisited.';
  END IF;

  FOREACH v_col IN ARRAY ARRAY['harvest_date', 'cure_date', 'test_date', 'expiry_date'] LOOP
    BEGIN
      EXECUTE format(
        'INSERT INTO public.inventory_batches (id, farm_id, %I) VALUES (gen_random_uuid(), $1, DATE ''2569-03-14'')',
        v_col) USING v_farm;
      v_problems := array_append(v_problems, v_col || ' accepted the Buddhist-Era year 2569');
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: PostgreSQL accepts a year-2569 date on its own (so the type is not the guard), and all four columns refuse it. B.E. 2569 is 2026 CE.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. What the text column used to accept
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v56_ids WHERE name = 'farm');
  v_val      text;
BEGIN
  FOREACH v_val IN ARRAY ARRAY['2026-02-30',            -- February has no 30th
                               '2026-13-01',            -- no 13th month
                               'sometime in March',     -- prose
                               ''] LOOP                 -- the empty string
    BEGIN
      EXECUTE 'INSERT INTO public.inventory_batches (id, farm_id, harvest_date)
               VALUES (gen_random_uuid(), $1, $2::date)' USING v_farm, v_val;
      v_problems := array_append(v_problems, format('harvest_date accepted %L', v_val));
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow OR check_violation THEN
        NULL;
    END;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: an impossible day, an impossible month, free prose and an empty string are all refused — every one of which the text column stored happily.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Ordering
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v56_ids WHERE name = 'farm');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date, cure_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-03-01', DATE '2026-02-01');
    v_problems := array_append(v_problems, 'a cure date BEFORE the harvest date was accepted');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date, test_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-03-01', DATE '2023-05-20');
    v_problems := array_append(v_problems, 'a test date three years BEFORE the harvest was accepted');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date, expiry_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-03-01', DATE '2026-02-28');
    v_problems := array_append(v_problems, 'an expiry date BEFORE the harvest date was accepted');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    -- Expiry is strict: a shelf life of zero days is not a shelf life.
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date, expiry_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-03-01', DATE '2026-03-01');
    v_problems := array_append(v_problems, 'an expiry date EQUAL to the harvest date was accepted');
  EXCEPTION WHEN check_violation THEN NULL; END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: curing, testing or expiring before the harvest is refused, and a zero-day shelf life is refused.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. The rules are inert when a date is missing
--
-- The counterexample that stops the ordering rules being overstated. A batch
-- entered over two sittings is a data-entry state, not an error, and a
-- constraint that refuses one is a constraint somebody removes.
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v56_ids WHERE name = 'farm');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, test_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-02-14');
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'a test date with NO harvest date yet was refused');
  END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-01-10');
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'a harvest date with nothing else was refused');
  END;

  BEGIN
    -- Same-day harvest and sampling is ordinary practice; `>=` not `>`.
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date, test_date, cure_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2026-01-10', DATE '2026-01-10', DATE '2026-01-10');
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'harvesting, curing and testing on the SAME day was refused');
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: a partially-entered batch is still admitted, and same-day harvest, cure and test is allowed.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. The bound is inclusive at both ends
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v56_ids WHERE name = 'farm');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2000-01-01');
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'the year 2000 was refused — the lower bound is off by one');
  END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, expiry_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2100-12-31');
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'the year 2100 was refused — the upper bound is off by one');
  END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, harvest_date)
    VALUES (gen_random_uuid(), v_farm, DATE '1999-12-31');
    v_problems := array_append(v_problems, 'the year 1999 was ACCEPTED — the lower bound is not enforced');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, expiry_date)
    VALUES (gen_random_uuid(), v_farm, DATE '2101-01-01');
    v_problems := array_append(v_problems, 'the year 2101 was ACCEPTED — the upper bound is not enforced');
  EXCEPTION WHEN check_violation THEN NULL; END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: 2000 and 2100 are both admitted and 1999 and 2101 are both refused, so the bound is inclusive and not off by one.';
END
$verify_g$;

ROLLBACK;
