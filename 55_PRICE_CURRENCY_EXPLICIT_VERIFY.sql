-- =============================================================================
-- Migration 55 — VERIFY: every price carries an explicit currency
--
-- NOT READ-ONLY. Inserts fixtures; wrapped in BEGIN … ROLLBACK.
--
-- Sections:
--   A — structure: both price_currency columns, both allowed-code CHECKs, the
--       coupling CHECK, the rename, and migration 54's constraint renamed with it
--   B — a priced batch with a currency is admitted, so every refusal below is a
--       refusal of the value
--   C — a price with NO currency is refused, on either price column
--   D — an unknown or malformed currency code is refused
--   E — a batch with no price at all needs no currency, and is admitted
--   F — market_price_benchmarks defaults to THB and refuses an unknown code
--   G — no price column anywhere in the public schema lacks an adjacent
--       currency column: the claim re-derived from the catalogue, not from
--       this migration's own list
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches'
                   AND column_name='price_currency') THEN
    v_missing := array_append(v_missing, 'inventory_batches.price_currency');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='market_price_benchmarks'
                   AND column_name='price_currency') THEN
    v_missing := array_append(v_missing, 'market_price_benchmarks.price_currency');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inventory_batches'
                   AND column_name='asking_price') THEN
    v_missing := array_append(v_missing, 'inventory_batches.asking_price (the rename did not happen)');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_batches'
               AND column_name='asking_price_thb') THEN
    v_missing := array_append(v_missing,
      'inventory_batches.asking_price_thb is STILL PRESENT — the currency now lives in a column '
      'and a name that also claims one is a second source of truth');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.inventory_batches'::regclass
                   AND conname='inventory_batches_price_currency_allowed') THEN
    v_missing := array_append(v_missing, 'CHECK inventory_batches_price_currency_allowed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.inventory_batches'::regclass
                   AND conname='inventory_batches_price_requires_currency') THEN
    v_missing := array_append(v_missing, 'CHECK inventory_batches_price_requires_currency');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.market_price_benchmarks'::regclass
                   AND conname='market_price_benchmarks_price_currency_allowed') THEN
    v_missing := array_append(v_missing, 'CHECK market_price_benchmarks_price_currency_allowed');
  END IF;

  -- A column rename does NOT rename its constraints. If migration 54's CHECK is
  -- still called ..._asking_price_thb_sane it is stranded on a column that no
  -- longer has that name, and migration 54 becomes unrollbackable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.inventory_batches'::regclass
                   AND conname='inventory_batches_asking_price_sane') THEN
    v_missing := array_append(v_missing,
      'CHECK inventory_batches_asking_price_sane — migration 54''s constraint was not renamed '
      'with the column it guards');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: both currency columns, all three CHECKs, the asking_price rename, and migration 54''s constraint renamed alongside it.';
END
$verify_a$;

CREATE TEMP TABLE v55_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

DO $seed$
DECLARE
  v_farm uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.farms (id, farm_name) VALUES (v_farm, 'VERIFY-55 farm');
  INSERT INTO v55_ids VALUES ('farm', v_farm);
END
$seed$;

-- -----------------------------------------------------------------------------
-- B. A priced batch WITH a currency is admitted
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  v_id   uuid := gen_random_uuid();
  v_farm uuid := (SELECT id FROM v55_ids WHERE name='farm');
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, price_per_kg, asking_price, price_currency)
  VALUES (v_id, v_farm, 1200, 300000, 'THB');

  IF NOT EXISTS (SELECT 1 FROM public.inventory_batches
                 WHERE id = v_id AND price_currency = 'THB') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: an ordinary priced batch with a valid currency was not stored.';
  END IF;

  -- The two quote currencies, so the vocabulary is not THB-only in practice and a
  -- price genuinely can be expressed for a buyer abroad.
  INSERT INTO public.inventory_batches (id, farm_id, price_per_kg, price_currency)
  VALUES (gen_random_uuid(), v_farm, 40, 'USD'),
         (gen_random_uuid(), v_farm, 37, 'EUR');

  RAISE NOTICE 'VERIFY B PASSED: a priced batch is admitted in the pricing currency and in both quote currencies, so the refusals below are refusals of the value.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- C. A price with NO currency is refused
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v55_ids WHERE name='farm');
BEGIN
  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, price_per_kg)
    VALUES (gen_random_uuid(), v_farm, 1200);
    v_problems := array_append(v_problems, 'price_per_kg was accepted with a NULL currency');
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.inventory_batches (id, farm_id, asking_price)
    VALUES (gen_random_uuid(), v_farm, 300000);
    v_problems := array_append(v_problems, 'asking_price was accepted with a NULL currency');
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- And it cannot be removed after the fact either.
  BEGIN
    UPDATE public.inventory_batches SET price_currency = NULL WHERE price_per_kg IS NOT NULL;
    v_problems := array_append(v_problems, 'an existing priced batch had its currency UPDATEd away');
  EXCEPTION WHEN check_violation THEN NULL; END;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY C FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY C PASSED: a price without a currency is refused on both price columns, on INSERT and on UPDATE.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- D. Unknown and malformed currency codes are refused
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  v_problems text[] := ARRAY[]::text[];
  v_farm     uuid   := (SELECT id FROM v55_ids WHERE name='farm');
  v_code     text;
