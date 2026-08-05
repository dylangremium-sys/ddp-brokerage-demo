-- =============================================================================
-- 54_INVENTORY_BATCH_VALUE_CONSTRAINTS_HARDENING.sql
--
-- Bounds every numeric on public.inventory_batches and makes a batch number
-- unique within its farm (defect D14).
--
-- WHAT IS WRONG TODAY
-- `inventory_batches` is the table the whole commercial spine hangs off — the
-- reservation ledger reads its quantity, the buyer pack quotes its price, the
-- export gate reads its test results. Measured against production read-only on
-- 2026-08-04, it carries FOUR constraints: one primary key and three foreign
-- keys. Zero CHECK. Zero UNIQUE.
--
-- So today a batch may hold a negative quantity, a negative price, a THC
-- percentage of 4000, a water activity of -12, NaN, Infinity, or the same batch
-- number as another batch on the same farm. Nothing in the database says
-- otherwise. The TypeScript layer says otherwise, which is a different claim:
-- it protects the paths that go through it and says nothing about the RPCs, the
-- SQL editor, a future importer, or a bug.
--
-- WHY BOTH ENDS OF EVERY RANGE
-- `CHECK (quantity_kg >= 0)` looks like it bounds the column and does not.
-- PostgreSQL sorts numeric NaN ABOVE every real number, so `NaN >= 0` is TRUE
-- and a lower bound alone admits it. Infinity likewise. Every rule below is
-- therefore closed at both ends, and additionally names NaN explicitly.
--
-- The explicit `<> 'NaN'::numeric` is redundant while the upper bound stands.
-- It is written anyway because the upper bound is a business number somebody
-- will eventually raise, and raising it must not quietly re-admit NaN. Note
-- that `'NaN'::numeric = 'NaN'::numeric` is TRUE in PostgreSQL, so `<>` is the
-- correct test here and IS NOT DISTINCT FROM would be wrong.
--
-- WHY THE UNIQUENESS IS CASE-INSENSITIVE AND TRIMMED
-- A batch number is an identifier a human types, twice, on two different days.
-- 'TH-2026-014', 'th-2026-014' and 'TH-2026-014 ' are the same batch to
-- everybody except a byte comparison. Enforcing exact-match uniqueness would
-- leave the duplicate this constraint exists to prevent one keystroke away.
--
-- It is a partial index: production allows both farm_id and batch_number to be
-- NULL, and rows that identify no batch on no farm must not collide with each
-- other. A blank batch number is refused outright rather than treated as absent
-- — '' is a value somebody typed, and it would otherwise become a licence for
-- unlimited unnamed batches.
--
-- WHAT THIS BREAKS, STATED PLAINLY
-- Migration 44's VERIFY section G deliberately INSERTS a batch with
-- `'NaN'::numeric` quantity, to prove the reservation ledger treats it as zero
-- availability rather than infinite stock. After this migration, that INSERT is
-- REFUSED by the database and 44's section G will FAIL if re-run.
--
-- That is not a regression. 44's guard is a function-level defence that stays
-- exactly as it was, and section H of THIS migration's VERIFY re-proves the same
-- property one layer down: the row 44 G used to create can no longer exist. The
-- guarantee moves from "the ledger copes with a NaN batch" to "there is no NaN
-- batch". An operator re-running the full VERIFY suite against a database with
-- 54 applied should expect 44 G to fail and should read it as this migration
-- working, not as 44 breaking.
--
-- PRODUCTION BLAST RADIUS
-- Production holds ONE inventory_batches row (n_live_tup, measured read-only
-- 2026-08-04). The precondition below refuses rather than silently skipping if
-- any existing row would violate any of these rules, and names every offender.
--
--   • Rollback: 54_INVENTORY_BATCH_VALUE_CONSTRAINTS_ROLLBACK.sql
--   • Verify:   54_INVENTORY_BATCH_VALUE_CONSTRAINTS_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_n        bigint;
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL THEN
    RAISE EXCEPTION
      'Migration 54 requires public.inventory_batches, which does not exist.';
  END IF;

  -- Every column this migration constrains must be present. A missing column
  -- would make the corresponding CHECK match nothing and pass vacuously.
  SELECT count(*) INTO v_n
  FROM unnest(ARRAY['quantity_kg', 'minimum_order_kg', 'price_per_kg', 'asking_price_thb',
                    'thc_percent', 'cbd_percent', 'moisture_percent', 'total_terpenes_pct',
                    'water_activity', 'batch_number', 'farm_id']) AS c(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_batches'
      AND column_name = c.name);

  IF v_n > 0 THEN
    RAISE EXCEPTION
      'Migration 54 requires % column(s) of public.inventory_batches that are absent. Applying it '
      'against a partial table would add constraints that match nothing and report success.', v_n;
  END IF;

  -- Existing rows. Reported all at once: fixing them one refusal at a time is
  -- how a migration gets abandoned half-applied.
  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE quantity_kg IS NOT NULL
     AND (quantity_kg = 'NaN'::numeric OR quantity_kg < 0 OR quantity_kg > 10000000);
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with an out-of-range quantity_kg'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE minimum_order_kg IS NOT NULL
     AND (minimum_order_kg = 'NaN'::numeric OR minimum_order_kg < 0 OR minimum_order_kg > 10000000);
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with an out-of-range minimum_order_kg'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE price_per_kg IS NOT NULL
     AND (price_per_kg = 'NaN'::numeric OR price_per_kg < 0 OR price_per_kg > 100000000);
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with an out-of-range price_per_kg'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE asking_price_thb IS NOT NULL
     AND (asking_price_thb = 'NaN'::numeric OR asking_price_thb < 0 OR asking_price_thb > 100000000);
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with an out-of-range asking_price_thb'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE (thc_percent        IS NOT NULL AND (thc_percent        = 'NaN'::numeric OR thc_percent        < 0 OR thc_percent        > 100))
      OR (cbd_percent        IS NOT NULL AND (cbd_percent        = 'NaN'::numeric OR cbd_percent        < 0 OR cbd_percent        > 100))
      OR (moisture_percent   IS NOT NULL AND (moisture_percent   = 'NaN'::numeric OR moisture_percent   < 0 OR moisture_percent   > 100))
      OR (total_terpenes_pct IS NOT NULL AND (total_terpenes_pct = 'NaN'::numeric OR total_terpenes_pct < 0 OR total_terpenes_pct > 100));
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with a percentage outside 0..100'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE water_activity IS NOT NULL
     AND (water_activity = 'NaN'::numeric OR water_activity < 0 OR water_activity > 1);
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with water_activity outside 0..1'); END IF;

  SELECT count(*) INTO v_n FROM public.inventory_batches
   WHERE batch_number IS NOT NULL AND btrim(batch_number) = '';
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' row(s) with a blank batch_number'); END IF;

  SELECT coalesce(sum(c - 1), 0) INTO v_n FROM (
    SELECT count(*) AS c FROM public.inventory_batches
     WHERE farm_id IS NOT NULL AND batch_number IS NOT NULL AND btrim(batch_number) <> ''
     GROUP BY farm_id, lower(btrim(batch_number)) HAVING count(*) > 1) d;
  IF v_n > 0 THEN v_problems := array_append(v_problems, v_n || ' duplicate batch number(s) within a farm'); END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION
      'REFUSING: existing inventory_batches rows violate the constraints migration 54 adds — %. '
      'Correct the data first. Applying anyway is not possible without dropping the guarantee this '
      'migration exists to create.', array_to_string(v_problems, '; ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Quantities and prices
--
-- Ceilings are deliberately generous — they exist to exclude the impossible,
-- not to encode commercial policy. 10,000 tonnes of dried flower and a hundred
-- million per kilogram are both far outside any real consignment while still
-- catching a misplaced decimal, a unit confusion, an overflow, NaN and Infinity.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_quantity_kg_sane
    CHECK (quantity_kg IS NULL
           OR (quantity_kg <> 'NaN'::numeric AND quantity_kg >= 0 AND quantity_kg <= 10000000)),

  ADD CONSTRAINT inventory_batches_minimum_order_kg_sane
    CHECK (minimum_order_kg IS NULL
           OR (minimum_order_kg <> 'NaN'::numeric AND minimum_order_kg >= 0 AND minimum_order_kg <= 10000000)),

  ADD CONSTRAINT inventory_batches_price_per_kg_sane
    CHECK (price_per_kg IS NULL
           OR (price_per_kg <> 'NaN'::numeric AND price_per_kg >= 0 AND price_per_kg <= 100000000)),

  -- asking_price_thb is production drift: it exists on the live table and is
  -- written by no code in this repository, on any branch. It is bounded anyway.
  -- A column nothing writes today is a column something writes tomorrow, and an
  -- unconstrained money column is worth constraining before that happens, not
  -- after.
  ADD CONSTRAINT inventory_batches_asking_price_thb_sane
    CHECK (asking_price_thb IS NULL
           OR (asking_price_thb <> 'NaN'::numeric AND asking_price_thb >= 0 AND asking_price_thb <= 100000000));

-- -----------------------------------------------------------------------------
-- 2. Laboratory results
--
-- Percentages are 0..100. Water activity is a ratio of vapour pressures and is
-- 0..1 by definition — a value of 65 is somebody entering a percentage into a
-- field that wants a fraction, which is exactly the confusion worth catching,
-- because 0.65 is a normal reading and 65 is not detectably wrong to a reader
-- skimming a form.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_thc_percent_range
    CHECK (thc_percent IS NULL
           OR (thc_percent <> 'NaN'::numeric AND thc_percent >= 0 AND thc_percent <= 100)),

  ADD CONSTRAINT inventory_batches_cbd_percent_range
    CHECK (cbd_percent IS NULL
           OR (cbd_percent <> 'NaN'::numeric AND cbd_percent >= 0 AND cbd_percent <= 100)),

  ADD CONSTRAINT inventory_batches_moisture_percent_range
    CHECK (moisture_percent IS NULL
           OR (moisture_percent <> 'NaN'::numeric AND moisture_percent >= 0 AND moisture_percent <= 100)),

  ADD CONSTRAINT inventory_batches_total_terpenes_pct_range
    CHECK (total_terpenes_pct IS NULL
           OR (total_terpenes_pct <> 'NaN'::numeric AND total_terpenes_pct >= 0 AND total_terpenes_pct <= 100)),

  ADD CONSTRAINT inventory_batches_water_activity_range
    CHECK (water_activity IS NULL
           OR (water_activity <> 'NaN'::numeric AND water_activity >= 0 AND water_activity <= 1));

-- -----------------------------------------------------------------------------
-- 3. Batch number identity
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_batch_number_not_blank
    CHECK (batch_number IS NULL OR btrim(batch_number) <> '');

-- Unique per farm, case-insensitively, ignoring surrounding whitespace. Partial
-- because a row with no farm or no batch number identifies no batch and must
-- not collide with the next such row.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_batches_farm_batch_number_key
  ON public.inventory_batches (farm_id, lower(btrim(batch_number)))
  WHERE farm_id IS NOT NULL AND batch_number IS NOT NULL AND btrim(batch_number) <> '';

COMMIT;
