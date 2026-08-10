-- =============================================================================
-- Migration 54 — VERIFY: inventory_batches value constraints
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure: ten CHECK constraints and the partial unique index exist
--   B — a valid batch is still admitted, so every refusal below is a refusal
--       of the value and not an artefact of a broken fixture
--   C — negative quantity, price and percentage are refused
--   D — NaN is refused on every numeric column — the case a lower bound alone
--       admits, because NaN sorts above every real number
--   E — Infinity and -Infinity are refused
--   F — an out-of-range percentage and a water activity entered as a percentage
--       rather than a fraction are refused
--   G — duplicate batch numbers within a farm are refused, exactly, by case,
--       and by surrounding whitespace; the SAME number on a DIFFERENT farm is
--       admitted; a blank batch number is refused; and NULL batch numbers do
--       not collide with one another
--   H — the row migration 44's VERIFY section G creates can no longer exist
--
-- Expected on success: eight PASSED notices and no exception.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. Structure
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['inventory_batches_quantity_kg_sane',
                           'inventory_batches_minimum_order_kg_sane',
                           'inventory_batches_price_per_kg_sane',
                           'inventory_batches_asking_price_thb_sane',
                           'inventory_batches_thc_percent_range',
                           'inventory_batches_cbd_percent_range',
                           'inventory_batches_moisture_percent_range',
                           'inventory_batches_total_terpenes_pct_range',
                           'inventory_batches_water_activity_range',
                           'inventory_batches_batch_number_not_blank'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.inventory_batches'::regclass
                     AND conname = c AND contype = 'c') THEN
      v_missing := array_append(v_missing, 'CHECK ' || c);
    END IF;
  END LOOP;

  IF to_regclass('public.inventory_batches_farm_batch_number_key') IS NULL THEN
    v_missing := array_append(v_missing, 'index inventory_batches_farm_batch_number_key');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: ten CHECK constraints and the per-farm batch-number unique index are present.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- Fixture farms. Two, because section G has to show that the same batch number
-- on a DIFFERENT farm is fine — a uniqueness rule that rejected that would be
-- wrong in a way a single-farm test cannot see.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE v54_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

DO $seed$
DECLARE
  v_farm_a uuid := gen_random_uuid();
  v_farm_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.farms (id, farm_name) VALUES
    (v_farm_a, 'VERIFY-54 farm A'), (v_farm_b, 'VERIFY-54 farm B');
  INSERT INTO v54_ids VALUES ('farm_a', v_farm_a), ('farm_b', v_farm_b);
END
$seed$;

-- -----------------------------------------------------------------------------
-- B. A valid batch is still admitted
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.inventory_batches
    (id, farm_id, batch_number, quantity_kg, minimum_order_kg, price_per_kg,
     asking_price_thb, thc_percent, cbd_percent, moisture_percent,
     total_terpenes_pct, water_activity)
  VALUES (v_id, (SELECT id FROM v54_ids WHERE name = 'farm_a'), 'TH-2026-VALID',
          250, 10, 1200, 300000, 18.4, 0.7, 11.2, 2.3, 0.58);

  IF NOT EXISTS (SELECT 1 FROM public.inventory_batches WHERE id = v_id) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a batch with entirely ordinary values was not stored.';
  END IF;
  INSERT INTO v54_ids VALUES ('valid_batch', v_id);

  RAISE NOTICE 'VERIFY B PASSED: an ordinary batch is admitted, so the refusals below are refusals of the value.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. Negatives
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_a');
  v_col      text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['quantity_kg', 'minimum_order_kg', 'price_per_kg',
                               'asking_price_thb', 'thc_percent', 'cbd_percent',
                               'moisture_percent', 'total_terpenes_pct', 'water_activity'] LOOP
    BEGIN
      EXECUTE format(
        'INSERT INTO public.inventory_batches (id, farm_id, %I) VALUES (gen_random_uuid(), $1, -1)',
        v_col) USING v_farm;
      v_problems := array_append(v_problems, v_col || ' accepted -1');
    EXCEPTION WHEN check_violation THEN
      NULL;  -- refused, which is the point
    END;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a negative value is refused on all nine bounded numeric columns.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. NaN — the value a lower bound alone admits
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_a');
  v_col      text;
  v_sorts_high boolean;
