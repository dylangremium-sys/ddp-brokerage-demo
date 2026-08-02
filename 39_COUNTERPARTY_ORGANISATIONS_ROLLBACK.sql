-- =============================================================================
-- 39_COUNTERPARTY_ORGANISATIONS_ROLLBACK.sql
--
-- Reverses 39_COUNTERPARTY_ORGANISATIONS_HARDENING.sql.
--
-- TWO THINGS THIS ROLLBACK DELIBERATELY DOES NOT UNDO
--
-- 1. The compliance_audit_log action vocabulary stays widened.
--    compliance_audit_log is append-only (migration 9's trigger) and
--    TRUNCATE-hardened (migration 11). If this migration has ever run in
--    anger, rows exist carrying 'organisation_created' and friends, and they
--    CANNOT be deleted by design. Narrowing the CHECK back would therefore
--    either fail outright or — worse, if it were ever forced — invalidate
--    history that the platform's own guarantees say is immutable.
--
--    A widened enumeration is not a vulnerability. Destroyed audit history is.
--    This mirrors migration 37's rollback, which likewise refuses to
--    reintroduce a weaker state (there, bucket privacy) on the way back.
--
-- 2. Nothing is dropped while it holds rows, unless you say so.
--    organisations and organisation_memberships carry counterparty identity.
--    Dropping them discards who a buyer is, who verified them and on what
--    basis. So the default path refuses when the tables are non-empty and
--    tells you what it found; the destructive path requires an explicit,
--    per-transaction opt-in:
--
--      BEGIN;
--        SET LOCAL organisations.rollback_destructive = 'on';
--        \i 39_COUNTERPARTY_ORGANISATIONS_ROLLBACK.sql
--      COMMIT;
--
--    On a disposable or freshly-migrated database the tables are empty and the
--    default path drops them cleanly with no opt-in needed.
--
-- ORDER: policies → triggers → tables → functions → constraint restoration.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Refuse to discard counterparty identity without an explicit opt-in.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  v_opt_in  boolean := coalesce(
                         nullif(current_setting('organisations.rollback_destructive', true), ''),
                         'off') = 'on';
  v_orgs    bigint := 0;
  v_members bigint := 0;
BEGIN
  IF to_regclass('public.organisations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.organisations' INTO v_orgs;
  END IF;
  IF to_regclass('public.organisation_memberships') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.organisation_memberships' INTO v_members;
  END IF;

  IF (v_orgs > 0 OR v_members > 0) AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING destructive rollback: % organisation row(s) and % membership row(s) would be '
      'discarded, including verification actors and bases. Re-run inside a transaction that '
      'first executes: SET LOCAL organisations.rollback_destructive = ''on'';',
      v_orgs, v_members;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Refuse to strand buyer identities behind a narrowed role CHECK.
--
-- PostgreSQL's own failure here is "check constraint profiles_role_check is
-- violated by some row", which names neither the row nor the value. Migration
-- 21's rollback hit exactly that; this one answers the question up front.
-- -----------------------------------------------------------------------------
DO $role_guard$
DECLARE
  v_buyers bigint;
BEGIN
  SELECT count(*) INTO v_buyers FROM public.profiles WHERE role = 'buyer';
  IF v_buyers > 0 THEN
    RAISE EXCEPTION
      'REFUSING to narrow profiles_role_check: % profile row(s) still hold role = ''buyer'' and '
      'would be left violating the restored constraint. Reassign or remove those profiles first; '
      'this rollback will not silently orphan an identity.', v_buyers;
  END IF;
END
$role_guard$;

-- -----------------------------------------------------------------------------
-- 2. Policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS organisations_select              ON public.organisations;
DROP POLICY IF EXISTS organisations_insert              ON public.organisations;
DROP POLICY IF EXISTS organisations_update              ON public.organisations;
DROP POLICY IF EXISTS organisations_delete              ON public.organisations;
DROP POLICY IF EXISTS organisation_memberships_select   ON public.organisation_memberships;
DROP POLICY IF EXISTS organisation_memberships_write    ON public.organisation_memberships;

-- -----------------------------------------------------------------------------
-- 3. Triggers
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS organisations_audit             ON public.organisations;
DROP TRIGGER IF EXISTS organisations_touch_updated_at  ON public.organisations;

-- -----------------------------------------------------------------------------
-- 4. Tables
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.organisation_memberships;
DROP TABLE IF EXISTS public.organisations;

-- -----------------------------------------------------------------------------
-- 5. Functions
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_audit_organisation_change();
DROP FUNCTION IF EXISTS public.fn_organisations_touch_updated_at();
DROP FUNCTION IF EXISTS public.has_organisation_membership(uuid);

-- -----------------------------------------------------------------------------
-- 6. Restore migration 21's role vocabulary.
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('ddp_admin', 'farmer', 'pending'));

-- -----------------------------------------------------------------------------
-- 7. compliance_audit_log's action CHECK is INTENTIONALLY LEFT WIDENED.
--    See the header. Do not "tidy" this by narrowing it.
-- -----------------------------------------------------------------------------

COMMIT;
