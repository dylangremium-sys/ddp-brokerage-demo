-- =============================================================================
-- 45_SEAM7_ORGANISATION_EVENT_SPLIT_ROLLBACK.sql
--
-- Reverses migration 45: the administrative organisation events go back into
-- compliance_audit_log's vocabulary, and fn_audit_organisation_change is
-- restored to migration 39's single-destination form.
--
-- ROLLING THIS BACK RE-BREAKS SEAM 7. That is the intent — it exists so that a
-- failed apply can be undone, not because the previous state was correct.
--
-- WHY THIS ALSO REFUSES TO RUN IN ONE CASE
-- If commercial_audit_log has accumulated rows carrying the four moved actions,
-- narrowing its vocabulary back to the two reservation actions would fail on
-- those rows, and deleting them would mean mutating an append-only log. The
-- rollback aborts and says so. The recoverable state is: replay the rollback
-- after an owner decision about those rows, or stay on 45.
--
-- THE COMPLIANCE HALF IS ALWAYS SAFE. Re-widening a vocabulary cannot fail on
-- existing data, so a compliance log that never received these actions is
-- restored exactly.
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_stray bigint;
BEGIN
  IF to_regclass('public.commercial_audit_log') IS NULL
     OR to_regclass('public.compliance_audit_log') IS NULL THEN
    RAISE EXCEPTION
      'Rollback 45 requires both audit logs to exist. Roll back 44 instead.';
  END IF;

  SELECT count(*) INTO v_stray
  FROM public.commercial_audit_log
  WHERE action IN ('organisation_created', 'organisation_updated',
                   'organisation_membership_granted', 'organisation_membership_revoked');

  IF v_stray > 0 THEN
    RAISE EXCEPTION
      'Rollback 45 aborted: commercial_audit_log holds % row(s) carrying an action this '
      'rollback removes from its vocabulary. Removing them would mean mutating an '
      'append-only log. Decide what happens to those rows first.', v_stray;
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Compliance vocabulary — re-widened to migration 42's 30-value list
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  DROP CONSTRAINT IF EXISTS compliance_audit_log_action_check;
ALTER TABLE public.compliance_audit_log
  ADD CONSTRAINT compliance_audit_log_action_check
  CHECK (action IN (
    'legal_update_created', 'legal_update_reviewed', 'rule_suggested', 'rule_approved',
    'rule_paused', 'rule_retired', 'alert_created', 'alert_resolved',
    'readiness_status_changed', 'document_status_changed', 'sent_to_legal_review',
    'reviewer_note_added', 'rule_rejected', 'legal_update_archived', 'alert_dismissed',
    'organisation_created', 'organisation_updated', 'organisation_verification_changed',
    'organisation_membership_granted', 'organisation_membership_revoked',
    'licence_recorded', 'licence_state_changed', 'permit_recorded', 'permit_state_changed',
    'permit_drawn_down', 'permit_drawdown_reversed',
    'export_eligibility_evaluated', 'export_gate_overridden', 'export_gate_override_reviewed',
    'screening_recorded'
  ));

COMMENT ON CONSTRAINT compliance_audit_log_action_check ON public.compliance_audit_log IS NULL;

-- -----------------------------------------------------------------------------
-- 2. The trigger — restored verbatim to migration 39's body
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_organisation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_action   text;
  v_before   jsonb;
  v_after    jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'organisation_created';
    v_before := NULL;
    v_after  := to_jsonb(NEW);
  ELSE
    v_action := CASE
                  WHEN NEW.verification_state IS DISTINCT FROM OLD.verification_state
                    THEN 'organisation_verification_changed'
                  ELSE 'organisation_updated'
                END;
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
  END IF;

  INSERT INTO public.compliance_audit_log
    (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
  VALUES (
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END,
    v_actor,
    v_action,
    'organisation',
    NEW.id::text,
    v_before,
    v_after,
    NEW.verification_basis
  );

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_organisation_change() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_audit_organisation_change() TO service_role;

DROP TRIGGER IF EXISTS organisations_audit ON public.organisations;
CREATE TRIGGER organisations_audit
  AFTER INSERT OR UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_organisation_change();

-- -----------------------------------------------------------------------------
-- 3. Commercial vocabulary — narrowed back to migration 44's two actions
-- -----------------------------------------------------------------------------
ALTER TABLE public.commercial_audit_log
  DROP CONSTRAINT IF EXISTS commercial_audit_log_action_check;
ALTER TABLE public.commercial_audit_log
  ADD CONSTRAINT commercial_audit_log_action_check
  CHECK (action IN ('reservation_created', 'reservation_released'));

COMMIT;
