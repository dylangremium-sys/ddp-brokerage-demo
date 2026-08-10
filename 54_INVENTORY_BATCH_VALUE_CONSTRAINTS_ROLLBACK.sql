-- =============================================================================
-- 54_INVENTORY_BATCH_VALUE_CONSTRAINTS_ROLLBACK.sql
--
-- Reverses 54_INVENTORY_BATCH_VALUE_CONSTRAINTS_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This removes every value guarantee on the table the commercial spine hangs
-- off, and — like migration 43's rollback — the resulting state looks entirely
-- normal. No table goes missing, nothing errors, no alert fires. The database
-- simply goes back to accepting a negative price, a THC reading of 4000, NaN,
-- and two batches on one farm sharing a number.
--
-- If a legitimate row is being refused, the fix is almost always to widen the
-- single offending bound rather than to drop all twelve constraints:
--
--   ALTER TABLE public.inventory_batches
--     DROP CONSTRAINT inventory_batches_quantity_kg_sane,
--     ADD  CONSTRAINT inventory_batches_quantity_kg_sane
--       CHECK (quantity_kg IS NULL OR (quantity_kg <> 'NaN'::numeric
--              AND quantity_kg >= 0 AND quantity_kg <= <new ceiling>));
--
-- Keep the `<> 'NaN'` term when you do. It is what stops a raised ceiling from
-- silently re-admitting NaN, which is the failure this migration exists to
-- close and the one that looks like nothing at all.
--
-- AFTER THIS ROLLBACK, MIGRATION 44's VERIFY SECTION G PASSES AGAIN
-- 44 G inserts a NaN-quantity batch on purpose. Migration 54 refuses that row;
-- this rollback permits it again. If you are rolling back in order to make 44 G
-- pass, stop — 44 G failing is migration 54 working.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.inventory_batches_farm_batch_number_key;

ALTER TABLE public.inventory_batches
  DROP CONSTRAINT IF EXISTS inventory_batches_batch_number_not_blank,
  DROP CONSTRAINT IF EXISTS inventory_batches_water_activity_range,
  DROP CONSTRAINT IF EXISTS inventory_batches_total_terpenes_pct_range,
  DROP CONSTRAINT IF EXISTS inventory_batches_moisture_percent_range,
  DROP CONSTRAINT IF EXISTS inventory_batches_cbd_percent_range,
  DROP CONSTRAINT IF EXISTS inventory_batches_thc_percent_range,
  DROP CONSTRAINT IF EXISTS inventory_batches_asking_price_thb_sane,
  DROP CONSTRAINT IF EXISTS inventory_batches_price_per_kg_sane,
  DROP CONSTRAINT IF EXISTS inventory_batches_minimum_order_kg_sane,
  DROP CONSTRAINT IF EXISTS inventory_batches_quantity_kg_sane;

-- Postcondition. Only 6 of 36 rollback files in this repository assert that
-- they actually removed what they claim to remove; the rest trust the DROPs.
-- A DROP ... IF EXISTS that matched nothing because a name was misspelled is
-- indistinguishable from success, and the rollback-symmetry gate compares
-- catalogues rather than reading intent.
DO $postcondition$
DECLARE
  v_left text[];
BEGIN
  SELECT coalesce(array_agg(conname ORDER BY conname), ARRAY[]::text[]) INTO v_left
  FROM pg_constraint
  WHERE conrelid = 'public.inventory_batches'::regclass
    AND conname LIKE 'inventory_batches_%'
    AND conname IN ('inventory_batches_quantity_kg_sane',
                    'inventory_batches_minimum_order_kg_sane',
                    'inventory_batches_price_per_kg_sane',
                    'inventory_batches_asking_price_thb_sane',
                    'inventory_batches_thc_percent_range',
                    'inventory_batches_cbd_percent_range',
                    'inventory_batches_moisture_percent_range',
                    'inventory_batches_total_terpenes_pct_range',
                    'inventory_batches_water_activity_range',
                    'inventory_batches_batch_number_not_blank');

  IF array_length(v_left, 1) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK 54 INCOMPLETE: constraint(s) still present: %',
      array_to_string(v_left, ', ');
  END IF;

  IF to_regclass('public.inventory_batches_farm_batch_number_key') IS NOT NULL THEN
    RAISE EXCEPTION
      'ROLLBACK 54 INCOMPLETE: index inventory_batches_farm_batch_number_key still present.';
  END IF;

  RAISE NOTICE 'ROLLBACK 54: ten CHECK constraints and the per-farm batch-number index removed.';
END
$postcondition$;

COMMIT;
