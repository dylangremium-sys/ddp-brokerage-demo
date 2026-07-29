-- =============================================================================
-- 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_ROLLBACK.sql
-- =============================================================================
-- Reverses 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql by
-- CREATE OR REPLACE-ing public.issue_buyer_pack_snapshot() back to migration 23's
-- definition (verbatim from 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql).
--
-- *** SECURITY WARNING — READ BEFORE RUNNING ***
-- This rollback RE-OPENS the contaminant-blocker defect. The restored function
-- gates on admin + server procurement decision + named approver, and NEVER on
-- blocking conditions. After running this, an authenticated ddp_admin can again
-- mint an immutable, audit-logged Buyer Pack snapshot for a batch whose own lab
-- results record a FAILED heavy-metals, pesticides, mycotoxins or microbial
-- test, provided a 'progress' decision exists for the pack.
--
-- The client-side half of the defect (F1a — content-independent risk ids letting
-- a stale "Resolved" override suppress a contaminant blocker) is fixed
-- separately in src/lib/procurementControl.ts. That fix is defence in depth: it
-- is browser state, it is settable from devtools, and it does NOT substitute for
-- this database gate. Rolling this back leaves the client fix as the only
-- barrier, which is precisely the posture the audit found inadequate.
--
-- Only run this to deliberately revert migration 29 — for example if the batch
-- resolution proves wrong against real production data — and re-apply
-- 29_..._HARDENING.sql promptly.
--
-- IMPORTANT: this restores migration 23, NOT migration 10. The
-- server-authoritative decision gate (23) is PRESERVED; only the contaminant
-- assertion added by 29 is removed. Do not use 23_..._ROLLBACK.sql to undo 29 —
-- that would additionally re-open the far more serious client-trusted-decision
-- defect.
--
-- Scope: CREATE OR REPLACE of the function only. It does not touch any table,
-- RLS policy, privilege, trigger, or the procurement_decisions trail. It is
-- idempotent and does not drop or alter migrations 10, 17 or 23.
-- =============================================================================

begin;

CREATE OR REPLACE FUNCTION public.issue_buyer_pack_snapshot(
  p_pack_id              TEXT,
  p_content_hash         TEXT,
  p_approval_id          TEXT,
  p_approval_timestamp   TIMESTAMPTZ,
  p_procurement_decision TEXT,   -- IGNORED for authorization (compat only); server decides
  p_approved_by          TEXT,
  p_generated_by         TEXT,
  p_frozen_evidence      JSONB,
  p_batch_id             UUID DEFAULT NULL   -- soft FK link only; NOT the decision key
)
RETURNS public.buyer_pack_snapshots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_prev public.buyer_pack_snapshots%ROWTYPE;
  v_next_version INTEGER;
  v_row public.buyer_pack_snapshots%ROWTYPE;
  v_actor TEXT;
  v_decision   TEXT;
  v_decided_by UUID;
  v_reason     TEXT;
BEGIN
  -- (1) Admin gate, re-asserted server-side.
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: ddp_admin role required';
  END IF;

  -- (2) The pack key is the authoritative decision-trail join key. Required, non-blank.
  IF p_pack_id IS NULL OR length(btrim(p_pack_id)) = 0 THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a non-blank pack id is required';
  END IF;

  -- (3) SERVER-AUTHORITATIVE RELEASE GATE. Read the CURRENT (newest) decision for
  -- THIS pack from the append-only trail. p_procurement_decision is ignored.
  SELECT c.decision, c.decided_by, c.reason
    INTO v_decision, v_decided_by, v_reason
  FROM public.procurement_decisions_current c
  WHERE c.batch_id = p_pack_id;

  IF v_decision IS NULL THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: no procurement decision recorded for pack % — cannot issue', p_pack_id;
  END IF;
  IF v_decision <> 'progress' THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: current procurement decision for pack % is "%", not "progress" — cannot issue', p_pack_id, v_decision;
  END IF;
  IF v_decided_by IS NULL THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: current decision for pack % has no recorded actor', p_pack_id;
  END IF;
  IF v_reason IS NULL OR length(btrim(v_reason)) = 0 THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: current decision for pack % has no recorded reason', p_pack_id;
  END IF;

  -- (4) A named human approver is still required (client metadata, unchanged gate).
  IF p_approved_by IS NULL OR length(btrim(p_approved_by)) = 0 THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a named human approver is required';
  END IF;

  -- Server-captured authoritative actor identity (preferred over client string).
  v_actor := COALESCE(auth.uid()::text, p_approved_by);

  PERFORM pg_advisory_xact_lock(hashtext(p_pack_id));

  SELECT * INTO v_prev
  FROM public.buyer_pack_snapshots
  WHERE pack_id = p_pack_id
  ORDER BY version DESC
  LIMIT 1;

  v_next_version := COALESCE(v_prev.version, 0) + 1;

  -- (5) Store the SERVER-derived decision (v_decision, proven 'progress').
  INSERT INTO public.buyer_pack_snapshots (
    pack_id, version, previous_snapshot_id, content_hash,
    approval_id, approval_timestamp, procurement_decision, approved_by,
    generated_by, issued_by, frozen_evidence, batch_id
  ) VALUES (
    p_pack_id, v_next_version, v_prev.snapshot_id, p_content_hash,
    p_approval_id, p_approval_timestamp, v_decision, p_approved_by,
    p_generated_by, auth.uid(), p_frozen_evidence, p_batch_id
  )
  RETURNING * INTO v_row;

  INSERT INTO public.buyer_pack_audit_log (pack_id, snapshot_version, action, actor)
    VALUES (p_pack_id, v_next_version, 'pack_generated', v_actor);

  IF v_prev.snapshot_id IS NOT NULL THEN
    INSERT INTO public.buyer_pack_audit_log (pack_id, snapshot_version, action, actor)
      VALUES (p_pack_id, v_prev.version, 'pack_superseded', v_actor);
  END IF;

  RETURN v_row;
END;
$$;

-- EXECUTE ACL re-asserted, unchanged and unwidened.
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

commit;
