-- 12_PUBLIC_FUNCTION_EXECUTE_ROLLBACK.sql
-- Rollback for 12_PUBLIC_FUNCTION_EXECUTE_HARDENING.sql.
--
-- STATUS: Committed and pushed. Rollback for an applied migration; staging-tested
--         and NOT run in production. Repository commit:
--         e4a952c614c9eba99828773d9f9b0c10f485d643.
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

-- prevent_compliance_audit_log_mutation() is the one exception to the
-- service_role line above, and deliberately gets NO grant back.
--
-- Migration 11 exists precisely to "remove the unnecessary direct EXECUTE on its
-- trigger-only guard function", and revokes it from PUBLIC, anon and
-- authenticated while granting it to nobody -- a trigger fires as the table
-- owner and needs no EXECUTE granted to any client role. Re-granting service_role
-- here would undo migration 11 as a side effect of rolling back migration 12,
-- leaving a posture no migration in this repository ever established.
--
-- The captured baseline in the header above records service_role=true for this
-- function, but nothing in migrations 9 or 11 (which create and then harden it)
-- grants that, so the measurement cannot have been of a clean pre-12 state.
-- Proven by scripts/disposable-pg fixture 12_public_function_execute: with the
-- grant present the rollback ended one privilege richer than its baseline.
-- service_role is in this REVOKE list and in no other: the HARDENING granted it,
-- so leaving it out means the rollback exits 0 having removed nothing it added.
REVOKE EXECUTE ON FUNCTION public.prevent_compliance_audit_log_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
