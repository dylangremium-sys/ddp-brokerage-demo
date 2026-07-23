-- =============================================================================
-- 25_COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE_HARDENING.sql
-- =============================================================================
-- DDP audit finding (client-authz #3): the compliance audit log accepts a
-- CLIENT-SUPPLIED actor_id.
--
-- public.compliance_audit_log records who did what to the compliance workflow;
-- its ENTIRE value is the integrity of that attribution. Migration 9 makes the
-- table append-only (compliance_audit_log_no_update_delete) and admin-only to
-- INSERT ("compliance_audit_log: admin insert" → is_ddp_admin()). But the INSERT
-- policy only checks that the CALLER is an admin — it does NOT pin the stored
-- actor_id. The column has no DEFAULT, and the client (src/lib/complianceRepository
-- .ts:buildAuditLogInsertPayload → insertAuditLog) sends actor_id from browser
-- state. A DDP admin (or anything calling the REST/RPC surface with an admin JWT)
-- can therefore write an append-only audit entry ATTRIBUTED TO ANY OTHER USER —
-- forging provenance in the one record whose worth is that it cannot be forged.
--
-- FIX (server-authoritative, fail-closed): a BEFORE INSERT trigger forces
--   actor_id := auth.uid()
-- so the stored actor is ALWAYS the authenticated caller, never a client value.
-- This mirrors the established pattern in migration 19 (fn_protect_farm_admin_
-- fields forces created_by := auth.uid()) and procurement_decisions (decided_by =
-- auth.uid()). It OVERRIDES rather than REJECTS: every legitimate insert — the app
-- already passes the caller's own id — keeps working, while a forged or NULL
-- actor_id can never be persisted. Only an admin can insert (RLS unchanged), so
-- auth.uid() is always the real, accountable admin.
--
-- Scope: adds ONE trigger function + ONE BEFORE INSERT trigger. It changes no
-- policy, no grant on the table, no other object. actor_TYPE is left to the app
-- (it describes the KIND of action); only the identity is made authoritative.
-- =============================================================================

BEGIN;

-- Trigger function: stamp the authenticated caller as the actor. SECURITY INVOKER
-- (least privilege — it needs no elevated rights; it only reads auth.uid() from
-- the request JWT and writes NEW). search_path pinned so it is not a definer-style
-- escalation vector even though it is invoker.
CREATE OR REPLACE FUNCTION public.fn_compliance_audit_log_set_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  -- Server-authoritative attribution: ignore any client-supplied actor_id and
  -- record the authenticated caller. NULL only if there is genuinely no JWT
  -- (e.g. a service_role/system path), which cannot be an admin forging a peer.
  NEW.actor_id := auth.uid();
  RETURN NEW;
END;
$$;

-- Defence-in-depth: the trigger fires as part of the INSERT regardless of EXECUTE
-- grants, so revoke direct callability from every client role (Supabase default-
-- grants EXECUTE on new public functions to authenticated).
-- This is a TRIGGER-ONLY function — it is never called directly, so it takes no
-- GRANT. Explicit no-grant decision (repository ACL rule §13/§14):
--   acl-no-grant: fn_compliance_audit_log_set_actor
REVOKE EXECUTE ON FUNCTION public.fn_compliance_audit_log_set_actor() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS compliance_audit_log_set_actor ON public.compliance_audit_log;
CREATE TRIGGER compliance_audit_log_set_actor
  BEFORE INSERT ON public.compliance_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_compliance_audit_log_set_actor();

COMMIT;
