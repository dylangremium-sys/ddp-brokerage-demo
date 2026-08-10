-- =============================================================================
-- 55_PRICE_CURRENCY_EXPLICIT_HARDENING.sql
--
-- Makes the currency of every price explicit, and stops a price existing
-- without one (defect D12).
--
-- Depends on migration 54 (it renames a constraint 54 created).
--
-- WHAT IS WRONG TODAY
-- A full sweep of production's 48 public tables (read-only, 2026-08-04) finds
-- exactly three money-bearing columns and NO currency column anywhere:
--
--   inventory_batches.price_per_kg          numeric        (written by the app)
--   inventory_batches.asking_price_thb      numeric        (written by nothing)
--   market_price_benchmarks.price_min/max   numeric NOT NULL
--
-- This is a cross-border brokerage: Thai farm-gate supply, buyers abroad. The
-- only thing in the schema that records a currency is four characters at the end
-- of one column NAME — and a name is not a value. Nothing can read it, nothing
-- can convert on it, and nothing stops the next price column from picking a
-- different unit silently. A buyer quoted 1,200 has no way to know whether that
-- is baht or dollars, and neither has the database.
--
-- PRICING CURRENCY: THB
-- Stated by the platform owner, 2026-08-05: the business is in Thailand and
-- prices are in Thai baht. Euro and dollar are the currencies a price may be
-- QUOTED in for a buyer abroad; baht is what a price means when it does not say.
--
-- This could NOT be measured from the system. Production's price rows are
-- unreadable to the read-only role (`permission denied for function
-- has_operational_farmer_access`), so the fact was asked for. It was also got
-- wrong twice on the way here — first inferred from a column name, then set to
-- USD on a partial answer — which is precisely the argument for storing a
-- currency as a value instead of leaving it to be deduced.
--
-- THREE ALLOWED CODES, AND WHY EACH ONE
--   THB  the pricing currency, and the default for a price that names no currency
--   USD  quote currency for buyers abroad
--   EUR  quote currency for buyers abroad
-- Everything else is refused. An earlier draft allowed eight codes; that list was
-- a guess about which markets might matter, and a guess in a controlled
-- vocabulary is just a wider hole. Three codes each have a reason.
--
-- WHY A CHECK AND NOT A LOOKUP TABLE
-- A `currencies` table with foreign keys from both price-bearing tables would be
-- the textbook answer. It is not taken here because it needs a seeding story, two
-- foreign keys, and a policy for what happens when a currency is retired while
-- historic prices still reference it — none of which this platform can answer
-- yet, and all of which would be guessed. A CHECK is honest about being a
-- controlled vocabulary somebody chose. Widening it is one forward migration:
--
--   ALTER TABLE public.inventory_batches
--     DROP CONSTRAINT inventory_batches_price_currency_allowed,
--     ADD  CONSTRAINT inventory_batches_price_currency_allowed
--       CHECK (price_currency IS NULL OR price_currency IN ('THB','USD','EUR','NEW'));
--
-- Recorded as a deliberate trade-off, not an oversight.
--
-- WHAT THIS MIGRATION DOES NOT DO: CONVERT
-- It records which currency each amount is already in. It does not restate any
-- amount, and there is no exchange rate anywhere in this repository. A price
-- stamped THB that was actually entered in dollars stays wrong — the stamp makes
-- the claim legible, not true.
--
-- WHY asking_price_thb IS RENAMED
-- Once the currency lives in a column, a column name that also claims a currency
-- is a second source of truth, and the two can disagree. `asking_price_thb` with
-- `price_currency = 'USD'` is a row nobody can read correctly. It becomes
-- `asking_price`, and migration 54's CHECK on it is renamed to match — a column
-- rename does NOT rename its constraints, so leaving that alone would strand
-- `inventory_batches_asking_price_thb_sane` on a column called `asking_price`.
--
-- This is safe in a way most renames are not: `asking_price_thb` appears in NO
-- .sql, .ts or .tsx file in this repository, on ANY branch (checked 2026-08-04).
-- It is production drift whose origin is still unexplained. Nothing reads it, so
-- nothing breaks — but "nothing in THIS repository reads it" is the honest claim,
-- and an unknown external consumer would break. Stated so the risk is owned.
--
-- WHAT IS NOT COVERED
-- `market_price_benchmarks` has no CHECK constraints at all — price_min may
-- exceed price_max, and both may be negative or NaN. That is the same defect as
-- D14 on a different table and belongs in a migration that owns it, not in one
-- about currency. Named here so it is not silently dropped.
--
--   • Rollback: 55_PRICE_CURRENCY_EXPLICIT_ROLLBACK.sql
--   • Verify:   55_PRICE_CURRENCY_EXPLICIT_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.inventory_batches') IS NULL THEN
    v_missing := array_append(v_missing, 'table public.inventory_batches');
  END IF;
  IF to_regclass('public.market_price_benchmarks') IS NULL THEN
    v_missing := array_append(v_missing, 'table public.market_price_benchmarks');
  END IF;

  IF to_regclass('public.inventory_batches') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                     AND column_name = 'asking_price_thb') THEN
      v_missing := array_append(v_missing, 'column inventory_batches.asking_price_thb');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'inventory_batches'
                     AND column_name = 'price_per_kg') THEN
      v_missing := array_append(v_missing, 'column inventory_batches.price_per_kg');
    END IF;
    -- Migration 54's constraint is RENAMED below, not recreated. If it is absent
    -- the rename fails mid-migration; refusing here says why.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.inventory_batches'::regclass
                     AND conname = 'inventory_batches_asking_price_thb_sane') THEN
      v_missing := array_append(v_missing,
        'constraint inventory_batches_asking_price_thb_sane (migration 54)');
    END IF;
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Migration 55 requires migration 54 and the production price columns. Missing: %.',
      array_to_string(v_missing, ', ');
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. inventory_batches — the currency, and the rename
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
  RENAME COLUMN asking_price_thb TO asking_price;