BEGIN
  -- The premise, asserted rather than assumed: NaN really does sort above every
  -- real number, which is why `CHECK (x >= 0)` would not have caught it.
  SELECT 'NaN'::numeric >= 0 INTO v_sorts_high;
  IF NOT v_sorts_high THEN
    RAISE EXCEPTION
      'VERIFY D FAILED: this PostgreSQL does not sort NaN above zero, so the premise of these '
      'two-sided bounds no longer holds and they should be revisited.';
  END IF;

  FOREACH v_col IN ARRAY ARRAY['quantity_kg', 'minimum_order_kg', 'price_per_kg',
                               'asking_price_thb', 'thc_percent', 'cbd_percent',
                               'moisture_percent', 'total_terpenes_pct', 'water_activity'] LOOP
    BEGIN
      EXECUTE format(
        'INSERT INTO public.inventory_batches (id, farm_id, %I) '
        'VALUES (gen_random_uuid(), $1, ''NaN''::numeric)', v_col) USING v_farm;
      v_problems := array_append(v_problems, v_col || ' accepted NaN');
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: NaN sorts above zero on this server AND is refused on all nine bounded numeric columns.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. Infinity, both signs
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_a');
  v_col      text;
  v_val      text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['quantity_kg', 'price_per_kg', 'thc_percent', 'water_activity'] LOOP
    FOREACH v_val IN ARRAY ARRAY['Infinity', '-Infinity'] LOOP
      BEGIN
        EXECUTE format(
          'INSERT INTO public.inventory_batches (id, farm_id, %I) VALUES (gen_random_uuid(), $1, $2::numeric)',
          v_col) USING v_farm, v_val;
        v_problems := array_append(v_problems, v_col || ' accepted ' || v_val);
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
    END LOOP;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY E FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: Infinity and -Infinity are both refused.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. Ranges: a percentage over 100, and a water activity given as a percentage
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_a');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, thc_percent)
    VALUES (gen_random_uuid(), v_farm, 4000);
    v_problems := array_append(v_problems, 'thc_percent accepted 4000');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    -- 0.65 is an ordinary reading; 65 is the same reading with the wrong unit,
    -- and is not detectably wrong to a human skimming a form.
    INSERT INTO public.inventory_batches (id, farm_id, water_activity)
    VALUES (gen_random_uuid(), v_farm, 65);
    v_problems := array_append(v_problems, 'water_activity accepted 65 (a percentage in a 0..1 field)');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, quantity_kg)
    VALUES (gen_random_uuid(), v_farm, 10000001);
    v_problems := array_append(v_problems, 'quantity_kg accepted a value above the ceiling');
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- The boundary itself must be admissible, or the ceiling is off by one.
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, water_activity, thc_percent)
    VALUES (gen_random_uuid(), v_farm, 1, 100);
  EXCEPTION WHEN check_violation THEN
    v_problems := array_append(v_problems, 'the inclusive upper bound (water_activity 1, thc_percent 100) was REFUSED');
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY F FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: out-of-range percentages and a mis-united water activity are refused, and the inclusive upper bound is admitted.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. Batch number identity
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm_a   uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_a');
  v_farm_b   uuid   := (SELECT id FROM v54_ids WHERE name = 'farm_b');
  v_variant  text;
BEGIN
  -- 'TH-2026-VALID' already exists on farm A from section B. Each of these is
  -- the same batch to a human.
  FOREACH v_variant IN ARRAY ARRAY['TH-2026-VALID', 'th-2026-valid', '  TH-2026-VALID  '] LOOP
    BEGIN
      INSERT INTO public.inventory_batches (id, farm_id, batch_number)
      VALUES (gen_random_uuid(), v_farm_a, v_variant);
      v_problems := array_append(v_problems,
        format('farm A accepted a duplicate batch number %L', v_variant));
    EXCEPTION WHEN unique_violation THEN NULL; END;
  END LOOP;

  -- The same number on a different farm is a different batch.
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, batch_number)
    VALUES (gen_random_uuid(), v_farm_b, 'TH-2026-VALID');
  EXCEPTION WHEN unique_violation THEN
    v_problems := array_append(v_problems,
      'the same batch number on a DIFFERENT farm was refused — uniqueness is not per-farm');
  END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, batch_number)
    VALUES (gen_random_uuid(), v_farm_a, '   ');
    v_problems := array_append(v_problems, 'a blank batch number was accepted');
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Two rows with no batch number identify no batch and must not collide.
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, batch_number)
    VALUES (gen_random_uuid(), v_farm_a, NULL), (gen_random_uuid(), v_farm_a, NULL);
  EXCEPTION WHEN unique_violation THEN
    v_problems := array_append(v_problems,
      'two batches with a NULL batch_number collided — the index is not partial');
  END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY G FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: duplicate batch numbers within a farm are refused by exact match, by case and by whitespace; the same number on another farm is admitted; a blank is refused; NULLs do not collide.';
END
$verify_g$;

-- -----------------------------------------------------------------------------
-- H. The row migration 44's VERIFY section G creates can no longer exist
--
-- 44 G inserts a NaN-quantity batch to prove the reservation ledger reports zero
-- availability rather than infinite stock. That function-level guard is
-- untouched and still correct. This section asserts the guarantee has ALSO
-- moved one layer down — the scenario is now unconstructible — and is the
-- reason 44 G is expected to fail against a database with 54 applied.
-- -----------------------------------------------------------------------------
DO $verify_h$
DECLARE
  v_farm uuid := (SELECT id FROM v54_ids WHERE name = 'farm_a');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, quantity_kg, client_visible)
    VALUES (gen_random_uuid(), v_farm, 'NaN'::numeric, true);
    RAISE EXCEPTION
      'VERIFY H FAILED: migration 44 VERIFY section G''s NaN-quantity batch was still admitted. '
      'The constraint is not covering the case it was written for.';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'VERIFY H PASSED: the NaN-quantity batch migration 44 VERIFY section G creates is now refused by the database. 44 G failing against a database with 54 applied is this migration working, not 44 breaking.';
END
$verify_h$;

ROLLBACK;
