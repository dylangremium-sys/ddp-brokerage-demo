-- =============================================================================
-- 44_RESERVATION_LEDGER_ROLLBACK.sql
--
-- Reverses 44_RESERVATION_LEDGER_HARDENING.sql.
--
-- WHAT IT REFUSES TO DO WITHOUT AN OPT-IN
--
-- Dropping the reservation ledger does not release the stock — it destroys the
-- record that stock was ever held, and with it every conversion linking a hold
-- to a shipment. Buyers keep believing they have a claim; the platform stops
-- being able to say who does. That is worse than the migration being present.
--
--   BEGIN;
--     SET LOCAL reservations.rollback_destructive = 'on';
--     \i 44_RESERVATION_LEDGER_ROLLBACK.sql
--   COMMIT;
--
-- The compliance_audit_log action vocabulary is left widened, for the same
-- reason as migrations 39, 40, 42 and 44: that log is append-only and
-- TRUNCATE-hardened, its rows cannot be removed, and narrowing the CHECK would
-- invalidate history the platform guarantees is immutable.
-- =============================================================================

BEGIN;

DO $guard$
DECLARE
  v_opt_in       boolean := coalesce(
                              nullif(current_setting('reservations.rollback_destructive', true), ''),
                              'off') = 'on';
  v_reservations bigint := 0;
  v_releases     bigint := 0;
  v_active       bigint := 0;
BEGIN
  IF to_regclass('public.reservations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.reservations' INTO v_reservations;
    EXECUTE 'SELECT count(*) FROM public.reservations r WHERE r.expires_at > now() '
            'AND NOT EXISTS (SELECT 1 FROM public.reservation_releases x WHERE x.reservation_id = r.id)'
      INTO v_active;
  END IF;
  IF to_regclass('public.reservation_releases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.reservation_releases' INTO v_releases;
  END IF;

  IF (v_reservations > 0 OR v_releases > 0) AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING destructive rollback: % reservation(s) (% still ACTIVE) and % release row(s) would '
      'be discarded. Dropping the ledger does not release stock — it destroys the record that stock '
      'was held and every conversion linking a hold to a shipment. Re-run inside a transaction that '
      'first executes: SET LOCAL reservations.rollback_destructive = ''on'';',
      v_reservations, v_active, v_releases;
  END IF;
END
$guard$;

DROP POLICY  IF EXISTS reservations_select              ON public.reservations;
DROP POLICY  IF EXISTS reservations_insert              ON public.reservations;
DROP POLICY  IF EXISTS reservation_releases_select      ON public.reservation_releases;
DROP POLICY  IF EXISTS reservation_releases_insert      ON public.reservation_releases;

DROP TRIGGER IF EXISTS reservations_audit               ON public.reservations;
DROP TRIGGER IF EXISTS reservation_releases_audit       ON public.reservation_releases;
DROP TRIGGER IF EXISTS reservations_enforce_availability ON public.reservations;
DROP TRIGGER IF EXISTS reservations_no_update_delete    ON public.reservations;
DROP TRIGGER IF EXISTS reservation_releases_no_update_delete ON public.reservation_releases;

-- Releases first (FK to reservations).
DROP TABLE IF EXISTS public.reservation_releases;
DROP TABLE IF EXISTS public.reservations;

DROP FUNCTION IF EXISTS public.fn_audit_reservation();
DROP FUNCTION IF EXISTS public.fn_enforce_reservation_availability();
DROP FUNCTION IF EXISTS public.prevent_reservation_mutation();
DROP FUNCTION IF EXISTS public.batch_available_kg(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.batch_reserved_kg(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.batch_reserved_kg_unchecked(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.reservation_is_active(uuid, timestamptz);

-- compliance_audit_log's action CHECK is INTENTIONALLY LEFT WIDENED.

COMMIT;
