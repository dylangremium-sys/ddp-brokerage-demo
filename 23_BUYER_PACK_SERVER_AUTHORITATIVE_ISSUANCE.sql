-- =============================================================================
-- 23_BUYER_PACK_SERVER_AUTHORITATIVE_ISSUANCE.sql
-- =============================================================================
-- Make Buyer Pack issuance depend on the SERVER-authoritative procurement
-- decision trail, not on a client-supplied release status.
--
-- THE DEFECT (repository-verified)
-- --------------------------------
-- issue_buyer_pack_snapshot() (10_BUYER_PACK_SNAPSHOTS_MVP.sql) gates release on
-- the CLIENT argument `p_procurement_decision = 'progress'` and never reads the
-- append-only decision trail (17_PROCUREMENT_DECISIONS_MVP.sql). So an authenticated
-- ddp_admin could mint an immutable, audit-logged snapshot for a pack that the trail
-- records as hold/reject — or has no decision at all — simply by passing
-- p_procurement_decision = 'progress'. The whole point of migration 17 (the
-- server-authoritative, append-only trail) is bypassed at the one gate that
-- authorises releasing a controlled-substance pack.
--
-- THE FIX
-- -------
-- CREATE OR REPLACE the function so the DATABASE decides. The client value is
-- IGNORED for authorization; the effective gate reads the CURRENT (newest) decision
-- for the SAME pack from public.procurement_decisions_current and requires it to be
-- a valid human 'progress' decision. The value STORED in the snapshot is the
-- SERVER-derived decision, never the client's.
--
-- AUTHORITATIVE LINKAGE (resolved from schema, not guessed)
-- ---------------------------------------------------------
--   buyer_pack_snapshots.pack_id   TEXT  = the inventory batch business key
--                                          (10_..._MVP.sql: "= inventory batch id")
--   procurement_decisions.batch_id TEXT  = "Matches buyer_pack_snapshots.pack_id"
--                                          (17_..._MVP.sql:62-67)
--   procurement_decisions_current.batch_id TEXT (newest row per batch, 17_..._MVP.sql:138)
-- The single authoritative join is therefore:
--     procurement_decisions_current.batch_id = p_pack_id      (both TEXT)
-- The RPC's p_batch_id is a DIFFERENT column: buyer_pack_snapshots.batch_id UUID,
-- a nullable soft FK to inventory_batches(id). It is NOT the decision key and is
-- NOT made mandatory here — the gate keys on p_pack_id (TEXT), never on the UUID.
--
-- COMPATIBILITY (Phase 4: "Preferred")
-- ------------------------------------
-- The function SIGNATURE is unchanged (same 9 parameters, same order/types/names),
-- so the sole TypeScript caller (buyerPackSnapshotSupabaseStore.ts) keeps working
-- without a signature break. p_procurement_decision is retained ONLY for signature
-- compatibility and is deliberately IGNORED for authorization and for storage — the
-- database is the sole authority. There is no client/server "mismatch rejection":
-- a client value that disagrees with the server is simply overridden by the server.
--
-- HASH PARITY: OUT OF SCOPE (deliberate — see Phase 5)
-- ---------------------------------------------------
-- content_hash is still stored as supplied and NOT recomputed server-side. The
-- client canonicalisation (JSON.stringify(sortKeysDeep(...)), buyerPackSnapshot.ts)
-- cannot be reproduced byte-for-byte against a normalised jsonb value in Postgres
-- (jsonb reorders keys and reformats numbers/strings), so a server recompute would
-- produce a DIFFERENT hash. Implementing divergent hashing would be worse than
-- none. This migration does NOT claim the hash is server-authoritative; hash parity
-- is a separate follow-up requiring a jsonb-stable canonical contract on both sides.
--
-- SCOPE (deliberately narrow)
-- ---------------------------
-- CREATE OR REPLACE of public.issue_buyer_pack_snapshot only. Migrations 10 and 17
-- are NOT edited. No table, column, RLS policy, privilege, trigger, or immutability
-- protection is changed. The advisory-lock versioning, append-only UNIQUE guard,
-- audit logging, and server-captured issued_by identity all remain exactly as
-- migration 10 defined them. No service-role or client bypass is added.
--
-- MIGRATION NUMBER
-- ----------------
-- Numbered 23 because open PR #22 already reserves 21_* and 22_* (farmer
-- provisioning / operational access). This migration is independent of 21/22 and
-- depends only on 10 (buyer_pack_snapshots + RPC) and 17 (procurement trail + the
-- procurement_decisions_current view), both already on main. Apply AFTER 10 and 17.
--
-- Companions: 23_..._VERIFY.sql (object-state + behavioural), 23_..._ROLLBACK.sql
-- (restores migration 10's client-trusting definition). Idempotent (CREATE OR
-- REPLACE); safe to re-run.
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
  -- Reading procurement_decisions_current inside this SECURITY DEFINER function
  -- runs with the function owner's privileges, so it sees the authoritative row
  -- regardless of the caller's RLS visibility.
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
  -- Defence in depth: the trail (17_..._MVP.sql) already forbids a null actor and a
  -- blank reason at the table level, so a 'progress' row always has both. Re-assert
  -- here so the guarantee is local to the gate and cannot silently regress.
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

  -- Per-pack transaction serialization (unchanged from migration 10). Closes the
  -- first-version and concurrent-re-issue races; UNIQUE (pack_id, version) is the
  -- ultimate backstop. Transaction-scoped, released at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext(p_pack_id));

  SELECT * INTO v_prev
  FROM public.buyer_pack_snapshots
  WHERE pack_id = p_pack_id
  ORDER BY version DESC
  LIMIT 1;

  v_next_version := COALESCE(v_prev.version, 0) + 1;

  -- (5) Store the SERVER-derived decision (v_decision, proven 'progress'), never the
  -- client-supplied p_procurement_decision.
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

-- EXECUTE ACL, re-asserted verbatim from migration 10 (CREATE OR REPLACE already
-- preserves it; this makes the least-privilege grant explicit and self-contained in
-- this migration, and satisfies the repository's public-function EXECUTE-ACL
-- convention). NO privilege is widened: deny PUBLIC/anon, grant authenticated only
-- (the function self-gates on is_ddp_admin); no service_role grant.
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

commit;
