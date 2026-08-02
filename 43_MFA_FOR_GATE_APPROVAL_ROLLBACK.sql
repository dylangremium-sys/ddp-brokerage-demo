-- =============================================================================
-- 43_MFA_FOR_GATE_APPROVAL_ROLLBACK.sql
--
-- Reverses 43_MFA_FOR_GATE_APPROVAL_HARDENING.sql.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This rollback REMOVES a security control. If MFA enforcement is currently
-- ENABLED, running this silently returns the export gate to password-only
-- approval — and unlike most rollbacks in this repository, nothing about the
-- resulting state looks wrong. There is no error, no missing table anyone will
-- notice, and no alert. The gate simply stops asking for a second factor.
--
-- So it refuses while enforcement is on, unless told:
--
--   BEGIN;
--     SET LOCAL mfa.rollback_disable_enforcement = 'on';
--     \i 43_MFA_FOR_GATE_APPROVAL_ROLLBACK.sql
--   COMMIT;
--
-- If you are rolling back because MFA is causing an outage, the correct action
-- is almost always to DISABLE THE SETTING rather than to remove the control:
--
--   UPDATE public.security_settings
--      SET enabled = false, changed_by = auth.uid(), changed_at = now(),
--          note = '<why, and when it will be re-enabled>'
--    WHERE key = 'mfa_required_for_gate_approval';
--
-- That leaves the mechanism in place, records who switched it off and why, and
-- can be reversed in one statement. This rollback cannot.
-- =============================================================================

BEGIN;

DO $guard$
DECLARE
  v_opt_in   boolean := coalesce(
                          nullif(current_setting('mfa.rollback_disable_enforcement', true), ''),
                          'off') = 'on';
  v_enabled  boolean := false;
BEGIN
  IF to_regclass('public.security_settings') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce((SELECT enabled FROM public.security_settings '
            'WHERE key = ''mfa_required_for_gate_approval''), false)'
      INTO v_enabled;
  END IF;

  IF v_enabled AND NOT v_opt_in THEN
    RAISE EXCEPTION
      'REFUSING to roll back migration 43 while MFA enforcement is ENABLED. Removing it returns '
      'the export gate to password-only approval and nothing about the resulting state looks '
      'wrong. If you need to relieve an outage, set security_settings.enabled = false instead — '
      'that is reversible and records who did it. To proceed anyway, re-run inside a transaction '
      'that first executes: SET LOCAL mfa.rollback_disable_enforcement = ''on'';';
  END IF;
END
$guard$;

DROP TRIGGER  IF EXISTS export_gate_overrides_require_mfa ON public.export_gate_overrides;
DROP TRIGGER  IF EXISTS security_settings_guard_weakening ON public.security_settings;

DROP POLICY   IF EXISTS security_settings_select ON public.security_settings;
DROP POLICY   IF EXISTS security_settings_write  ON public.security_settings;

DROP FUNCTION IF EXISTS public.fn_guard_security_setting_weakening();
DROP FUNCTION IF EXISTS public.fn_require_mfa_for_override();
DROP FUNCTION IF EXISTS public.mfa_required_for_gate_approval();
DROP FUNCTION IF EXISTS public.has_mfa_assurance();
DROP FUNCTION IF EXISTS public.current_auth_assurance_level();

DROP TABLE    IF EXISTS public.security_settings;

COMMIT;
