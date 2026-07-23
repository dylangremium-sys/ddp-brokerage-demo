-- =============================================================================
-- 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_ROLLBACK.sql
-- =============================================================================
-- Reverses ONLY migration 25. It removes the BEFORE INSERT actor-stamp trigger
-- and its function, restoring the pre-migration behaviour (client-supplied
-- actor_id). It touches no other object: the append-only trigger, the RLS
-- policies and the table itself all belong to migration 9 and are untouched.
--
-- NOTE: rolling this back RE-OPENS the audit-provenance forgery this migration
-- closes (a DDP admin could again attribute an entry to another user). Only roll
-- back a failed deployment of THIS migration.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS compliance_audit_log_set_actor ON public.compliance_audit_log;
DROP FUNCTION IF EXISTS public.fn_compliance_audit_log_set_actor();

COMMIT;
