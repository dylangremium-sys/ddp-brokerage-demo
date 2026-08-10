-- =============================================================================
-- 56_BATCH_DATES_REAL_DATES_ROLLBACK.sql
--
-- Reverses 56_BATCH_DATES_REAL_DATES_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This returns four date columns to `text`, which means the database stops being
-- able to tell a Buddhist-Era year from a Common-Era one, stops rejecting
-- 2026-02-30, and stops noticing that a batch was tested before it was
-- harvested. As with migrations 43 and 54, nothing about the resulting state
-- looks wrong: the values still render identically, and every check that used to
-- refuse simply stops running.
--
-- THE ROUND TRIP IS EXACT, AND THAT IS NOT AN ACCIDENT
-- The forward migration refuses anything but a strict `YYYY-MM-DD` string, so
-- every value it converted came from that shape and returns to it. `to_char(d,
-- 'YYYY-MM-DD')` reproduces the original text byte for byte. NULL stays NULL —
-- note that a value which was an EMPTY STRING before the forward migration comes
-- back as NULL, because the forward step read '' as "no date". That is the one
-- asymmetry, it is deliberate, and it loses nothing: '' was never a date.
--
-- If you are rolling back because a legitimate date is being refused, the fix is
-- almost always to widen the single offending bound rather than to drop all
-- seven constraints and the type:
--
--   ALTER TABLE public.inventory_batches
--     DROP CONSTRAINT inventory_batches_harvest_date_ce_year,
--     ADD  CONSTRAINT inventory_batches_harvest_date_ce_year
--       CHECK (harvest_date IS NULL
--              OR date_part('year', harvest_date) BETWEEN 2000 AND <new bound>);
--
-- Do not raise the upper bound past about 2400 while doing so. Above that it
-- starts admitting Buddhist-Era years, which is the failure this constraint
-- exists to prevent and the one that looks like an ordinary number.
-- =============================================================================

BEGIN;

ALTER TABLE public.inventory_batches
  DROP CONSTRAINT IF EXISTS inventory_batches_expiry_after_harvest,
  DROP CONSTRAINT IF EXISTS inventory_batches_test_after_harvest,
  DROP CONSTRAINT IF EXISTS inventory_batches_cure_after_harvest,
  DROP CONSTRAINT IF EXISTS inventory_batches_expiry_date_ce_year,
  DROP CONSTRAINT IF EXISTS inventory_batches_test_date_ce_year,
  DROP CONSTRAINT IF EXISTS inventory_batches_cure_date_ce_year,
  DROP CONSTRAINT IF EXISTS inventory_batches_harvest_date_ce_year;

ALTER TABLE public.inventory_batches
  ALTER COLUMN harvest_date TYPE text USING to_char(harvest_date, 'YYYY-MM-DD'),
  ALTER COLUMN cure_date    TYPE text USING to_char(cure_date,    'YYYY-MM-DD'),
  ALTER COLUMN test_date    TYPE text USING to_char(test_date,    'YYYY-MM-DD'),
  ALTER COLUMN expiry_date  TYPE text USING to_char(expiry_date,  'YYYY-MM-DD');

COMMENT ON COLUMN public.inventory_batches.harvest_date IS NULL;

-- Postcondition. Only 6 of this repository's rollback files assert they removed
-- what they claim to; the rest trust the DROPs. A `DROP ... IF EXISTS` that
-- matched nothing because a name was misspelled is indistinguishable from
-- success, and the rollback-symmetry gate compares catalogues rather than
-- reading intent.
DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_col      text;
  v_left     text[];
BEGIN
  FOREACH v_col IN ARRAY ARRAY['harvest_date', 'cure_date', 'test_date', 'expiry_date'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                     AND column_name = v_col AND data_type = 'text') THEN
      v_problems := array_append(v_problems,
        format('inventory_batches.%s is not back to text', v_col));
    END IF;
  END LOOP;

  SELECT coalesce(array_agg(conname ORDER BY conname), ARRAY[]::text[]) INTO v_left
  FROM pg_constraint
  WHERE conrelid = 'public.inventory_batches'::regclass
    AND conname IN ('inventory_batches_harvest_date_ce_year',
                    'inventory_batches_cure_date_ce_year',
                    'inventory_batches_test_date_ce_year',
                    'inventory_batches_expiry_date_ce_year',
                    'inventory_batches_cure_after_harvest',
                    'inventory_batches_test_after_harvest',
                    'inventory_batches_expiry_after_harvest');
  IF array_length(v_left, 1) > 0 THEN
    v_problems := array_append(v_problems,
      'constraint(s) still present: ' || array_to_string(v_left, ', '));
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 56 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'ROLLBACK 56: four date columns returned to text, seven constraints removed.';
END
$postcondition$;

COMMIT;
