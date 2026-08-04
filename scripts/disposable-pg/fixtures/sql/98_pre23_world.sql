-- Pre-migration-23 world.
--
-- Migration 23 REPLACES public.issue_buyer_pack_snapshot with a definition that
-- reads the procurement decision from the server trail instead of trusting the
-- client-supplied argument. Its ROLLBACK restores "migration 10's original
-- definition (verbatim)".
--
-- That definition no longer exists anywhere in the repository. Migration 10
-- deliberately DELETED it (see the note at the end of
-- 10_BUYER_PACK_SNAPSHOTS_MVP.sql): both used CREATE OR REPLACE on the same
-- signature, there is no numeric-ordering runner, and `ls *.sql | sort` puts 10
-- before 3, 4, 8 and 9 — so any glob-and-run replay silently reverted the
-- hardened function with no error and no ledger entry. Removing it was correct.
--
-- The side effect is that the repository can no longer reproduce the pre-23
-- world. Applying 10 then 17 then 23 and rolling 23 back leaves a function that
-- did not exist before 23 ran, and the gate reports it — accurately — as an
-- object the rollback failed to remove. That is a true statement about a replay
-- from today's repo, but it is NOT what happens in production, where 10 was
-- applied while it still carried the function.
--
-- This stage restores that world so the fixture measures migration 23's
-- reversibility rather than migration 10's edit history. The body below is the
-- one 23's ROLLBACK installs, which is by definition the pre-23 state.
--
-- IT IS DELIBERATELY THE WEAK, CLIENT-TRUSTING VERSION. It runs only inside a
-- disposable cluster that is destroyed at the end of the run, and exists so that
-- a rollback restoring it can be told apart from one that leaves migration 23's
-- hardened version in place. Nothing here is ever applied to a real database.
--
-- Copied rather than \i-included: psql's \i resolves relative to the current
-- working directory, not the script, so an include would bind this fixture to
-- where the harness happened to be invoked from.


CREATE OR REPLACE FUNCTION public.issue_buyer_pack_snapshot(
  p_pack_id              TEXT,
  p_content_hash         TEXT,
  p_approval_id          TEXT,
  p_approval_timestamp   TIMESTAMPTZ,
  p_procurement_decision TEXT,
  p_approved_by          TEXT,
  p_generated_by         TEXT,
  p_frozen_evidence      JSONB,
  p_batch_id             UUID DEFAULT NULL
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
BEGIN
  -- Human-approval gate + admin gate, re-asserted server-side.
  IF NOT public.is_ddp_admin() THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: ddp_admin role required';
  END IF;
  IF p_procurement_decision <> 'progress' THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a recorded "progress" decision is required';
  END IF;
  IF p_approved_by IS NULL OR length(btrim(p_approved_by)) = 0 THEN
    RAISE EXCEPTION 'issue_buyer_pack_snapshot: a named human approver is required';
  END IF;

  -- Server-captured authoritative actor identity (preferred over client string).
  v_actor := COALESCE(auth.uid()::text, p_approved_by);

  -- Per-pack transaction serialization. hashtext(p_pack_id) is a deterministic,
  -- non-dynamic integer derived from the pack id; it implicitly widens to the
  -- bigint pg_advisory_xact_lock key. This serializes ALL concurrent issues for
  -- the same pack for the remainder of the transaction, closing BOTH:
  --   (a) the first-version race — where no row yet exists to lock, so two
  --       concurrent first issues would otherwise both compute version 1; and
  --   (b) the concurrent re-issue race — two issues both reading the same max().
  -- The lock is transaction-scoped and released automatically at COMMIT/ROLLBACK.
  -- The UNIQUE (pack_id, version) constraint remains the ultimate backstop.
  PERFORM pg_advisory_xact_lock(hashtext(p_pack_id));

  SELECT * INTO v_prev
  FROM public.buyer_pack_snapshots
  WHERE pack_id = p_pack_id
  ORDER BY version DESC
  LIMIT 1;

  v_next_version := COALESCE(v_prev.version, 0) + 1;

  INSERT INTO public.buyer_pack_snapshots (
    pack_id, version, previous_snapshot_id, content_hash,
    approval_id, approval_timestamp, procurement_decision, approved_by,
    generated_by, issued_by, frozen_evidence, batch_id
  ) VALUES (
    p_pack_id, v_next_version, v_prev.snapshot_id, p_content_hash,
    p_approval_id, p_approval_timestamp, p_procurement_decision, p_approved_by,
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

-- Re-assert migration 10's EXECUTE ACL verbatim (unchanged least-privilege grant).
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_buyer_pack_snapshot(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;