BEGIN
  FOREACH v_code IN ARRAY ARRAY['XYZ',        -- not a currency
                                'thb',        -- right currency, wrong case
                                'THB ',       -- trailing space
                                'BAHT',       -- a name, not a code
                                '',           -- empty
                                '฿',          -- a symbol, not a code
                                'GBP'] LOOP   -- a real ISO code, deliberately NOT allowed
    BEGIN
      INSERT INTO public.inventory_batches (id, farm_id, price_per_kg, price_currency)
      VALUES (gen_random_uuid(), v_farm, 100, v_code);
      v_problems := array_append(v_problems, format('accepted currency code %L', v_code));
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY D FAILED: %', array_to_string(v_problems, '; ');
  END IF;

  RAISE NOTICE 'VERIFY D PASSED: an unknown code, the wrong case, a trailing space, a currency NAME, an empty string, a currency SYMBOL, and a real ISO code that is deliberately NOT in the vocabulary (GBP) are all refused.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- E. A batch with no price needs no currency
--
-- The coupling is an implication, not a NOT NULL. A batch nobody has priced yet
-- has no currency to declare, and demanding one would be inventing data.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  v_id   uuid := gen_random_uuid();
  v_farm uuid := (SELECT id FROM v55_ids WHERE name='farm');
BEGIN
  INSERT INTO public.inventory_batches (id, farm_id, quantity_kg)
  VALUES (v_id, v_farm, 500);

  IF NOT EXISTS (SELECT 1 FROM public.inventory_batches
                 WHERE id = v_id AND price_currency IS NULL) THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: an unpriced batch was refused or was given a currency it never declared.';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: an unpriced batch carries no currency and is admitted — the rule is "no price without a currency", not "every row has a currency".';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- F. market_price_benchmarks
-- -----------------------------------------------------------------------------
DO $verify_f$
DECLARE
  v_id       uuid := gen_random_uuid();
  v_currency text;
BEGIN
  INSERT INTO public.market_price_benchmarks
    (id, product_type, price_min, price_max, unit, visible_to_farmers)
  VALUES (v_id, 'VERIFY-55 dried flower', 900, 1500, 'kg', false);

  SELECT price_currency INTO v_currency FROM public.market_price_benchmarks WHERE id = v_id;
  IF v_currency IS DISTINCT FROM 'THB' THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: a benchmark row inserted without a currency got %, expected the THB default.',
      coalesce(v_currency, 'NULL');
  END IF;

  BEGIN
    INSERT INTO public.market_price_benchmarks
      (id, product_type, price_min, price_max, unit, visible_to_farmers, price_currency)
    VALUES (gen_random_uuid(), 'VERIFY-55 bad currency', 900, 1500, 'kg', false, 'XYZ');
    RAISE EXCEPTION 'VERIFY F FAILED: a benchmark row with currency XYZ was admitted.';
  EXCEPTION WHEN check_violation THEN NULL; END;

  RAISE NOTICE 'VERIFY F PASSED: benchmark rows default to THB and an unknown code is refused.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- G. The claim, re-derived from the catalogue
--
-- Sections A-F check the columns this migration knows about. This one asks the
-- database instead: is there ANY numeric column in the public schema whose name
-- says it holds a price, on a table with no currency column? A migration that
-- covered its own list and missed a table would pass everything above.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  v_orphans text[];
BEGIN
  SELECT coalesce(array_agg(t || '.' || col ORDER BY t, col), ARRAY[]::text[])
    INTO v_orphans
  FROM (
    SELECT c.relname AS t, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) = 'numeric'
       AND a.attname ~ '(^|_)(price|amount|cost|fee)(_|$)'
       AND NOT EXISTS (
             SELECT 1 FROM pg_attribute a2
              WHERE a2.attrelid = c.oid AND a2.attnum > 0 AND NOT a2.attisdropped
                AND a2.attname ~ 'currenc')
  ) s;

  IF array_length(v_orphans, 1) > 0 THEN
    RAISE EXCEPTION
      'VERIFY G FAILED: price column(s) on tables with no currency column: %. '
      'A price whose unit is not recorded is unreadable.', array_to_string(v_orphans, ', ');
  END IF;

  RAISE NOTICE 'VERIFY G PASSED: no numeric price/amount/cost/fee column exists in the public schema on a table without a currency column — re-derived from the catalogue, not from this migration''s own list.';
END
$verify_g$;

ROLLBACK;
