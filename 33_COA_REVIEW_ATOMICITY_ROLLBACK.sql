-- =============================================================================
-- Migration 33 — ROLLBACK (atomicity & loud refusals)
--
-- Reopens two accepted-risk findings: tamper attempts become silent again, and
-- the decision/audit pair stops being atomic. Non-destructive: no row deleted.
-- =============================================================================
BEGIN;

DROP TRIGGER IF EXISTS coa_decisions_stmt_immutable ON public.coa_decisions;
DROP TRIGGER IF EXISTS coa_extracted_fields_stmt_immutable ON public.coa_extracted_fields;
DROP TRIGGER IF EXISTS coa_findings_stmt_immutable ON public.coa_findings;

DROP FUNCTION IF EXISTS public.refuse_coa_immutable_statement();
DROP FUNCTION IF EXISTS public.record_coa_decision(UUID, TEXT, TEXT, TEXT, TEXT, UUID, UUID);

COMMIT;
