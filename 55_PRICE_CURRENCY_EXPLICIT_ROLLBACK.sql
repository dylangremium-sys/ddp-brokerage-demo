-- =============================================================================
-- 55_PRICE_CURRENCY_EXPLICIT_ROLLBACK.sql
--
-- Reverses 55_PRICE_CURRENCY_EXPLICIT_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This DROPS the price_currency columns. Any currency a user or an importer
-- recorded since migration 55 applied is DESTROYED — not hidden, not archived,
-- gone — and every remaining price silently reverts to meaning "baht, we assume".
-- On a platform that quotes to buyers abroad, that is a rollback with a data
-- loss in it, and the loss is invisible afterwards because the numbers all still
-- look like numbers.
--
-- So it refuses if any row carries a currency other than the THB the forward
-- migration backfilled, unless told:
--
--   BEGIN;
--     SET LOCAL currency.rollback_discard_non_thb = 'on';
--     \i 55_PRICE_CURRENCY_EXPLICIT_ROLLBACK.sql
--   COMMIT;
--
-- Before doing that, export what you are about to destroy:
--
--   SELECT id, price_per_kg, asking_price, price_currency
--     FROM public.inventory_batches WHERE price_currency <> 'THB';
--   SELECT id, product_type, price_min, price_max, price_currency
--     FROM public.market_price_benchmarks WHERE price_currency <> 'THB';
--
-- It also renames asking_price back to asking_price_thb and restores migration
-- 54's constraint name. Rolling back 55 while leaving the column renamed would
-- leave 54 unrollbackable — its own rollback drops a constraint by a name that
-- would no longer exist.
-- =============================================================================

BEGIN;

DO $guard$
DECLARE
  v_opt_in boolean := coalesce(
                        nullif(current_setting('currency.rollback_discard_non_thb', true), ''),
                        'off') = 'on';
  v_batches bigint := 0;
  v_bench   bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_batches'
               AND column_name='price_currency') THEN
    EXECUTE 'SELECT count(*) FROM public.inventory_batches '
            'WHERE price_currency IS NOT NULL AND price_currency <> ''THB'''
      INTO v_batches;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='market_price_benchmarks'
               AND column_name='price_currency') THEN
    EXECUTE 'SELECT count(*) FROM public.market_price_benchmarks WHERE price_currency <> ''THB'''
      INTO v_bench;
  END IF;

  IF (v_batches + v_bench) > 0 AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING to roll back migration 55: % batch row(s) and % benchmark row(s) carry a currency '
      'other than THB, and this rollback DROPS the columns holding it. Those prices would revert to '
      'meaning "baht, we assume" with nothing left to say otherwise. Export them first, then re-run '
      'inside a transaction that executes: SET LOCAL currency.rollback_discard_non_thb = ''on'';',
      v_batches, v_bench;
  END IF;
END
$guard$;

ALTER TABLE public.market_price_benchmarks
  DROP CONSTRAINT IF EXISTS market_price_benchmarks_price_currency_allowed;

ALTER TABLE public.market_price_benchmarks
  DROP COLUMN IF EXISTS price_currency;

ALTER TABLE public.inventory_batches
  DROP CONSTRAINT IF EXISTS inventory_batches_price_requires_currency,
  DROP CONSTRAINT IF EXISTS inventory_batches_price_currency_allowed;

ALTER TABLE public.inventory_batches
  DROP COLUMN IF EXISTS price_currency;

-- Restore migration 54's constraint name BEFORE renaming the column back, so
-- that at no point does a constraint named for one column sit on another.
ALTER TABLE public.inventory_batches
  RENAME CONSTRAINT inventory_batches_asking_price_sane
                 TO inventory_batches_asking_price_thb_sane;

ALTER TABLE public.inventory_batches
  RENAME COLUMN asking_price TO asking_price_thb;

-- Postcondition. A `DROP ... IF EXISTS` that matched nothing because a name was
-- misspelled is indistinguishable from success, and the rollback-symmetry gate
-- compares catalogues rather than reading intent.
DO $postcondition$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_batches'
               AND column_name='price_currency') THEN
    v_problems := array_append(v_problems, 'inventory_batches.price_currency still present');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='market_price_benchmarks'
               AND column_name='price_currency') THEN
    v_problems := array_append(v_problems, 'market_price_benchmarks.price_currency still present');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches'
                   AND column_name='asking_price_thb') THEN
    v_problems := array_append(v_problems, 'inventory_batches.asking_price_thb was not restored');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.inventory_batches'::regclass
                   AND conname = 'inventory_batches_asking_price_thb_sane') THEN
    v_problems := array_append(v_problems,
      'migration 54''s constraint inventory_batches_asking_price_thb_sane was not restored, '
      'which would leave migration 54 unrollbackable');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 55 INCOMPLETE: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'ROLLBACK 55: both price_currency columns dropped, asking_price renamed back, migration 54''s constraint name restored.';
END
$postcondition$;

COMMIT;
