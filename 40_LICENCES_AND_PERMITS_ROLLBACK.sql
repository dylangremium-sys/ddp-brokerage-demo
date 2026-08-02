-- =============================================================================
-- 40_LICENCES_AND_PERMITS_ROLLBACK.sql
--
-- Reverses 40_LICENCES_AND_PERMITS_HARDENING.sql.
--
-- WHAT THIS ROLLBACK REFUSES TO DO, AND WHY
--
-- 1. It will not silently discard a permit consumption ledger.
--    permit_drawdowns records how much of a regulated import permit has been
--    used, by whom and against which consignment. Dropping it does not restore
--    headroom — it destroys the only record that headroom was ever consumed,
--    which is materially worse than the migration it is reversing. The default
--    path therefore refuses while any of the three tables hold rows, and names
--    the counts. The destructive path requires an explicit opt-in:
--
--      BEGIN;
--        SET LOCAL licences.rollback_destructive = 'on';
--        \i 40_LICENCES_AND_PERMITS_ROLLBACK.sql
--      COMMIT;
--
-- 2. It leaves compliance_audit_log's action vocabulary widened.
--    Same reasoning as migration 39's rollback: that log is append-only and
--    TRUNCATE-hardened, so rows carrying 'permit_drawn_down' cannot be removed,
--    and narrowing the CHECK would invalidate history the platform guarantees
--    is immutable. A widened enumeration is not a vulnerability.
--
-- 3. fn_touch_updated_at_generic() is NOT dropped unconditionally.
--    It is a generic helper and a later migration may already be using it.
--    It is dropped only if no trigger outside this migration still depends on
--    it — otherwise rolling back 40 would break an unrelated table.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Guard
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_opt_in    boolean := coalesce(
                           nullif(current_setting('licences.rollback_destructive', true), ''),
                           'off') = 'on';
  v_licences  bigint := 0;
  v_permits   bigint := 0;
  v_draws     bigint := 0;
BEGIN
  IF to_regclass('public.licences')         IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.licences'         INTO v_licences; END IF;
  IF to_regclass('public.permits')          IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.permits'          INTO v_permits;  END IF;
  IF to_regclass('public.permit_drawdowns') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.permit_drawdowns' INTO v_draws;    END IF;

  IF (v_licences > 0 OR v_permits > 0 OR v_draws > 0) AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING destructive rollback: % licence(s), % permit(s) and % draw-down row(s) would be '
      'discarded. Dropping the draw-down ledger does not restore permit headroom — it destroys the '
      'record that headroom was consumed. Re-run inside a transaction that first executes: '
      'SET LOCAL licences.rollback_destructive = ''on'';',
      v_licences, v_permits, v_draws;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS licences_select          ON public.licences;
DROP POLICY IF EXISTS licences_write           ON public.licences;
DROP POLICY IF EXISTS permits_select           ON public.permits;
DROP POLICY IF EXISTS permits_write            ON public.permits;
DROP POLICY IF EXISTS permit_drawdowns_select  ON public.permit_drawdowns;
DROP POLICY IF EXISTS permit_drawdowns_insert  ON public.permit_drawdowns;

-- -----------------------------------------------------------------------------
-- 2. Triggers
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS permit_drawdowns_audit             ON public.permit_drawdowns;
DROP TRIGGER IF EXISTS permit_drawdowns_enforce_headroom  ON public.permit_drawdowns;
DROP TRIGGER IF EXISTS permit_drawdowns_no_truncate ON public.permit_drawdowns;
DROP TRIGGER IF EXISTS permit_drawdowns_no_update_delete  ON public.permit_drawdowns;
DROP TRIGGER IF EXISTS licences_touch_updated_at          ON public.licences;
DROP TRIGGER IF EXISTS permits_touch_updated_at           ON public.permits;

-- -----------------------------------------------------------------------------
-- 3. Tables — draw-downs first (FK to permits), then permits, then licences.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.permit_drawdowns;
DROP TABLE IF EXISTS public.permits;
DROP TABLE IF EXISTS public.licences;

-- -----------------------------------------------------------------------------
-- 4. Functions
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_audit_permit_drawdown();
DROP FUNCTION IF EXISTS public.fn_enforce_permit_headroom();
DROP FUNCTION IF EXISTS public.prevent_permit_drawdown_mutation();
DROP FUNCTION IF EXISTS public.permit_headroom_kg(uuid);
DROP FUNCTION IF EXISTS public.permit_drawn_kg(uuid);
DROP FUNCTION IF EXISTS public.permit_is_valid(uuid, date);
DROP FUNCTION IF EXISTS public.licence_is_valid(uuid, date);

-- Shared helper: drop only if nothing else still uses it.
DO $shared$
DECLARE
  v_dependents int;
BEGIN
  SELECT count(*) INTO v_dependents
  FROM pg_trigger t
  JOIN pg_proc  p ON p.oid = t.tgfoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'fn_touch_updated_at_generic'
    AND NOT t.tgisinternal;

  IF v_dependents = 0 THEN
    DROP FUNCTION IF EXISTS public.fn_touch_updated_at_generic();
  ELSE
    RAISE NOTICE
      'Retaining public.fn_touch_updated_at_generic(): % trigger(s) outside migration 40 still '
      'depend on it. Dropping it would break them.', v_dependents;
  END IF;
END
$shared$;

-- -----------------------------------------------------------------------------
-- 5. compliance_audit_log's action CHECK is INTENTIONALLY LEFT WIDENED.
--    See the header. Do not narrow it.
-- -----------------------------------------------------------------------------

COMMIT;
