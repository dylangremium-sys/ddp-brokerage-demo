-- 11_COMPLIANCE_AUDIT_LOG_TRUNCATE_ROLLBACK.sql
-- Rollback for 11_COMPLIANCE_AUDIT_LOG_TRUNCATE_HARDENING.sql.
--
-- STATUS: PREPARED — NOT APPLIED. NOT RUN. NOT COMMITTED. NOT DEPLOYED.
--         Run by hand only as a deliberate, approved undo of migration #11.
--
-- This rollback reverses EXACTLY and ONLY what migration #11 changed:
--   1. drops the statement-level TRUNCATE guard trigger it added;
--   2. restores EXECUTE on the guard function to its prior effective state.
--
-- It does NOT touch the existing row-level UPDATE/DELETE guard trigger
-- (compliance_audit_log_no_update_delete), any RLS policy, row-security flags,
-- table privileges, table ownership, any managed schema, or the unapplied
-- draft migration #10 objects.
--
-- NOTE on the EXECUTE restore: migration #11 revoked EXECUTE from PUBLIC, anon,
-- and authenticated. Granting EXECUTE back TO PUBLIC restores broad callable
-- access, which — because PUBLIC includes anon and authenticated — is
-- functionally equivalent to the prior verified state (anon = true,
-- authenticated = true). No redundant per-role GRANTs are added. service_role
-- was never revoked and is unaffected.

BEGIN;

-- 1. Remove the TRUNCATE guard added by migration #11.
DROP TRIGGER IF EXISTS compliance_audit_log_no_truncate ON public.compliance_audit_log;

-- 2. Restore prior EXECUTE reachability on the guard function.
GRANT EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() TO PUBLIC;

COMMIT;
