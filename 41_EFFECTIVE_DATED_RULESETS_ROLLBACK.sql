-- =============================================================================
-- 41_EFFECTIVE_DATED_RULESETS_ROLLBACK.sql
--
-- Reverses 41_EFFECTIVE_DATED_RULESETS_HARDENING.sql.
--
-- WHAT IT REFUSES TO DO WITHOUT AN OPT-IN
--
-- Dropping compliance_rules.effective_from discards any date a human has since
-- CORRECTED against the source instrument. Migration 41 backfills every existing
-- rule with an estimate and flags it; the whole point of the flag is that
-- somebody goes and fixes the estimates. Rolling back throws that work away, and
-- it is not recoverable from created_at because created_at is what produced the
-- wrong estimate in the first place.
--
-- So: if any rule carries a CORRECTED date (effective_from_is_estimated = false)
-- or any destination ruleset exists, this refuses unless told otherwise:
--
--   BEGIN;
--     SET LOCAL rulesets.rollback_destructive = 'on';
--     \i 41_EFFECTIVE_DATED_RULESETS_ROLLBACK.sql
--   COMMIT;
-- =============================================================================

BEGIN;

DO $guard$
DECLARE
  v_opt_in    boolean := coalesce(
                           nullif(current_setting('rulesets.rollback_destructive', true), ''),
                           'off') = 'on';
  v_corrected bigint := 0;
  v_rulesets  bigint := 0;
BEGIN
  IF to_regclass('public.compliance_rules') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='compliance_rules'
                   AND column_name='effective_from_is_estimated')
  THEN
    EXECUTE 'SELECT count(*) FROM public.compliance_rules WHERE effective_from_is_estimated = false'
      INTO v_corrected;
  END IF;

  IF to_regclass('public.destination_rulesets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.destination_rulesets' INTO v_rulesets;
  END IF;

  IF (v_corrected > 0 OR v_rulesets > 0) AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING destructive rollback: % rule(s) carry a human-CORRECTED effective date and % '
      'destination ruleset(s) exist. Corrected dates cannot be rebuilt from created_at — that is '
      'what produced the wrong estimate. Re-run inside a transaction that first executes: '
      'SET LOCAL rulesets.rollback_destructive = ''on'';',
      v_corrected, v_rulesets;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Destination rulesets
-- -----------------------------------------------------------------------------
DROP POLICY  IF EXISTS destination_rulesets_select    ON public.destination_rulesets;
DROP POLICY  IF EXISTS destination_rulesets_write     ON public.destination_rulesets;
DROP TRIGGER IF EXISTS destination_rulesets_no_overlap ON public.destination_rulesets;

DROP FUNCTION IF EXISTS public.destination_ruleset_in_force(char, text, date);
DROP TABLE    IF EXISTS public.destination_rulesets;
DROP FUNCTION IF EXISTS public.fn_reject_overlapping_destination_ruleset();

-- -----------------------------------------------------------------------------
-- 2. Point-in-time resolution over compliance_rules
--
-- Dropped BEFORE the columns it reads, and note the function returns
-- SETOF public.compliance_rules — dropping a column of that table while a
-- function depends on its row type is refused by PostgreSQL, so the order here
-- is load-bearing, not cosmetic.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.compliance_rules_in_force(date);

-- -----------------------------------------------------------------------------
-- 3. compliance_rules columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_rules
  DROP CONSTRAINT IF EXISTS compliance_rules_effective_range_valid;

ALTER TABLE public.compliance_rules
  DROP COLUMN IF EXISTS effective_from_is_estimated,
  DROP COLUMN IF EXISTS effective_to,
  DROP COLUMN IF EXISTS effective_from;

COMMIT;
