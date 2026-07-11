-- 12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql
-- Normalize EXECUTE privileges on the six existing DDP public functions to an
-- explicit, auditable per-function standard.
--
-- STATUS: Committed and pushed. Applied to staging and production.
--         Production verification completed: 2026-07-11.
--         Repository commit: e4a952c614c9eba99828773d9f9b0c10f485d643.
--         Rollback file available and staging-tested; not required in production.
--
-- WHY: The future-object default-privilege approach cannot suppress PostgreSQL's
--      built-in PUBLIC EXECUTE on new functions, so EXECUTE hardening must be
--      explicit per function. On the current verified baseline all six functions
--      already deny PUBLIC and anon, so this migration is a NORMALIZATION /
--      drift-correction (idempotent), not an emergency vulnerability fix.
--
-- SCOPE: EXECUTE privileges only. Makes NO change to function bodies, ownership,
--        search_path, policies, table ACLs, triggers, or default privileges.
--        Owner (postgres) keeps its implicit rights (never revoked).
--        Idempotent: REVOKE/GRANT are repeatable.
--
-- Companion files:
--   12_PUBLIC_FUNCTION_EXECUTE_VERIFY.sql   (SELECT-only checks)
--   12_PUBLIC_FUNCTION_EXECUTE_ROLLBACK.sql (reassert the captured baseline)

BEGIN;

-- ── RLS helper functions ────────────────────────────────────────────────────
-- Invoked inside RLS USING/WITH CHECK expressions, evaluated as the querying
-- role, so `authenticated` MUST retain EXECUTE. Deny PUBLIC and anon.
REVOKE EXECUTE ON FUNCTION public.is_ddp_admin() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_ddp_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.has_farm_membership(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.has_farm_membership(uuid) TO authenticated, service_role;

-- ── Trigger-only functions ──────────────────────────────────────────────────
-- Executed by their triggers as the (SECURITY DEFINER) owner regardless of the
-- caller's EXECUTE privilege, so no client role needs direct EXECUTE. Deny
-- PUBLIC, anon, and authenticated; retain service_role for operational parity.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_owner_notes() TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_review_request_fields() TO service_role;

REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() TO service_role;

COMMIT;