ALTER TABLE public.inventory_batches
  RENAME CONSTRAINT inventory_batches_asking_price_thb_sane
                 TO inventory_batches_asking_price_sane;

ALTER TABLE public.inventory_batches
  ADD COLUMN price_currency text;

-- Backfill BEFORE the coupling constraint, or the constraint would refuse the
-- rows it exists to describe. THB, the pricing currency — which is also what the
-- column these amounts came from claimed in its own name (`asking_price_thb`).
-- The name is not evidence and never was, but the two now agree, so the backfill
-- is not reinterpreting anything.
UPDATE public.inventory_batches
   SET price_currency = 'THB'
 WHERE price_currency IS NULL
   AND (price_per_kg IS NOT NULL OR asking_price IS NOT NULL);

ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_price_currency_allowed
    CHECK (price_currency IS NULL OR price_currency IN ('THB', 'USD', 'EUR')),

  -- The guarantee this migration exists to create: no amount without a unit.
  -- Written as an implication rather than a NOT NULL because a batch with no
  -- price at all has no currency to declare, and forcing one would be inventing
  -- data. A price WITHOUT a currency is the unreadable row; a currency without
  -- a price is merely unused.
  ADD CONSTRAINT inventory_batches_price_requires_currency
    CHECK ((price_per_kg IS NULL AND asking_price IS NULL) OR price_currency IS NOT NULL);

COMMENT ON COLUMN public.inventory_batches.price_currency IS
  'ISO 4217 alpha-3 for price_per_kg and asking_price. Pricing currency is THB '
  '(migration 55); USD and EUR are quote currencies for buyers abroad. NULL only '
  'when the batch has no price. Records the currency an amount is ALREADY in — '
  'nothing here converts.';

COMMENT ON COLUMN public.inventory_batches.asking_price IS
  'Renamed from asking_price_thb by migration 55: the currency now lives in '
  'price_currency, and a name that also claimed one was a second source of truth.';

-- -----------------------------------------------------------------------------
-- 2. market_price_benchmarks — the currency
--
-- price_min and price_max are already NOT NULL, so every row has a price and
-- every row therefore needs a currency. That makes NOT NULL DEFAULT correct here
-- where the implication-style CHECK was correct above: there is no such thing as
-- a benchmark row without a price to denominate.
--
-- The DEFAULT also backfills the five rows production already holds. Those rows
-- are the one place the owner's two answers disagreed — first "dollars", then
-- "baht, we're in Thailand" — and they are unreadable to the read-only role, so
-- this stamps them with the pricing currency and flags them for a human check.
-- Nothing is converted either way; only the label changes.
-- -----------------------------------------------------------------------------
ALTER TABLE public.market_price_benchmarks
  ADD COLUMN price_currency text NOT NULL DEFAULT 'THB';

ALTER TABLE public.market_price_benchmarks
  ADD CONSTRAINT market_price_benchmarks_price_currency_allowed
    CHECK (price_currency IN ('THB', 'USD', 'EUR'));

COMMENT ON COLUMN public.market_price_benchmarks.price_currency IS
  'ISO 4217 alpha-3 for price_min and price_max. Defaults to THB, the pricing '
  'currency (migration 55). The five rows present when 55 was written were never '
  'read — verify them before trusting the label.';

COMMIT;
