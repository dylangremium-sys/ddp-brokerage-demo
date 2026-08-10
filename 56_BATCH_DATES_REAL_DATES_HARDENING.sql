-- =============================================================================
-- 56_BATCH_DATES_REAL_DATES_HARDENING.sql
--
-- Converts the four batch dates from text to `date`, refuses a Buddhist-Era
-- year, and asserts the events happened in a possible order (defect D13).
--
-- Depends on nothing. Independent of migrations 54 and 55, which touch the same
-- table but no column this one reads.
--
-- WHAT IS WRONG TODAY
-- `inventory_batches.harvest_date`, `cure_date`, `test_date` and `expiry_date`
-- are all `text` on production (measured read-only 2026-08-04). The database
-- therefore cannot tell that '2026-13-45' is not a date, that a batch was tested
-- three years before it was harvested, or — the one that matters here — that
-- '2569-03-14' is a Thai Buddhist-Era year and not a Common-Era one.
--
-- THE 543-YEAR PROBLEM, AND WHY A DATE TYPE ALONE DOES NOT SOLVE IT
-- Thai lab reports, FDA filings and permits are dated in the Buddhist Era; B.E.
-- 2569 is 2026 CE. `src/lib/thaiCalendar.ts` already carries that rule for the
-- client and says why it matters: a 543-year error on a document date either
-- ships a consignment against a lapsed permit or holds a valid one at the port.
--
-- Converting to `date` does NOT catch it. PostgreSQL accepts '2569-03-14' as a
-- perfectly valid date in the year 2569 and stores it without complaint. What
-- catches it is a bound on the year: a Buddhist-Era year for any real harvest is
-- around 2560-2580, and a Common-Era year for any real harvest is around
-- 2020-2030. The two ranges do not overlap and will not this century, so
-- requiring 2000..2100 rejects a BE date at INSERT rather than leaving it to be
-- discovered downstream. (A BE year that DID land inside 2000..2100 would be CE
-- 1457..1557 — not a date anyone is entering.)
--
-- WHY THIS DOES NOT STORE THE BE YEAR THE WAY MIGRATION 40 DOES
-- Migration 40 stores `issued_on_be_year` next to `issued_on` and CHECKs the 543
-- offset. That is right THERE because a permit is transcribed from a Thai
-- document which STATES a BE year — the BE year is source data, and storing it
-- lets the database catch a transcription error rather than silently preferring
-- one calendar.
--
-- A harvest date is not transcribed from anything; it is a farm event. Storing a
-- BE year beside it would be inventing a field nobody wrote down, and a CHECK
-- asserting two columns agree is only meaningful when both were independently
-- recorded. `test_date` is the arguable case — it does come off a laboratory
-- report — and it is deliberately left out of the dual-calendar treatment until
-- there is a COA intake path that captures what the report actually said. That
-- path is migrations 52/53's territory, not this one's.
--
-- ORDERING: THREE RULES, AND THE ONES DELIBERATELY NOT WRITTEN
-- A batch cannot be cured, tested or expire before it was harvested. Those three
-- hold universally, and each applies only when both dates are present — a rule
-- that fired on a NULL would refuse a half-entered batch, which is a data-entry
-- state, not an error.
--
-- NOT written: `cure_date <= test_date` (a sample can be tested mid-cure) and
-- `test_date <= expiry_date` (a re-test after nominal expiry is a real thing).
-- Neither is universally true, and a constraint that is usually true is worse
-- than none: it gets dropped the first time it blocks legitimate work.
--
-- ALSO NOT CAUGHT: a harvest date in the FUTURE. A CHECK constraint must be
-- IMMUTABLE, so it cannot call `current_date`. Catching that needs a trigger,
-- which is a different migration with a different failure mode. The year bound
-- catches the absurd cases; a harvest dated next Tuesday still gets through.
--
-- PRODUCTION BLAST RADIUS AND THE ROUND TRIP
-- Production holds ONE inventory_batches row. The precondition refuses unless
-- every existing value is either NULL/blank or a strict `YYYY-MM-DD` string that
-- parses, sits inside the year bound, and satisfies the ordering rules — naming
-- every offender rather than stopping at the first.
--
-- Requiring STRICT ISO is what makes the rollback lossless. '2026-1-5' would
-- convert forward to 2026-01-05 and roll back to '2026-01-05', which is not the
-- text it started as. By refusing anything but `YYYY-MM-DD` going in, the
-- text -> date -> text round trip is exact.
--
--   • Rollback: 56_BATCH_DATES_REAL_DATES_ROLLBACK.sql
--   • Verify:   56_BATCH_DATES_REAL_DATES_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_col      text;
  v_n        bigint;
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL THEN
    RAISE EXCEPTION 'Migration 56 requires public.inventory_batches, which does not exist.';
  END IF;

  FOREACH v_col IN ARRAY ARRAY['harvest_date', 'cure_date', 'test_date', 'expiry_date'] LOOP
    -- The column must exist AND still be text. Running this twice must not
    -- silently "succeed" against columns another run already converted.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                     AND column_name = v_col AND data_type = 'text') THEN
      v_problems := array_append(v_problems,
        format('inventory_batches.%s is absent or is not text', v_col));
      CONTINUE;
    END IF;

    -- Not strict YYYY-MM-DD. Checked with a regex BEFORE any cast, because
    -- PostgreSQL's date input is lenient enough to accept '2026-1-5' and
    -- '20260105' and would hide exactly the values that break the round trip.
    EXECUTE format(
      'SELECT count(*) FROM public.inventory_batches
        WHERE %1$I IS NOT NULL AND btrim(%1$I) <> ''''
          AND btrim(%1$I) !~ ''^\d{4}-\d{2}-\d{2}$''', v_col) INTO v_n;
    IF v_n > 0 THEN
      v_problems := array_append(v_problems,
        format('%s row(s) where %s is not a strict YYYY-MM-DD string', v_n, v_col));
      CONTINUE;  -- a later cast on these would raise, not report
    END IF;

    -- Well-formed but not a real calendar date (2026-02-30, 2026-13-01).
    EXECUTE format(
      'SELECT count(*) FROM public.inventory_batches
        WHERE %1$I IS NOT NULL AND btrim(%1$I) <> ''''
          AND NOT (btrim(%1$I) ~ ''^\d{4}-\d{2}-\d{2}$''
                   AND to_char(to_date(btrim(%1$I), ''YYYY-MM-DD''), ''YYYY-MM-DD'')
                       = btrim(%1$I))', v_col) INTO v_n;
    IF v_n > 0 THEN
      v_problems := array_append(v_problems,
        format('%s row(s) where %s is not a real calendar date', v_n, v_col));
      CONTINUE;
    END IF;

    -- Outside the plausible Common-Era range — which is how a Buddhist-Era year
    -- presents.
    EXECUTE format(
      'SELECT count(*) FROM public.inventory_batches
        WHERE %1$I IS NOT NULL AND btrim(%1$I) <> ''''
          AND date_part(''year'', to_date(btrim(%1$I), ''YYYY-MM-DD'')) NOT BETWEEN 2000 AND 2100',
      v_col) INTO v_n;
    IF v_n > 0 THEN
      v_problems := array_append(v_problems,
        format('%s row(s) where %s has a year outside 2000..2100 — likely a Buddhist-Era date '
               '(subtract 543) or a typo', v_n, v_col));
    END IF;
  END LOOP;

  -- Ordering, only if every column above is clean enough to compare.
  IF array_length(v_problems, 1) IS NULL THEN
    SELECT count(*) INTO v_n FROM public.inventory_batches
     WHERE nullif(btrim(harvest_date), '') IS NOT NULL
       AND ((nullif(btrim(cure_date),   '') IS NOT NULL AND btrim(cure_date)   < btrim(harvest_date))
         OR (nullif(btrim(test_date),   '') IS NOT NULL AND btrim(test_date)   < btrim(harvest_date))
         OR (nullif(btrim(expiry_date), '') IS NOT NULL AND btrim(expiry_date) <= btrim(harvest_date)));
    IF v_n > 0 THEN
      v_problems := array_append(v_problems,
        format('%s row(s) where a cure, test or expiry date is not after the harvest date', v_n));
    END IF;
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION
      'REFUSING: existing inventory_batches rows cannot be converted — %. Correct the data first. '
      'Converting anyway would mean either dropping values or storing a date this migration exists '
      'to reject.', array_to_string(v_problems, '; ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. text -> date
--
-- `nullif(btrim(...), '')` because an empty string is not a date and must become
-- NULL rather than raise. The precondition has already proved every remaining
-- value is strict ISO, so the cast cannot fail here.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ALTER COLUMN harvest_date TYPE date USING nullif(btrim(harvest_date), '')::date,
  ALTER COLUMN cure_date    TYPE date USING nullif(btrim(cure_date),    '')::date,
  ALTER COLUMN test_date    TYPE date USING nullif(btrim(test_date),    '')::date,
  ALTER COLUMN expiry_date  TYPE date USING nullif(btrim(expiry_date),  '')::date;

-- -----------------------------------------------------------------------------
-- 2. The calendar bound
--
-- This is the Buddhist-Era guard. It is expressed as a year range rather than as
-- "not BE" because there is no way to ask a date which calendar it was written
-- in — only whether it lands where a Common-Era date of this kind could land.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_harvest_date_ce_year
    CHECK (harvest_date IS NULL
           OR date_part('year', harvest_date) BETWEEN 2000 AND 2100),

  ADD CONSTRAINT inventory_batches_cure_date_ce_year
    CHECK (cure_date IS NULL
           OR date_part('year', cure_date) BETWEEN 2000 AND 2100),

  ADD CONSTRAINT inventory_batches_test_date_ce_year
    CHECK (test_date IS NULL
           OR date_part('year', test_date) BETWEEN 2000 AND 2100),

  ADD CONSTRAINT inventory_batches_expiry_date_ce_year
    CHECK (expiry_date IS NULL
           OR date_part('year', expiry_date) BETWEEN 2000 AND 2100);

-- -----------------------------------------------------------------------------
-- 3. Ordering
--
-- Each rule is inert unless BOTH dates are present. A half-entered batch is a
-- data-entry state, not an error, and a constraint that refuses one is a
-- constraint somebody removes.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_cure_after_harvest
    CHECK (harvest_date IS NULL OR cure_date IS NULL OR cure_date >= harvest_date),

  -- The rule the plan asks for by name: a batch cannot be tested before it was
  -- harvested. `>=` rather than `>` because same-day harvest and sampling is
  -- ordinary practice.
  ADD CONSTRAINT inventory_batches_test_after_harvest
    CHECK (harvest_date IS NULL OR test_date IS NULL OR test_date >= harvest_date),

  -- Strict here: a shelf life of zero days is not a shelf life.
  ADD CONSTRAINT inventory_batches_expiry_after_harvest
    CHECK (harvest_date IS NULL OR expiry_date IS NULL OR expiry_date > harvest_date);

COMMENT ON COLUMN public.inventory_batches.harvest_date IS
  'Common Era. Converted from text by migration 56. A Buddhist-Era year (B.E. 2569 '
  '= 2026 CE) is rejected by the 2000..2100 year bound, not by detecting the calendar '
  '— a date cannot say which calendar it was written in. See src/lib/thaiCalendar.ts.';

COMMIT;
