-- =============================================================================
-- 42_EXPORT_ELIGIBILITY_GATE_ROLLBACK.sql
--
-- Reverses 42_EXPORT_ELIGIBILITY_GATE_HARDENING.sql.
--
-- WHAT IT REFUSES TO DO WITHOUT AN OPT-IN
--
-- export_eligibility_evaluations is the record that the gate ran, what it saw,
-- and what it decided. export_gate_overrides is the record of every occasion a
-- named human bypassed a hard stop. Those two tables are the platform's answer
-- to "prove this consignment was checked" and "show me every exception" — the
-- two questions an inspector actually asks.
--
-- Dropping them does not undo a shipment. It destroys the evidence that the
-- shipment was assessed, which is strictly worse than the migration being
-- present. So this refuses while either table holds rows unless told:
--
--   BEGIN;
--     SET LOCAL export_gate.rollback_destructive = 'on';
--     \i 42_EXPORT_ELIGIBILITY_GATE_ROLLBACK.sql
--   COMMIT;
--
-- The audit-log action vocabulary is left widened, for the same reason as
-- migrations 39 and 40: that log is append-only and its rows cannot be removed.
-- =============================================================================

BEGIN;

DO $guard$
DECLARE
  v_opt_in    boolean := coalesce(
                           nullif(current_setting('export_gate.rollback_destructive', true), ''),
                           'off') = 'on';
  v_evals     bigint := 0;
  v_overrides bigint := 0;
  v_screens   bigint := 0;
BEGIN
  IF to_regclass('public.export_eligibility_evaluations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.export_eligibility_evaluations' INTO v_evals;
  END IF;
  IF to_regclass('public.export_gate_overrides') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.export_gate_overrides' INTO v_overrides;
  END IF;
  IF to_regclass('public.screening_checks') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.screening_checks' INTO v_screens;
  END IF;

  IF (v_evals > 0 OR v_overrides > 0 OR v_screens > 0) AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING destructive rollback: % gate evaluation(s), % override(s) and % screening record(s) '
      'would be discarded. These are the evidence that consignments were assessed and that every '
      'bypass was named and reasoned. Re-run inside a transaction that first executes: '
      'SET LOCAL export_gate.rollback_destructive = ''on'';',
      v_evals, v_overrides, v_screens;
  END IF;
END
$guard$;

-- 1. View first — it depends on two of the tables.
DROP VIEW IF EXISTS public.export_gate_overrides_pending_review;

-- 2. Policies
DROP POLICY IF EXISTS screening_checks_admin       ON public.screening_checks;
DROP POLICY IF EXISTS evaluations_admin_select     ON public.export_eligibility_evaluations;
DROP POLICY IF EXISTS evaluations_admin_insert     ON public.export_eligibility_evaluations;
DROP POLICY IF EXISTS overrides_admin              ON public.export_gate_overrides;

-- 3. Triggers
DROP TRIGGER IF EXISTS export_gate_overrides_validate ON public.export_gate_overrides;
DROP TRIGGER IF EXISTS export_gate_overrides_no_truncate ON public.export_gate_overrides;
DROP TRIGGER IF EXISTS export_gate_overrides_guard    ON public.export_gate_overrides;
DROP TRIGGER IF EXISTS export_eligibility_evaluations_no_truncate ON public.export_eligibility_evaluations;
DROP TRIGGER IF EXISTS export_eligibility_evaluations_no_update_delete ON public.export_eligibility_evaluations;

-- 4. The gate function, before the tables it writes to.
DROP FUNCTION IF EXISTS public.evaluate_export_eligibility(text, uuid, uuid, text, char, numeric, uuid, date);

-- 5. Tables — overrides first (FK to evaluations).
DROP TABLE IF EXISTS public.export_gate_overrides;
DROP TABLE IF EXISTS public.export_eligibility_evaluations;
DROP TABLE IF EXISTS public.screening_checks;

-- 6. Remaining functions
DROP FUNCTION IF EXISTS public.fn_validate_override();
DROP FUNCTION IF EXISTS public.fn_guard_override_mutation();
DROP FUNCTION IF EXISTS public.prevent_evaluation_mutation();
DROP FUNCTION IF EXISTS public.screening_is_clear(uuid, date);

-- 7. compliance_audit_log's action CHECK is INTENTIONALLY LEFT WIDENED.

COMMIT;
