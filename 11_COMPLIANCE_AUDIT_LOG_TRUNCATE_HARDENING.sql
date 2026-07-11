-- 11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql
-- Harden public.compliance_audit_log against TRUNCATE, and remove the
-- unnecessary direct EXECUTE on its trigger-only guard function.
--
-- STATUS: PREPARED — NOT APPLIED. NOT RUN. NOT COMMITTED. NOT DEPLOYED.
--         Apply by hand in the Supabase SQL editor, staging first, only after
--         review. Companion files:
--           11_COMPLIANCE_AUDIT_LOG_TRUNCATE_VERIFY.sql   (SELECT-only checks)
--           11_COMPLIANCE_AUDIT_LOG_TRUNCATE_ROLLBACK.sql (undo this file only)
--
-- WHY THIS IS NEEDED (verified from owner-supplied live catalog output):
--   * compliance_audit_log has a BEFORE UPDATE OR DELETE, FOR EACH ROW trigger
--     (compliance_audit_log_no_update_delete) that blocks row mutation, but a
--     row-level trigger NEVER fires on TRUNCATE. TRUNCATE is currently effective
--     for anon/authenticated/service_role, so the "append-only" guarantee has a
--     TRUNCATE-shaped hole. This adds the missing statement-level guard.
--   * anon and authenticated hold DIRECT EXECUTE on the trigger-only function.
--     A trigger fires regardless of the caller's EXECUTE privilege, so no role
--     needs to call this function directly. Removing the direct grants is a
--     least-privilege tidy-up that does not affect either trigger.
--
-- SCOPE (intentionally minimal): one new trigger + one function-grant revoke.
--   Does NOT change SELECT/INSERT/UPDATE/DELETE/TRUNCATE table privileges,
--   RLS policies, row-level security flags, table ownership, the existing
--   UPDATE/DELETE trigger, any managed schema, or the unapplied draft
--   migration #10 objects.
--
-- The reused function public.prevent_compliance_audit_log_mutation() references
-- only TG_OP (no NEW / no OLD) and unconditionally RAISEs, so it is safe for a
-- statement-level BEFORE TRUNCATE trigger (verified from repo source, file 9).

BEGIN;

-- 1. Statement-level TRUNCATE guard. Idempotent (DROP IF EXISTS + CREATE).
DROP TRIGGER IF EXISTS compliance_audit_log_no_truncate ON public.compliance_audit_log;

CREATE TRIGGER compliance_audit_log_no_truncate
  BEFORE TRUNCATE ON public.compliance_audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.prevent_compliance_audit_log_mutation();

-- 2. Remove unnecessary DIRECT EXECUTE on the trigger-only function.
--    Revoke the implicit PUBLIC grant AND the explicit role grants so that
--    neither anon nor authenticated retains EXECUTE. service_role is retained
--    deliberately (out of scope for this task; may be a backend caller).
--    REVOKE of a non-existent grant is a harmless no-op, so this stays idempotent.
REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() FROM authenticated;

COMMIT;
