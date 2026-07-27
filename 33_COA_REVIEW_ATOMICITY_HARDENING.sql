-- =============================================================================
-- Migration 33 — COA review atomicity & loud refusals (red-team remediation #2)
--
-- Closes the two findings left ACCEPTED after migration 32.
--
-- FINDING A — tamper attempts were SILENT.
--   coa_decisions (and, after migration 32, the provenance tables) expose no
--   UPDATE/DELETE policy. Under RLS that means the statement matches zero rows
--   and returns success, so the row-level append-only trigger is never reached
--   through PostgREST. Integrity held, but an attempt left no error and no
--   signal — indistinguishable from success to the caller, and invisible to an
--   operator.
--
--   Fix: STATEMENT-level triggers. A FOR EACH STATEMENT trigger fires even when
--   RLS filters every row away, so the attempt is refused loudly instead of
--   succeeding against nothing.
--
-- FINDING B — a decision and its audit event were not atomic.
--   The browser client inserted the decision, then separately inserted the
--   audit row. A failure between the two left a recorded decision with no audit
--   trail — precisely the pairing the gate requires.
--
--   Fix: record_coa_decision(), a SECURITY DEFINER function that writes both in
--   ONE transaction, pins decided_by to auth.uid(), and re-checks admin rights
--   internally so it cannot be used to escalate.
--
-- Verify:   33_COA_REVIEW_ATOMICITY_VERIFY.sql
-- Rollback: 33_COA_REVIEW_ATOMICITY_ROLLBACK.sql
-- Preconditions: migrations 31 and 32.
-- =============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regclass('public.coa_decisions') IS NULL THEN
    RAISE EXCEPTION 'migration 33 precondition failed: apply migration 31 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'coa_extracted_fields_no_update_delete') THEN
    RAISE EXCEPTION 'migration 33 precondition failed: apply migration 32 first';
  END IF;
END
$precondition$;

-- -----------------------------------------------------------------------------
-- 1. FINDING A — refuse loudly, even when RLS matches no rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_coa_immutable_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    '%: this table is append-only; % is not permitted. '
    'Records here are audit evidence and cannot be rewritten or removed.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

-- acl-no-grant: refuse_coa_immutable_statement
REVOKE EXECUTE ON FUNCTION public.refuse_coa_immutable_statement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_coa_immutable_statement() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refuse_coa_immutable_statement() FROM authenticated;

DROP TRIGGER IF EXISTS coa_decisions_stmt_immutable ON public.coa_decisions;
CREATE TRIGGER coa_decisions_stmt_immutable
  BEFORE UPDATE OR DELETE ON public.coa_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_coa_immutable_statement();

DROP TRIGGER IF EXISTS coa_extracted_fields_stmt_immutable ON public.coa_extracted_fields;
CREATE TRIGGER coa_extracted_fields_stmt_immutable
  BEFORE UPDATE OR DELETE ON public.coa_extracted_fields
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_coa_immutable_statement();

DROP TRIGGER IF EXISTS coa_findings_stmt_immutable ON public.coa_findings;
CREATE TRIGGER coa_findings_stmt_immutable
  BEFORE UPDATE OR DELETE ON public.coa_findings
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_coa_immutable_statement();

-- -----------------------------------------------------------------------------
-- 2. FINDING B — one transaction for the decision and its audit event.
--
-- SECURITY DEFINER so both writes land under one identity, but it re-checks
-- public.is_ddp_admin() FIRST and always uses auth.uid() as the actor, so it
-- grants no capability the caller did not already have.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_coa_decision(
  p_coa_document_id  UUID,
  p_decision         TEXT,
  p_previous_state   TEXT,
  p_note             TEXT,
  p_evidence_version TEXT,
  p_source_version_id UUID DEFAULT NULL,
  p_suggestion_id     UUID DEFAULT NULL
)
RETURNS public.coa_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_decision public.coa_decisions;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'record_coa_decision: no authenticated caller';
  END IF;

  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'record_coa_decision: administrator access is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.coa_documents WHERE id = p_coa_document_id) THEN
    RAISE EXCEPTION 'record_coa_decision: COA document % does not exist', p_coa_document_id;
  END IF;

  INSERT INTO public.coa_decisions (
    coa_document_id, source_version_id, suggestion_id, decision,
    previous_state, resulting_state, note, evidence_version, decided_by
  ) VALUES (
    p_coa_document_id, p_source_version_id, p_suggestion_id, p_decision,
    p_previous_state, p_decision, coalesce(p_note, ''), p_evidence_version, v_actor
  )
  RETURNING * INTO v_decision;

  -- Same transaction: a decision can never exist without its audit event.
  INSERT INTO public.compliance_audit_log (
    actor_type, actor_id, action, entity_type, entity_id,
    before_state, after_state, reason, evidence_version, source_version_id
  ) VALUES (
    'admin', v_actor, 'coa_decision_recorded', 'coa', p_coa_document_id::text,
    jsonb_build_object('state', p_previous_state),
    jsonb_build_object('state', p_decision),
    nullif(coalesce(p_note, ''), ''), p_evidence_version, p_source_version_id
  );

  RETURN v_decision;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_coa_decision(UUID, TEXT, TEXT, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_coa_decision(UUID, TEXT, TEXT, TEXT, TEXT, UUID, UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_coa_decision(UUID, TEXT, TEXT, TEXT, TEXT, UUID, UUID) TO authenticated;

COMMIT;
