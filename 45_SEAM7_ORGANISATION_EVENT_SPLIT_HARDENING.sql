-- =============================================================================
-- 45_SEAM7_ORGANISATION_EVENT_SPLIT_HARDENING.sql
--
-- Finishes Seam 7: the administrative organisation events leave the regulatory
-- log, and `compliance_audit_log`'s vocabulary is NARROWED to match.
--
-- Depends on migration 39 (public.organisations, fn_audit_organisation_change)
-- and migration 44 (public.commercial_audit_log).
--
--   • Rollback: 45_SEAM7_ORGANISATION_EVENT_SPLIT_ROLLBACK.sql
--   • Verify:   45_SEAM7_ORGANISATION_EVENT_SPLIT_VERIFY.sql
--
-- WHAT MOVES, AND WHY THESE FOUR
-- docs/OPTION_B_SEAM_CONTRACT.md Seam 7 is binding and states the line: an
-- action belongs in the compliance log if a regulator, auditor or buyer's
-- counsel could reasonably ask to see it as evidence about COMPLIANCE STATUS,
-- and in the commercial log if it is evidence about A COMMERCIAL RELATIONSHIP.
--
--   moves  → organisation_created, organisation_updated,
--            organisation_membership_granted, organisation_membership_revoked
--   STAYS  → organisation_verification_changed
--
-- `organisation_verification_changed` stays because whether a counterparty is
-- verified is a compliance fact — it is the row an auditor actually looks for.
-- Creating an organisation, or granting someone access to it, is administrative.
-- Migration 39 already separates the verification transition into its own
-- action precisely so that this split is possible without parsing a diff.
--
-- WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 39/42
-- PR #115 made the reservation half of this split by amending migrations 39–44
-- IN PLACE, which was correct at the time on an explicit and explicitly
-- time-limited licence: nothing was applied to any database, so there was no
-- history to preserve. That licence expired on 2026-08-02, when migrations
-- 39–44 were applied to staging (szqo…). An applied migration is history, not a
-- draft. So this corrects forward.
--
-- NARROWING A VOCABULARY IS THE POINT, NOT A SIDE EFFECT
-- Every previous migration that touched this constraint WIDENED it. This one
-- removes four values. That is the only thing that makes the claim "the
-- regulatory log contains regulatory events" enforceable rather than
-- aspirational — while the values remain admissible, any future code path can
-- put them back with nothing to stop it.
--
-- WHY THIS REFUSES TO RUN RATHER THAN MOVING ROWS
-- If the compliance log already holds rows carrying the four moving actions,
-- this migration ABORTS instead of copying them across and deleting the
-- originals. Three reasons, in order of weight:
--   • compliance_audit_log is append-only by trigger (migrations 9 and 11) and
--     that is a security control. A migration that disables it to tidy up has
--     taught the next author that the append-only guarantee is negotiable.
--   • Seam 7 says so directly: "Once these rows exist in a database, 'the
--     regulatory log contains only regulatory events' stops being true, and no
--     later migration makes it true again." Rewriting the log would produce a
--     record that LOOKS clean and is not.
--   • The situation is currently impossible in practice, and the abort is how
--     we find out if that ever stops being true. Measured 2026-08-02:
--       – production's vocabulary is still the original 15 values, so it cannot
--         physically hold one of these rows;
--       – on staging the only producer is fn_audit_organisation_change, which
--         this migration replaces in the same transaction.
-- If it ever does fire, the right response is a deliberate, reviewed data
-- decision by the owner — not a silent side effect of a schema migration.
--
-- A MEASURED NOTE ON THE MEMBERSHIP ACTIONS
-- `organisation_membership_granted` and `organisation_membership_revoked` are
-- moved here because Seam 7 lists them, but NOTHING WRITES THEM. Measured
-- 2026-08-02 across the whole repository: they appear only inside vocabulary
-- CHECK lists (39, 40, 42) and in documentation. `organisation_memberships`
-- carries no audit trigger at all. So for these two the change is vocabulary
-- alignment and nothing else — no behaviour moves, because there is none. When
-- membership auditing is built it must write to the COMMERCIAL log; this
-- migration makes the compliance log reject it, so getting it wrong fails loudly
-- rather than quietly polluting the evidentiary record.
-- =============================================================================

BEGIN;

