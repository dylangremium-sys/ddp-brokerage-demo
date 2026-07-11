-- 12_PUBLIC_FUNCTION_EXECUTE_ROLLBACK.sql
-- Rollback for 12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql.
--
-- STATUS: PREPARED — NOT COMMITTED. NOT PUSHED. Staging only.
--
-- The verified pre-change baseline already equals the hardened target ACLs, so
-- this rollback RESTORES that exact captured baseline — it is a reassertion of
-- the same explicit EXECUTE ACLs, NOT a broad grant restoration. It does NOT
-- grant PUBLIC or anon, does NOT grant authenticated to trigger-only functions,
-- and changes no other property (body, owner, search_path, policies, tables).
--
-- Captured baseline being restored (staging == production):
--   RLS helpers (is_ddp_admin, has_farm_membership):
--     PUBLIC=false anon=false authenticated=true service_role=true postgres=owner
--   Trigger-only (handle_new_user, fn_protect_owner_notes,
--                 fn_protect_review_request_fields,
--                 prevent_compliance_audit_log_mutation):
--     PUBLIC=false anon=false authenticated=false service_role=true postgres=owner

BEGIN;

-- RLS helpers — restore explicit baseline (authenticated retained).
REVOKE EXECUTE ON FUNCTION public.is_ddp_admin() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_ddp_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.has_farm_membership(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.has_farm_membership(uuid) TO authenticated, service_role;

-- Trigger-only — restore explicit baseline (service_role only).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_protect_owner_notes() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_owner_notes() TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_protect_review_request_fields() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_protect_review_request_fields() TO service_role;

REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation() TO service_role;

COMMIT;
