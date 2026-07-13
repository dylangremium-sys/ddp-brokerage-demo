-- ===========================================================================
-- 17_PROCUREMENT_DECISIONS_MVP.sql
-- ---------------------------------------------------------------------------
-- Gives the batch release decision a server-side, append-only home.
--
-- WHY
-- The procurement decision — the human judgement that authorises a buyer pack
-- for a controlled-substance batch — is currently stored ONLY in the operator's
-- browser (src/lib/procurementControl.ts:340-359, key 'ddp_procurement_decisions').
-- It carries no actor, no reason, and no server row. It is editable from devtools
-- by the very person it is meant to hold accountable, and it is destroyed by a
-- cache clear.
--
-- It also cannot record a rejection. buyer_pack_snapshots.procurement_decision is
-- CHECK (procurement_decision = 'progress') (10_BUYER_PACK_SNAPSHOTS_MVP.sql:59) —
-- correct for a snapshot (you only snapshot a pack you are releasing), but it
-- means the schema can currently record a YES and never a NO. A rejection is
-- precisely the record a regulator or a rejected farmer will ask for.
--
-- WHAT
--   • public.procurement_decisions — append-only, one row per decision event.
--   • Mandatory actor (decided_by, server-captured from auth.uid()).
--   • Mandatory reason. A decision without a reason is not an audit record.
--   • decision ∈ the seven values the operator UI offers (src/types.ts:38-45) —
--     a NO ('reject'/'hold') can finally be recorded, and the four evidence-
--     request decisions the UI has always offered remain persistable.
--   • History is preserved: re-deciding appends a new row. The current decision
--     is the newest row per batch (view: procurement_decisions_current).
--
-- SAFETY
--   • Additive only. Creates one new table, one trigger, one view. Touches no
--     existing table, policy, function, or column.
--   • Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
--   • Paired with 17_..._VERIFY.sql and 17_..._ROLLBACK.sql, matching the
--     convention used by migrations 10-15.
--   • The application feature-detects this table and falls back to its existing
--     localStorage behaviour if it is absent, so applying this migration is
--     safe to do BEFORE or AFTER the corresponding app deploy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.procurement_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Business key. Matches buyer_pack_snapshots.pack_id, which is the inventory
  -- batch id. TEXT (not UUID FK) so a decision can be recorded for a batch that
  -- exists only client-side in demo mode, exactly as the localStorage store does.
  batch_id      TEXT NOT NULL,
  -- The full decision set the operator UI offers (src/types.ts:38-45, rendered
  -- from PROCUREMENT_DECISION_LABELS at DDPBuyerPreview.tsx:573). Every option a
  -- user can select must be persistable; a narrower CHECK here would reject four
  -- of them at the database and lose the decision.
  decision      TEXT NOT NULL CHECK (decision IN (
                  'progress', 'hold', 'reject',
                  'request_documents', 'request_fresh_coa',
                  'request_inventory_proof', 'escalate_review')),
  -- A decision with no stated reason is not an audit record. Enforced, not hoped for.
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  -- AUTHORITATIVE actor identity, captured server-side. Never client-supplied.
  decided_by    UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Optional soft link to the immutable snapshot issued off the back of this
  -- decision (populated for 'progress' decisions once a pack is issued).
  snapshot_id   UUID REFERENCES public.buyer_pack_snapshots(snapshot_id),
  content_hash  CHAR(64) CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_procurement_decisions_batch
  ON public.procurement_decisions (batch_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_decisions_actor
  ON public.procurement_decisions (decided_by);

-- ---------------------------------------------------------------------------
-- 2. Append-only enforcement
-- ---------------------------------------------------------------------------
-- Same posture as compliance_audit_log (11_*): the row may be inserted and read,
-- never updated or deleted. History is the point.
CREATE OR REPLACE FUNCTION public.prevent_procurement_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'procurement_decisions is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_procurement_decision_mutation ON public.procurement_decisions;
CREATE TRIGGER trg_prevent_procurement_decision_mutation
BEFORE UPDATE OR DELETE ON public.procurement_decisions
FOR EACH ROW EXECUTE FUNCTION public.prevent_procurement_decision_mutation();

-- ---------------------------------------------------------------------------
-- 3. RLS — admin-only, insert + select, no update/delete path at all
-- ---------------------------------------------------------------------------
ALTER TABLE public.procurement_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "procurement_decisions: admin select" ON public.procurement_decisions;
CREATE POLICY "procurement_decisions: admin select"
  ON public.procurement_decisions FOR SELECT
  TO authenticated
  USING (public.is_ddp_admin());

-- WITH CHECK pins decided_by to the caller: an admin cannot attribute a decision
-- to another admin. The column DEFAULT supplies auth.uid(); this asserts it.
DROP POLICY IF EXISTS "procurement_decisions: admin insert" ON public.procurement_decisions;
CREATE POLICY "procurement_decisions: admin insert"
  ON public.procurement_decisions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_ddp_admin() AND decided_by = auth.uid());

-- No UPDATE or DELETE policy is created. With RLS enabled and no permissive
-- policy for those commands, they are denied for every non-superuser role even
-- before the append-only trigger fires. Defence in depth, matching 11_*.

-- ---------------------------------------------------------------------------
-- 4. Current-decision view (newest row wins)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.procurement_decisions_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (batch_id)
  batch_id, decision, reason, decided_by, decided_at, snapshot_id, content_hash
FROM public.procurement_decisions
ORDER BY batch_id, decided_at DESC;

-- ---------------------------------------------------------------------------
-- 5. Explicit privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.procurement_decisions FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.procurement_decisions TO authenticated;
-- Supabase GRANTs CRUD on new public tables to `authenticated` by default, so the
-- GRANT above does not narrow anything: table-level UPDATE and DELETE survive it.
-- RLS (no UPDATE/DELETE policy) and prevent_procurement_decision_mutation() both
-- still deny the write, but leaving the privilege in place contradicts this
-- migration's own append-only claim and fails V6 of 17_..._VERIFY.sql. Revoked
-- explicitly, exactly as 15_EXISTING_TABLE_AND_AUDIT_LOG_HARDENING.sql:60 does for
-- the other append-only table (compliance_audit_log).
REVOKE UPDATE, DELETE ON public.procurement_decisions FROM authenticated;
REVOKE ALL ON public.procurement_decisions_current FROM PUBLIC, anon;
GRANT SELECT ON public.procurement_decisions_current TO authenticated;

-- Trigger-only function: it must fire from the trigger and be callable by NOBODY
-- directly. No GRANT follows, deliberately — see migration 12 for the same
-- posture applied to prevent_compliance_audit_log_mutation().
-- acl-no-grant: prevent_procurement_decision_mutation
REVOKE EXECUTE ON FUNCTION public.prevent_procurement_decision_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_procurement_decision_mutation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_procurement_decision_mutation() FROM authenticated;