DO $precondition$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_stray   bigint;
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 39 (public.organisations)');
  END IF;
  IF to_regclass('public.commercial_audit_log') IS NULL THEN
    v_missing := array_append(v_missing, 'migration 44 (public.commercial_audit_log)');
  END IF;
  IF to_regclass('public.compliance_audit_log') IS NULL THEN
    v_missing := array_append(v_missing, 'public.compliance_audit_log');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fn_audit_organisation_change') THEN
    v_missing := array_append(v_missing, 'migration 39 (fn_audit_organisation_change)');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 45 requires: %.', array_to_string(v_missing, ', ');
  END IF;

  -- See "WHY THIS REFUSES TO RUN RATHER THAN MOVING ROWS" above.
  SELECT count(*) INTO v_stray
  FROM public.compliance_audit_log
  WHERE action IN ('organisation_created', 'organisation_updated',
                   'organisation_membership_granted', 'organisation_membership_revoked');

  IF v_stray > 0 THEN
    RAISE EXCEPTION
      'Migration 45 aborted: compliance_audit_log already holds % row(s) carrying an action '
      'this migration removes from its vocabulary. Narrowing the CHECK would fail, and moving '
      'the rows would mean mutating an append-only evidentiary log. This needs a deliberate '
      'owner decision (docs/OPTION_B_SEAM_CONTRACT.md, Seam 7), not a migration side effect.',
      v_stray;
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. Commercial vocabulary — widened to receive the administrative events
--
-- Done BEFORE the compliance log is narrowed and before the trigger is
-- re-pointed, so that at no instant inside this transaction is there an action
-- that neither log will accept.
-- -----------------------------------------------------------------------------
ALTER TABLE public.commercial_audit_log
  DROP CONSTRAINT IF EXISTS commercial_audit_log_action_check;
ALTER TABLE public.commercial_audit_log
  ADD CONSTRAINT commercial_audit_log_action_check
  CHECK (action IN (
    'reservation_created', 'reservation_released',
    'organisation_created', 'organisation_updated',
    'organisation_membership_granted', 'organisation_membership_revoked'
  ));

-- -----------------------------------------------------------------------------
-- 2. The trigger — administrative events to the commercial log, the
--    verification transition to the compliance log
--
-- Same actor derivation as migration 39, deliberately unchanged: auth.uid() is
-- NULL for a service_role / back-office connection with no JWT, and that is a
-- genuinely different actor from a signed-in admin rather than an unknown one.
-- Both logs accept actor_type 'admin' and 'system'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_organisation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_type text;
  v_action     text;
  v_before     jsonb;
  v_after      jsonb;
BEGIN
  v_actor_type := CASE WHEN v_actor IS NULL THEN 'system' ELSE 'admin' END;

  IF TG_OP = 'INSERT' THEN
    v_action := 'organisation_created';
    v_before := NULL;
    v_after  := to_jsonb(NEW);
  ELSE
    -- A verification-state change is its own action. It is the event a
    -- regulator or an auditor actually looks for, and burying it inside a
    -- generic "updated" makes it unfindable in a log of any size. It is also
    -- the sole reason this function can route at all.
    v_action := CASE
                  WHEN NEW.verification_state IS DISTINCT FROM OLD.verification_state
                    THEN 'organisation_verification_changed'
                  ELSE 'organisation_updated'
                END;
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
  END IF;

  IF v_action = 'organisation_verification_changed' THEN
    -- COMPLIANCE. Whether a counterparty is verified is a compliance fact.
    INSERT INTO public.compliance_audit_log
      (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
    VALUES (v_actor_type, v_actor, v_action, 'organisation', NEW.id::text,
            v_before, v_after, NEW.verification_basis);
  ELSE
    -- COMMERCIAL. Creation and ordinary amendment are administrative.
    --
    -- `reason` stays mapped to verification_basis, exactly as migration 39 had
    -- it. It is usually NULL on these two actions; preserving the mapping keeps
    -- the row shape identical across the move, so a reader comparing a
    -- pre-migration compliance row with a post-migration commercial row sees the
    -- same fields carrying the same things.
    INSERT INTO public.commercial_audit_log
      (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, reason)
    VALUES (v_actor_type, v_actor, v_action, 'organisation', NEW.id::text,
            v_before, v_after, NEW.verification_basis);
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_organisation_change() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_audit_organisation_change() TO service_role;

-- The trigger itself is unchanged from migration 39 and is re-asserted only so
-- that this migration is complete on its own terms if 39's trigger was ever
-- dropped by hand.
DROP TRIGGER IF EXISTS organisations_audit ON public.organisations;
CREATE TRIGGER organisations_audit
  AFTER INSERT OR UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_organisation_change();

-- -----------------------------------------------------------------------------
-- 3. Compliance vocabulary — NARROWED
--
-- 30 values become 26. The four administrative organisation actions are removed;
-- organisation_verification_changed and every regulatory action stay. This is
-- the first migration in the series to remove a value rather than add one, and
-- it is what turns Seam 7 from a convention into a constraint.
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
    'organisation_verification_changed',
    'licence_recorded', 'licence_state_changed', 'permit_recorded', 'permit_state_changed',
    'permit_drawn_down', 'permit_drawdown_reversed',
    'export_eligibility_evaluated', 'export_gate_overridden', 'export_gate_override_reviewed',
    'screening_recorded'
  ));

COMMENT ON CONSTRAINT compliance_audit_log_action_check ON public.compliance_audit_log IS
  'Closed regulatory vocabulary (26 values). Seam 7: commercial and administrative '
  'events belong in commercial_audit_log. Widening this to admit one is a contract '
  'change, not a schema change.';

COMMIT;
