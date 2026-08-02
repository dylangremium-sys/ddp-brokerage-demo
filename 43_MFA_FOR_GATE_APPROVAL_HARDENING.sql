-- =============================================================================
-- 43_MFA_FOR_GATE_APPROVAL_HARDENING.sql
--
-- Multi-factor assurance for anyone who bypasses a compliance gate (plan §10).
--
-- Depends on migration 42 (export_gate_overrides).
--
-- WHAT §10 ASKS FOR
-- "Multi-factor authentication mandatory for all internal staff and for any role
-- able to approve a compliance gate or release a hold." Today DDP has none — a
-- single password is all that stands between an attacker and the ability to
-- override the export gate, which is the one action in the platform that lets
-- product move against a failed check.
--
-- WHY THIS SHIPS DISABLED, AND WHY THAT IS NOT A FUDGE
-- Enforcement is real and it is wired in. It is switched OFF at install, because
-- switching it on before a single administrator has enrolled a second factor
-- would lock every approver out of the gate at once — turning a security
-- improvement into an outage, during which the pressure to disable it again
-- would be overwhelming. The enrol-then-enforce order is the only one that
-- survives contact with a real team.
--
-- Enabling it is one statement, recorded with an actor and a note:
--
--   UPDATE public.security_settings
--      SET enabled = true, changed_by = auth.uid(), changed_at = now(),
--          note = 'All four admins enrolled TOTP on <date>; verified by <name>.'
--    WHERE key = 'mfa_required_for_gate_approval';
--
-- A MISSING SETTING MEANS REQUIRED, NOT DISABLED
-- If the settings row is absent, enforcement is ON. Deleting a row must never be
-- a way to switch off a control — that is the one edit an attacker with table
-- access would reach for, and the one an operator makes by accident. The cost of
-- getting this backwards is silent: nobody notices a gate that stopped checking.
-- The cost of getting it this way round is loud and recoverable: approvals fail
-- until the row is restored.
--
-- WHAT IS NOT WIRED UP YET, STATED PLAINLY
-- The pre-existing buyer-pack issuance RPC (issue_buyer_pack_snapshot, migrations
-- 23/29) is also a compliance-gate approval under §10's definition and is NOT
-- covered here. Covering it means redefining that function, which would mean
-- copying its body out of migration 29 and maintaining two copies of a
-- security-critical routine. That belongs in a migration that owns the RPC, not
-- this one. Until then, MFA protects the export gate only.
--
--   • Rollback: 43_MFA_FOR_GATE_APPROVAL_ROLLBACK.sql
--   • Verify:   43_MFA_FOR_GATE_APPROVAL_VERIFY.sql
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.export_gate_overrides') IS NULL THEN
    RAISE EXCEPTION 'Migration 43 requires migration 42: public.export_gate_overrides does not exist.';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Security settings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_settings (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL,

  -- A control that is turned off must say who turned it off and why. A boolean
  -- alone leaves no way to tell a deliberate, reviewed decision from a
  -- convenience toggle somebody meant to revert.
  note       text NOT NULL CHECK (length(btrim(note)) > 0),
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.security_settings (key, enabled, note)
VALUES (
  'mfa_required_for_gate_approval',
  false,
  'Disabled at install by migration 43. Enabling this before administrators have enrolled a '
  'second factor would lock every approver out of the export gate simultaneously. Enrol first, '
  'then set enabled = true and record who verified enrolment.')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Reading the assurance level out of the JWT
--
-- Supabase/GoTrue publishes the authenticator assurance level as the `aal`
-- claim: 'aal1' for password-only, 'aal2' once a second factor has been
-- verified in the session.
--
-- Two transports are supported because Supabase has used both: the whole claim
-- set as JSON in `request.jwt.claims`, and individual claims as
-- `request.jwt.claim.<name>`. Reading only one of them would make this silently
-- return NULL on the other, and a NULL assurance level reads as "not aal2" —
-- which fails closed, but would also mean MFA could never be satisfied and the
-- gate would be permanently unusable once enabled. Supporting both is what makes
-- enforcement operable rather than merely strict.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_auth_assurance_level()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw   text;
  v_aal   text;
BEGIN
  -- Preferred: the full claim set as JSON.
  v_raw := nullif(current_setting('request.jwt.claims', true), '');
  IF v_raw IS NOT NULL THEN
    BEGIN
      v_aal := (v_raw::jsonb) ->> 'aal';
    EXCEPTION WHEN others THEN
      -- Malformed claims are not an assurance level. Fall through rather than
      -- raising: an unparseable JWT must deny, not crash the caller.
      v_aal := NULL;
    END;
  END IF;

  IF v_aal IS NULL THEN
    v_aal := nullif(current_setting('request.jwt.claim.aal', true), '');
  END IF;

  RETURN v_aal;
END
$$;

CREATE OR REPLACE FUNCTION public.has_mfa_assurance()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Only aal2 counts. Anything else — aal1, absent, malformed, or a value
  -- GoTrue has not defined yet — is not a verified second factor.
  SELECT coalesce(public.current_auth_assurance_level() = 'aal2', false)
$$;

-- Is enforcement switched on? A missing row means YES. See the header.
CREATE OR REPLACE FUNCTION public.mfa_required_for_gate_approval()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT s.enabled FROM public.security_settings s
      WHERE s.key = 'mfa_required_for_gate_approval'),
    true)
