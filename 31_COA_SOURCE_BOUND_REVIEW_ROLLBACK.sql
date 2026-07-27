-- =============================================================================
-- Migration 31 — ROLLBACK (Source-bound COA review)
--
-- Removes everything migration 31 created and restores the compliance_audit_log
-- action CHECK to its migration-9 vocabulary.
--
-- DESTRUCTIVE. COA extractions, findings, retrieved source versions, bound
-- suggestions and — most importantly — administrator DECISIONS are review
-- records. Decisions in particular are append-only by design, so dropping them
-- destroys an audit trail that cannot be reconstructed. This script therefore
-- REFUSES to run while any such data exists, unless the operator explicitly
-- opts in within the same transaction:
--
--     SET LOCAL coa_review.rollback_destructive = 'true';
--
-- Rolling back also requires that no audit-log row still references a source
-- version; those references are cleared (set to NULL) rather than deleted, so
-- the audit events themselves survive the rollback.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 31_COA_SOURCE_BOUND_REVIEW_ROLLBACK.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Refuse to destroy live review data unless explicitly authorized.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
  document_count   integer := 0;
  decision_count   integer := 0;
  suggestion_count integer := 0;
  opt_in           text;
BEGIN
  IF to_regclass('public.coa_documents') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.coa_documents' INTO document_count;
  END IF;
  IF to_regclass('public.coa_decisions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.coa_decisions' INTO decision_count;
  END IF;
  IF to_regclass('public.coa_suggestions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.coa_suggestions' INTO suggestion_count;
  END IF;

  IF document_count > 0 OR decision_count > 0 OR suggestion_count > 0 THEN
    BEGIN
      opt_in := current_setting('coa_review.rollback_destructive');
    EXCEPTION WHEN undefined_object THEN
      opt_in := NULL;
    END;

    IF opt_in IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION
        'rollback 31 refused: % COA document(s), % suggestion(s) and % administrator decision(s) exist. '
        'Administrator decisions are append-only review records and cannot be reconstructed once dropped. '
        'To proceed deliberately, run '
        'SET LOCAL coa_review.rollback_destructive = ''true''; in the same transaction.',
        document_count, suggestion_count, decision_count;
    END IF;

    RAISE NOTICE
      'rollback 31: destructive opt-in acknowledged — removing % document(s), % suggestion(s) and % decision(s).',
      document_count, suggestion_count, decision_count;
  END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 1. Detach the audit log from migration-31 objects, preserving the events.
--
-- The FK is dropped and the column values cleared BEFORE the referenced table
-- is dropped, so audit rows written by migration 31 survive the rollback with
-- their actor, action, states and timestamps intact.
-- -----------------------------------------------------------------------------
ALTER TABLE public.compliance_audit_log
  DROP CONSTRAINT IF EXISTS compliance_audit_log_source_version_fkey;

DO $clear_refs$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='compliance_audit_log' AND column_name='source_version_id'
  ) THEN
    EXECUTE 'UPDATE public.compliance_audit_log SET source_version_id = NULL WHERE source_version_id IS NOT NULL';
  END IF;
END
$clear_refs$;

-- -----------------------------------------------------------------------------
-- 2. Restore the migration-9 action vocabulary.
--
-- Any audit row carrying a migration-31 action would violate the narrowed
-- constraint, so those rows are rewritten to the closest migration-9 action
-- ('document_status_changed') rather than deleted — again, the event survives.
-- -----------------------------------------------------------------------------
DO $restore_actions$
DECLARE
  constraint_name text;
  rewritten integer := 0;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.compliance_audit_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%legal_update_created%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.compliance_audit_log DROP CONSTRAINT %I', constraint_name);
  END IF;

  UPDATE public.compliance_audit_log
  SET action = 'document_status_changed'
  WHERE action IN (
    'coa_document_extracted', 'coa_extraction_failed', 'coa_findings_recorded',
    'coa_source_retrieved', 'coa_source_retrieval_failed', 'coa_suggestion_bound',
    'coa_suggestion_quarantined', 'coa_suggestion_rejected', 'coa_decision_recorded'
  );
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten > 0 THEN
    RAISE NOTICE 'rollback 31: rewrote % audit action(s) to document_status_changed.', rewritten;
  END IF;

  ALTER TABLE public.compliance_audit_log
    ADD CONSTRAINT compliance_audit_log_action_check CHECK (action IN (
      'legal_update_created',
      'legal_update_reviewed',
      'rule_suggested',
      'rule_approved',
      'rule_paused',
      'rule_retired',
      'alert_created',
      'alert_resolved',
      'readiness_status_changed',
      'document_status_changed',
      'sent_to_legal_review',
      'reviewer_note_added',
      'rule_rejected',
      'legal_update_archived',
      'alert_dismissed'
    ));
END
$restore_actions$;

ALTER TABLE public.compliance_audit_log
  DROP COLUMN IF EXISTS evidence_version,
  DROP COLUMN IF EXISTS source_version_id;

-- -----------------------------------------------------------------------------
-- 3. Drop migration-31 triggers, functions and tables.
--
-- The append-only trigger on coa_decisions blocks DELETE, so it must be removed
-- before the table can be dropped. DROP TABLE itself is not blocked by the
-- row-level trigger, but the trigger is dropped first for clarity and so that a
-- partial rollback cannot leave an orphaned guard behind.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS coa_decisions_no_update_delete ON public.coa_decisions;
DROP TRIGGER IF EXISTS coa_suggestions_enforce_binding ON public.coa_suggestions;

DROP FUNCTION IF EXISTS public.prevent_coa_decision_mutation();
DROP FUNCTION IF EXISTS public.enforce_coa_suggestion_source_binding();

-- Child-to-parent order so no FK blocks the drop.
DROP TABLE IF EXISTS public.coa_decisions;
DROP TABLE IF EXISTS public.coa_suggestions;
DROP TABLE IF EXISTS public.coa_findings;
DROP TABLE IF EXISTS public.coa_extracted_fields;
DROP TABLE IF EXISTS public.coa_source_versions;
DROP TABLE IF EXISTS public.coa_documents;

COMMIT;
