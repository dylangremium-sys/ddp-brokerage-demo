-- ===========================================================================
-- 30_PROCUREMENT_OVERRIDES_SERVER_AUTHORITATIVE_HARDENING.sql
-- ---------------------------------------------------------------------------
-- Gives the RISK-STATUS and REQUIREMENT-STATUS overrides a server-side,
-- append-only, actor-attributed home — the same treatment migration 17 gave the
-- procurement decision.
--
-- STATUS — BY ENVIRONMENT (never state "applied" without naming the environment):
--   • Repository : committed and reviewed.
--   • STAGING    : NOT applied. NOT run.
--   • PRODUCTION : NOT applied. NOT run. NOT deployed. A production change freeze
--                  is active (docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md); this
--                  migration is NOT part of any authorised break-glass change.
--
-- WHY (audit finding F2)
-- ----------------------
-- The release gate has two halves. `hasBlockingIssues` is
--   blockerRequirements.length > 0 || unresolvedRisks.some(r => r.severity === 'blocker')
-- (src/pages/admin/DDPBuyerPreview.tsx:89-92), and BOTH inputs are overridable by
-- an operator. The DECISION half of that same invariant is append-only,
-- server-side and auth.uid()-bound (migration 17). The OVERRIDE half was not:
--
--   • `ddp_risk_overrides` and `ddp_requirement_overrides` write straight to
--     localStorage (src/lib/procurementControl.ts:161-165, :321-325), NOT gated
--     by shouldPersistToBrowser() — so this happens in Supabase mode too.
--   • Both keys are in SENSITIVE_DDP_KEYS (src/lib/browserPersistence.ts:47-48),
--     which signOut() wipes (src/services/auth.ts:70-76).
--
-- Consequences, all live before this migration: admin A's clearances are
-- invisible to admin B; every clearance silently reverts at sign-out; there is no
-- actor, timestamp or reason behind a decision that gates controlled-substance
-- disclosure; and the values are settable from devtools by the very person the
-- record is meant to hold accountable.
--
-- WHAT
--   • public.risk_overrides         — append-only, one row per override event.
--   • public.requirement_overrides  — append-only, one row per override event.
--   • Mandatory actor (decided_by, server-captured from auth.uid()).
--   • Mandatory reason. An override without a reason is not an audit record —
--     the same standard migration 17 set for the decision.
--   • History is preserved: re-overriding appends. The current value is the
--     newest row per key (views: *_current).
--
-- KEY DESIGN (mirrors the client's own composite keys)
--   • risk_overrides.risk_id       TEXT — the CONTENT-BOUND risk id produced by
--     composeRiskId() (src/lib/procurementControl.ts). After the F1a fix this is
--     `risk-batch-<id>#<fingerprint>`, so an override recorded against superseded
--     risk content simply no longer matches any live risk and is inert. That
--     property is the client's, and this table preserves it rather than
--     re-deriving it: storing a bare batch id here would REINTRODUCE F1a
--     server-side, which is precisely the defect being closed.
--   • requirement_overrides is keyed on (farm_id, requirement_type), matching
--     requirementOverrideKey() — `${farmId}::${type}`, split into two columns so
--     the pair is queryable and indexable.
--
-- TEXT, not UUID FK, for the same reason migration 17 uses TEXT batch_id: an
-- override can be recorded for an entity that exists only client-side in demo
-- mode, and the client store must behave identically either way.
--
-- SAFETY
--   • Additive only. Creates two new tables, two triggers, two views. Touches no
--     existing table, policy, function, or column.
--   • Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
--   • Paired with 30_..._VERIFY.sql and 30_..._ROLLBACK.sql, matching the
--     convention used by migrations 10-17 and 23.
--   • The application feature-detects these tables and falls back to its existing
--     localStorage behaviour if they are absent (42P01/PGRST205 only), so
--     applying this migration is safe to do BEFORE or AFTER the app deploy.
--
-- MIGRATION NUMBER
-- ----------------
-- Numbered 30 because 27_* and 28_* are claimed on unmerged branches and 29_* is
-- this remediation's contaminant-blocker gate. Verified with
-- scripts/check-migration-numbers.mjs and
-- scripts/audit-001-check-migration-collisions.mjs, which compare across refs
-- rather than main alone. Depends only on public.profiles and auth.uid().
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.risk_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The CONTENT-BOUND risk id (composeRiskId): `risk-batch-<id>#<fingerprint>`
  -- or `risk-farm-<id>-<kind>#<fingerprint>`. Storing the composed id — rather
  -- than a bare entity id — is what keeps an override from surviving a change in
  -- the risk it cleared. See the KEY DESIGN note above.
  risk_id       TEXT NOT NULL CHECK (length(btrim(risk_id)) > 0),
  -- The four values the operator UI offers (src/types.ts RiskStatus, rendered
  -- from STATUS_OPTIONS at DDPRiskRegister.tsx). Every option a user can select
  -- must be persistable; a narrower CHECK would reject one at the database and
  -- lose the override.
  status        TEXT NOT NULL CHECK (status IN ('open', 'in_review', 'resolved', 'accepted')),
  -- An override with no stated reason is not an audit record. Enforced, not hoped
  -- for — the same bar migration 17 set for the procurement decision.
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  owner         TEXT,
  -- AUTHORITATIVE actor identity, captured server-side. Never client-supplied.
  decided_by    UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.requirement_overrides (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- (farm_id, requirement_type) is requirementOverrideKey()'s `${farmId}::${type}`
  -- split into two columns, so the pair is queryable and indexable.
  farm_id           TEXT NOT NULL CHECK (length(btrim(farm_id)) > 0),
  requirement_type  TEXT NOT NULL CHECK (length(btrim(requirement_type)) > 0),
  -- src/types.ts EvidenceStatus. 'rejected' and 'expired' are the two the release
  -- gate counts as blocking (DDPBuyerPreview.tsx:87), so they must be recordable.
  status            TEXT NOT NULL CHECK (status IN (
                      'missing', 'claimed', 'documented', 'reviewed', 'verified',
                      'rejected', 'expired')),
  reason            TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  notes             TEXT,
  decided_by        UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_overrides_risk
  ON public.risk_overrides (risk_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_overrides_actor
  ON public.risk_overrides (decided_by);
CREATE INDEX IF NOT EXISTS idx_requirement_overrides_key
  ON public.requirement_overrides (farm_id, requirement_type, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_overrides_actor
  ON public.requirement_overrides (decided_by);

-- ---------------------------------------------------------------------------
-- 2. Append-only enforcement
-- ---------------------------------------------------------------------------
-- Same posture as compliance_audit_log (11_*) and procurement_decisions (17_*):
-- the row may be inserted and read, never updated or deleted. History is the
-- point — "who cleared this blocker, when, and why" must survive being reversed.
CREATE OR REPLACE FUNCTION public.prevent_risk_override_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'risk_overrides is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_risk_override_mutation ON public.risk_overrides;
CREATE TRIGGER trg_prevent_risk_override_mutation
BEFORE UPDATE OR DELETE ON public.risk_overrides
FOR EACH ROW EXECUTE FUNCTION public.prevent_risk_override_mutation();

CREATE OR REPLACE FUNCTION public.prevent_requirement_override_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'requirement_overrides is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_requirement_override_mutation ON public.requirement_overrides;
CREATE TRIGGER trg_prevent_requirement_override_mutation
BEFORE UPDATE OR DELETE ON public.requirement_overrides
FOR EACH ROW EXECUTE FUNCTION public.prevent_requirement_override_mutation();

-- ---------------------------------------------------------------------------
-- 3. RLS — admin-only, insert + select, no update/delete path at all
-- ---------------------------------------------------------------------------
ALTER TABLE public.risk_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requirement_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_overrides: admin select" ON public.risk_overrides;
CREATE POLICY "risk_overrides: admin select"
  ON public.risk_overrides FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

-- WITH CHECK pins decided_by to the caller: an admin cannot attribute an
-- override to another admin. The column DEFAULT supplies auth.uid(); this
-- asserts it.
DROP POLICY IF EXISTS "risk_overrides: admin insert" ON public.risk_overrides;
CREATE POLICY "risk_overrides: admin insert"
  ON public.risk_overrides FOR INSERT
  TO authenticated
  WITH CHECK (public.is_ddp_admin() AND decided_by = auth.uid());

DROP POLICY IF EXISTS "requirement_overrides: admin select" ON public.requirement_overrides;
CREATE POLICY "requirement_overrides: admin select"
  ON public.requirement_overrides FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

DROP POLICY IF EXISTS "requirement_overrides: admin insert" ON public.requirement_overrides;
CREATE POLICY "requirement_overrides: admin insert"
  ON public.requirement_overrides FOR INSERT
  TO authenticated
  WITH CHECK (public.is_ddp_admin() AND decided_by = auth.uid());

-- No UPDATE or DELETE policy is created. With RLS enabled and no permissive
-- policy for those commands, they are denied for every non-superuser role even
-- before the append-only triggers fire. Defence in depth, matching 11_* and 17_*.

-- ---------------------------------------------------------------------------
-- 4. Current-value views (newest row wins)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.risk_overrides_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (risk_id)
  risk_id, status, reason, owner, decided_by, decided_at
FROM public.risk_overrides
ORDER BY risk_id, decided_at DESC;

CREATE OR REPLACE VIEW public.requirement_overrides_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (farm_id, requirement_type)
  farm_id, requirement_type, status, reason, notes, decided_by, decided_at
FROM public.requirement_overrides
ORDER BY farm_id, requirement_type, decided_at DESC;

-- ---------------------------------------------------------------------------
-- 5. Explicit privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.risk_overrides FROM PUBLIC, anon;
REVOKE ALL ON public.requirement_overrides FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.risk_overrides TO authenticated;
GRANT SELECT, INSERT ON public.requirement_overrides TO authenticated;
-- Supabase GRANTs CRUD on new public tables to `authenticated` by default, so the
-- GRANTs above do not narrow anything: table-level UPDATE and DELETE survive them.
-- RLS (no UPDATE/DELETE policy) and the append-only triggers both still deny the
-- write, but leaving the privilege in place contradicts this migration's own
-- append-only claim and fails V6 of 30_..._VERIFY.sql. Revoked explicitly, exactly
-- as 15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql:60 and 17_..._MVP.sql do.
REVOKE UPDATE, DELETE ON public.risk_overrides FROM authenticated;
REVOKE UPDATE, DELETE ON public.requirement_overrides FROM authenticated;
REVOKE ALL ON public.risk_overrides_current FROM PUBLIC, anon;
REVOKE ALL ON public.requirement_overrides_current FROM PUBLIC, anon;
GRANT SELECT ON public.risk_overrides_current TO authenticated;
GRANT SELECT ON public.requirement_overrides_current TO authenticated;

-- Trigger-only functions: they must fire from their triggers and be callable by
-- NOBODY directly. No GRANT follows, deliberately — see migration 12 for the same
-- posture applied to prevent_compliance_audit_log_mutation().
-- acl-no-grant: prevent_risk_override_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_risk_override_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_risk_override_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_risk_override_mutation() FROM authenticated;
-- acl-no-grant: prevent_requirement_override_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_requirement_override_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_requirement_override_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_requirement_override_mutation() FROM authenticated;

commit;