$$;

REVOKE EXECUTE ON FUNCTION public.current_auth_assurance_level()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_mfa_assurance()                 FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mfa_required_for_gate_approval()    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_auth_assurance_level()      TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.has_mfa_assurance()                 TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.mfa_required_for_gate_approval()    TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Enforcement at the override
--
-- A trigger rather than a check inside an RPC, so it holds no matter which code
-- path inserts the row — including a direct table write from the SQL editor.
--
-- service_role connections (auth.uid() IS NULL, no JWT at all) are exempt:
-- they are back-office and server-side, cannot present a second factor, and are
-- protected by holding the service key rather than by a session. Making them
-- fail would simply move overrides to a path with no actor recorded at all,
-- which is worse. The exemption is narrow and it is deliberate.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_require_mfa_for_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF NOT public.mfa_required_for_gate_approval() THEN
    RETURN NEW;
  END IF;

  -- No JWT subject at all: a service_role/back-office connection. See above.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.has_mfa_assurance() THEN
    RAISE EXCEPTION
      'export gate override refused: multi-factor assurance (aal2) is required to approve a '
      'compliance-gate bypass, and this session presents %. Re-authenticate with your second '
      'factor and retry.',
      coalesce(public.current_auth_assurance_level(), 'no assurance claim');
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_require_mfa_for_override() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_require_mfa_for_override() TO service_role;

DROP TRIGGER IF EXISTS export_gate_overrides_require_mfa ON public.export_gate_overrides;
CREATE TRIGGER export_gate_overrides_require_mfa
  BEFORE INSERT ON public.export_gate_overrides
  FOR EACH ROW EXECUTE FUNCTION public.fn_require_mfa_for_override();

-- -----------------------------------------------------------------------------
-- 4. Row level security
--
-- Everyone signed in may READ the security posture — a control whose state is
-- secret cannot be audited, and there is nothing sensitive in "MFA is on".
-- Only DDP admins may change it.
-- -----------------------------------------------------------------------------
ALTER TABLE public.security_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS security_settings_select ON public.security_settings;
CREATE POLICY security_settings_select ON public.security_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS security_settings_write ON public.security_settings;
CREATE POLICY security_settings_write ON public.security_settings
  FOR ALL TO authenticated
  USING (public.is_ddp_admin()) WITH CHECK (public.is_ddp_admin());

REVOKE ALL ON public.security_settings FROM PUBLIC, anon;
-- No DELETE for anyone: removing the row is not a supported way to change the
-- setting, and the missing-row default exists to make deletion safe, not useful.
GRANT SELECT, INSERT, UPDATE ON public.security_settings TO authenticated, service_role;

COMMIT;
