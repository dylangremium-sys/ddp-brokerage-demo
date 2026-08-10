-- =============================================================================
-- 63_STATUS_HISTORY_APPEND_ONLY_HARDENING.sql
--
-- Makes status_history append-only and attributed.
--
-- WHAT IS ACTUALLY WRONG — measured against production
--
--   status_history        triggers: 0    actor column: none
--   compliance_audit_log  triggers: 2
--   commercial_audit_log  triggers: 2
--
-- status_history is the only log table with NO protective trigger and NO actor
-- column. Two consequences, and it is worth being exact about which:
--
--   1. A DDP ADMINISTRATOR can rewrite or delete any row. The permissive policy
--      "status_history: admin all" is FOR ALL USING is_ddp_admin(), so UPDATE
--      and DELETE are open to exactly the people the trail exists to hold to
--      account. Nothing records that they did it.
--
--   2. ANY ROLE THAT BYPASSES RLS can do the same, plus TRUNCATE. `service_role`
--      bypasses RLS by design, and relforcerowsecurity is false so the table
--      owner does too. No policy can reach either of them. A trigger can.
--
-- WHAT IS NOT WRONG, recorded because it looks wrong and is not:
-- `authenticated` holds arwd on this table, which reads alarmingly next to the
-- sibling logs' `r` and `ar`. It is not exploitable. The RLS policy
-- "status_history: operational farmer or admin" is **RESTRICTIVE** — created
-- that way by migration 22 — and a restrictive policy only ever narrows access,
-- never grants it. The only PERMISSIVE policy admitting UPDATE or DELETE is the
-- admin one. So a farmer holding the privilege still has no permissive policy
-- to act through, and cannot touch a row.
--
--   Do not "fix" that restrictive policy by widening it, and do not add a
--   permissive farmer policy here. Dropping a RESTRICTIVE policy REMOVES a
--   restriction; adding a permissive INSERT policy would GRANT farmers access
--   they do not have today. Either would be a privilege expansion wearing a
--   hardening migration's clothes.
--
-- So this migration changes the privilege layer only as belt-and-braces, and
-- puts the real guarantee in triggers, which bind every role including the ones
-- RLS cannot see.
--
-- WHY THIS IS SAFE TO TIGHTEN NOW
-- Nothing in the application writes or reads status_history: the 2026-08-06
-- audit measured 0 code references and production holds 4 rows. So this cannot
-- regress a live path — it sets the contract before the table is wired up,
-- which is the cheap order to do it in.
-- =============================================================================

BEGIN;

-- ── 1. Attribution ──────────────────────────────────────────────────────────
-- Nullable: the 4 existing rows predate attribution, and inventing an actor for
-- them would be fabricating an audit record — the exact failure this migration
-- exists to prevent. They stay honestly NULL.
ALTER TABLE public.status_history
  ADD COLUMN IF NOT EXISTS changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.status_history.changed_by IS
  'The authenticated user who caused this status change, forced from auth.uid() by fn_status_history_set_actor (migration 63). NULL only for rows predating migration 63, or for trusted server-side writes with no session.';

-- ── 2. The actor cannot be chosen by the caller ─────────────────────────────
-- OVERWRITES rather than defaults. A column DEFAULT is silently replaceable by
-- any caller supplying the column, which would let one admin attribute an edit
-- to another. A forged audit row is worse than an unattributed one.
--
-- When auth.uid() IS NULL there is no session to attribute to, so a trusted
-- server-side writer keeps whatever it supplied, including NULL. An end user
-- always has a session and is therefore always overwritten.
CREATE OR REPLACE FUNCTION public.fn_status_history_set_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.changed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS status_history_set_actor ON public.status_history;
CREATE TRIGGER status_history_set_actor
  BEFORE INSERT ON public.status_history
  FOR EACH ROW EXECUTE FUNCTION public.fn_status_history_set_actor();

-- ── 3. Append-only, enforced by trigger — THE REAL CHANGE ───────────────────
-- Same shape as prevent_commercial_audit_log_mutation. This is what closes the
-- gap: it binds the admin whom the policy admits, and service_role and the
-- table owner whom no policy can reach.
CREATE OR REPLACE FUNCTION public.prevent_status_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'status_history is append-only; attempted % is not allowed.', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS status_history_no_update_delete ON public.status_history;
CREATE TRIGGER status_history_no_update_delete
  BEFORE DELETE OR UPDATE ON public.status_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_status_history_mutation();

-- TRUNCATE needs its own statement-level trigger: a row-level trigger never
-- fires for it, so a table guarded only by the first is still emptiable in one
-- statement by any role that bypasses RLS.
DROP TRIGGER IF EXISTS status_history_no_truncate ON public.status_history;
CREATE TRIGGER status_history_no_truncate
  BEFORE TRUNCATE ON public.status_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_status_history_mutation();

-- ── 4. Privilege layer — belt and braces, NOT the fix ───────────────────────
-- RLS already leaves `authenticated` no permissive route to UPDATE or DELETE
-- (see the header). Revoking makes the grant match the intent, so a grant dump
-- stops reading like a hole, and gives the trigger a second layer under it.
-- Stated as secondary on purpose: describing this as the security fix would
-- misrepresent what was exposed.
REVOKE UPDATE, DELETE ON public.status_history FROM authenticated;

-- ── 5. EXECUTE ACLs on the two trigger-only functions ───────────────────────
-- Neither function is ever called directly. PostgreSQL invokes a trigger
-- function through the trigger mechanism, which does not check EXECUTE at all,
-- so no role needs the privilege for the guards to work. Both are SECURITY
-- DEFINER, so a grant would hand out a definer-rights entry point in exchange
-- for nothing.
--
-- Same treatment migration 11 gives prevent_compliance_audit_log_mutation. A
-- REVOKE of a grant that does not exist is a harmless no-op, so this is
-- idempotent.
--
-- acl-no-grant: fn_status_history_set_actor
-- acl-no-grant: prevent_status_history_mutation
REVOKE EXECUTE ON FUNCTION public.fn_status_history_set_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_status_history_set_actor() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_status_history_set_actor() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_status_history_set_actor() FROM service_role;

REVOKE EXECUTE ON FUNCTION public.prevent_status_history_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_status_history_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_status_history_mutation() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_status_history_mutation() FROM service_role;

-- ── 6. Policies are deliberately UNCHANGED ──────────────────────────────────
-- The RESTRICTIVE overlay from migration 22 stays exactly as it is, and no new
-- permissive policy is added. See the header for why touching either would be a
-- privilege expansion rather than hardening.

COMMENT ON TABLE public.status_history IS
  'Append-only status trail. UPDATE, DELETE and TRUNCATE are refused by trigger for EVERY role, including ddp_admin, service_role and the table owner — the roles RLS cannot restrain. Actor is forced from auth.uid(). Hardened by migration 63.';

COMMIT;
