-- =============================================================================
-- 29_BUYER_PACK_CONTAMINANT_BLOCKER_GATE_HARDENING.sql
-- =============================================================================
-- Make Buyer Pack issuance refuse, IN THE DATABASE, a batch with a recorded
-- contaminant test failure.
--
-- STATUS — BY ENVIRONMENT (never state "applied" without naming the environment):
--   • Repository : committed and reviewed.
--   • STAGING    : NOT applied. NOT run.
--   • PRODUCTION : NOT applied. NOT run. NOT deployed. A production change freeze
--                  is active (docs/PRODUCTION_CHANGE_FREEZE_2026-07-25.md); this
--                  migration is NOT part of any authorised break-glass change.
--
-- THE DEFECT (audit finding F1b; the client half is F1a)
-- -----------------------------------------------------
-- deriveAutoRisks() emitted a CONTENT-INDEPENDENT risk id
-- (`risk-batch-${item.id}`, src/lib/procurementControl.ts:257) while
-- applyRiskOverrides() matched on that id alone and overrode `status`. A
-- "Resolved" override recorded against a cosmetic gap therefore kept applying
-- after the batch's risk content changed to something else entirely — including
-- a failed heavy-metals / pesticides / mycotoxins / microbial test, which raises
-- severity 'blocker' under the SAME id and so arrived PRE-RESOLVED.
--
-- hasBlockingIssues (src/pages/admin/DDPBuyerPreview.tsx:89-92) is
-- `unresolvedRisks.some(r => r.severity === 'blocker')`. With the blocker
-- pre-resolved and a 'progress' decision recorded, isHumanApproved became true,
-- Print/Copy unblocked, and Issue Buyer Pack enabled for a contaminated batch.
--
-- Migration 23 hardened the issuance RPC to read the SERVER decision trail
-- rather than the client's release status. But its gate is admin + decision +
-- named approver, and NEVER blockers (23_...ISSUANCE.sql:106-143). So the
-- database would still mint an immutable, audit-logged snapshot for a batch
-- whose own lab results record a contaminant failure.
--
-- THE FIX
-- -------
-- CREATE OR REPLACE issue_buyer_pack_snapshot with migration 23's gate INTACT,
-- plus one new assertion: resolve the batch and refuse if any of the four
-- `*_status` columns on public.inventory_batches is 'fail'. This is a condition
-- the database can evaluate for itself, from the farm's own recorded lab
-- results, without trusting any client-side risk computation. The client fix
-- (F1a) is defence in depth; THIS is the line that cannot be bypassed.
--
-- HOW THE BATCH IS RESOLVED (from the schema, not guessed)
-- --------------------------------------------------------
--   buyer_pack_snapshots.pack_id  TEXT = the inventory batch business key
--                                        (10_..._MVP.sql:67 "= inventory batch id")
--   buyer_pack_snapshots.batch_id UUID = nullable soft FK to inventory_batches(id)
--                                        (10_..._MVP.sql:84)
-- The sole TypeScript caller (buyerPackSnapshotSupabaseStore.ts) does NOT send
-- p_batch_id — it passes only p_pack_id — so a gate keyed on p_batch_id alone
-- would be VACUOUS in production: always NULL, always skipped. The batch is
-- therefore resolved as COALESCE(p_batch_id, p_pack_id::uuid when p_pack_id is a
-- well-formed UUID), which is the actual live path.
--
-- FAIL-CLOSED POSTURE, STATED EXPLICITLY
-- --------------------------------------
--   • Batch resolved, any status = 'fail'   ⇒ REFUSE. The purpose of this gate.
--   • Batch resolved, no 'fail'             ⇒ allow (subject to every other gate).
--   • Pack id IS a UUID but no such batch   ⇒ REFUSE. A pack id naming a batch
--     that does not exist cannot be evidenced, and issuing an immutable
--     buyer-facing record against it is not defensible.
--   • Pack id is NOT a UUID and p_batch_id is NULL ⇒ the batch is not
--     identifiable server-side and the contaminant condition CANNOT be
--     evaluated. This is allowed through, and it is a KNOWN LIMITATION, recorded
--     here rather than hidden: pack_id is deliberately TEXT so a decision can be
--     recorded for a batch that exists only client-side (17_..._MVP.sql:62-67).
--     Narrowing it would require making pack_id a hard FK, which is a schema
--     change beyond this migration's scope and is NOT claimed to be done here.
--
-- 'not_tested' and NULL are NOT treated as failures. The absence of a test is a
-- documentation gap — the client scan raises it as 'high', not 'blocker' — and
-- conflating it with a recorded failure here would block the ordinary
-- awaiting-COA path that the workflow depends on.
--
-- RLS NOTE
-- --------
-- The inventory_batches read runs inside this SECURITY DEFINER function, with the
-- function owner's privileges, so the gate sees the authoritative row regardless
-- of the caller's RLS visibility — the same property migration 23 relies on for
-- procurement_decisions_current. A caller cannot evade the gate by being unable
-- to see the failing row.
--
-- SCOPE (deliberately narrow)
-- ---------------------------
-- CREATE OR REPLACE of public.issue_buyer_pack_snapshot only. Migrations 10, 17
-- and 23 are NOT edited. No table, column, RLS policy, privilege, trigger or
-- immutability protection is changed. The advisory-lock versioning, append-only
-- UNIQUE guard, audit logging and server-captured issued_by identity all remain
-- exactly as migration 10 defined them, and migration 23's server-authoritative
-- decision gate is carried forward verbatim. No service-role or client bypass is
-- added.
--
-- MIGRATION NUMBER
-- ----------------
-- Numbered 29 because 27_* (COMPLIANCE_AUDIT_LOG_ACTOR_AUTHORITATIVE) and 28_*
-- (EVIDENCE_DIGEST_DEDUP) are already claimed on unmerged branches
-- (security/ddp-audit-remediation, feature/evidence-digest-dedup-provenance).
-- Verified with scripts/check-migration-numbers.mjs and
-- scripts/audit-001-check-migration-collisions.mjs, which compare across refs
-- rather than main alone. Depends on 10 (buyer_pack_snapshots + RPC), 17
-- (procurement trail) and 23 (server-authoritative gate). Apply AFTER 23.
--
-- Companions: 29_..._VERIFY.sql (Section A object-state, read-only + Section B
-- behavioural), 29_..._ROLLBACK.sql (restores migration 23's definition).
-- Idempotent (CREATE OR REPLACE); safe to re-run.
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
  v_batch_uuid UUID;
  v_batch_found BOOLEAN;
  v_failed_tests TEXT;
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

  -- (3b) SERVER-AUTHORITATIVE CONTAMINANT BLOCKER GATE (migration 29).
  --
  -- A recorded 'progress' decision is NOT sufficient to release a batch whose own
  -- lab results record a contaminant failure. Before this gate, a client-side
  -- "Resolved" risk override — which survived a change in what the risk actually
  -- WAS — could present a failed heavy-metals batch as carrying no unresolved
  -- blocker, and the database would mint the snapshot anyway. The database now
  -- evaluates the condition itself.
  --
  -- Resolve the batch. p_batch_id is a nullable soft link the live client does
  -- not send, so COALESCE falls through to p_pack_id, which IS the inventory
  -- batch id. The regex guard is required: p_pack_id is TEXT and a bare ::uuid
  -- cast on a non-UUID pack id raises 22P02, which would turn a documented
  -- pass-through case into a hard failure for reasons unrelated to contamination.
  v_batch_uuid := COALESCE(
    p_batch_id,
    CASE
      WHEN p_pack_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p_pack_id::uuid
    END
  );

  IF v_batch_uuid IS NOT NULL THEN
    -- Collect the FAILING tests by name, so the exception tells the operator
    -- which result blocked the release rather than merely that something did.
    SELECT TRUE,
           concat_ws(', ',
             CASE WHEN b.heavy_metals_status = 'fail' THEN 'heavy metals' END,
             CASE WHEN b.pesticides_status   = 'fail' THEN 'pesticides'   END,
             CASE WHEN b.mycotoxins_status   = 'fail' THEN 'mycotoxins'   END,
             CASE WHEN b.microbial_status    = 'fail' THEN 'microbial'    END
           )
      INTO v_batch_found, v_failed_tests
    FROM public.inventory_batches b
    WHERE b.id = v_batch_uuid;

    IF NOT COALESCE(v_batch_found, FALSE) THEN
      -- Fail closed. A UUID pack id that names no batch cannot be evidenced, and
      -- an immutable buyer-facing record must not be issued against it.
      RAISE EXCEPTION 'issue_buyer_pack_snapshot: pack % names batch % which does not exist — cannot issue', p_pack_id, v_batch_uuid;
    END IF;

    IF v_failed_tests IS NOT NULL AND length(v_failed_tests) > 0 THEN
      RAISE EXCEPTION 'issue_buyer_pack_snapshot: batch % has a recorded FAILED contaminant test (%) — cannot issue a buyer pack for a batch with an unresolved blocking condition', p_pack_id, v_failed_tests;
    END IF;
  END IF;
  -- else: the pack id is not a UUID and no batch id was supplied, so the batch is
  -- not identifiable server-side and this condition cannot be evaluated. See the
  -- FAIL-CLOSED POSTURE note in this file's header — this is a recorded
  -- limitation, not an oversight.

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
  -- client-supplied argument.
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

-- EXECUTE ACL, re-asserted verbatim from migrations 10 and 23 (CREATE OR REPLACE
-- already preserves it; this makes the least-privilege grant explicit and
-- self-contained in this migration, and satisfies the repository's
-- public-function EXECUTE-ACL convention). NO privilege is widened: deny
-- PUBLIC/anon, grant authenticated only (the function self-gates on
-- is_ddp_admin); no service_role grant.
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

commit;
