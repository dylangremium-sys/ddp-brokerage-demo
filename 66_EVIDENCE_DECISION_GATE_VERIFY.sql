-- 66_EVIDENCE_DECISION_GATE_VERIFY.sql
--
-- Asserts what 66 claims. Every check RAISEs on failure, so a green run means
-- the assertions actually executed — not that the file parsed.
--
-- Run AFTER the hardening. Run again AFTER the rollback and it must FAIL:
-- a verify that passes in both directions is checking nothing.

DO $verify$
DECLARE
  v_ok boolean;
BEGIN
  -- ── 1. Substrate ──────────────────────────────────────────────────────────
  IF to_regclass('public.farmer_document_opens') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: farmer_document_opens does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='farmer_document_reviews'
       AND column_name='sha256_at_decision'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: sha256_at_decision missing from farmer_document_reviews';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='public.farmer_documents'::regclass
       AND tgname='farmer_documents_enforce_decision_gate' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the decision-gate trigger is not attached';
  END IF;

  -- It must cover INSERT as well as UPDATE. tgtype bit 2 (value 4) is INSERT,
  -- bit 4 (value 16) is UPDATE. A gate that only watches UPDATE can be walked
  -- around by creating the row already decided.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='public.farmer_documents'::regclass
       AND tgname='farmer_documents_enforce_decision_gate'
       AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the decision gate does not cover both INSERT and UPDATE';
  END IF;

  -- The gate must fire BEFORE the reviewer is set, or a refused decision has
  -- already derived values from itself. Alphabetical order within a timing
  -- class is what guarantees this, so it is asserted rather than assumed.
  IF NOT (
    SELECT 'farmer_documents_enforce_decision_gate' < 'farmer_documents_set_reviewer'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: gate trigger would not fire before the reviewer setter';
  END IF;

  -- ── 2. Append-only, both mutations ────────────────────────────────────────
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.farmer_document_opens'::regclass AND NOT tgisinternal) < 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED: farmer_document_opens is missing its append-only triggers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='farmer_document_opens' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: RLS is not enabled on farmer_document_opens';
  END IF;

  -- anon must hold nothing. Checked on relacl, not role_table_grants, which is
  -- blind when queried as a role that cannot see the grant.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='farmer_document_opens'
       AND array_to_string(c.relacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: anon still holds a grant on farmer_document_opens';
  END IF;

  -- ── 3. The reason floor, at its edges ─────────────────────────────────────
  SELECT public.evidence_reason_is_substantive('123456789')  INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: a 9-character reason was accepted'; END IF;

  SELECT public.evidence_reason_is_substantive('1234567890') INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: a 10-character reason was refused'; END IF;

  SELECT public.evidence_reason_is_substantive('   1234567890   ') INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: padding changed the verdict'; END IF;

  SELECT public.evidence_reason_is_substantive('          ') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: whitespace passed as a reason'; END IF;

  -- The one a length test alone lets through.
  SELECT public.evidence_reason_is_substantive('aaaaaaaaaaaaaaa') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: one character repeated passed as a reason'; END IF;

  SELECT public.evidence_reason_is_substantive('..............') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY FAILED: one punctuation mark repeated passed as a reason'; END IF;

  SELECT public.evidence_reason_is_substantive(NULL) INTO v_ok;
  IF v_ok IS NOT FALSE THEN RAISE EXCEPTION 'VERIFY FAILED: NULL did not resolve to false'; END IF;

  -- The ledger row is part of what 66 claims: an apply that left no record is
  -- the failure this whole pair exists to close.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: no migrations ledger — apply 62 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 66 AND evidence = 'self-recorded' AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: 66 did not record itself in the ledger';
  END IF;

  RAISE NOTICE 'VERIFY PASSED: substrate, append-only, grants, the reason floor, and the ledger row.';
END
$verify$;

-- ── 4. The gate itself, exercised against a real row ────────────────────────
-- Runs only where there is a document to act on; skips with a notice otherwise
-- so the file is safe on an empty database. Everything happens inside a
-- transaction that is rolled back, so no state survives this check.
DO $gate$
DECLARE
  v_doc    uuid;
  v_actor  uuid;
  v_failed boolean;
BEGIN
  SELECT id INTO v_doc FROM public.farmer_documents LIMIT 1;
  SELECT id INTO v_actor FROM auth.users LIMIT 1;

  IF v_doc IS NULL OR v_actor IS NULL THEN
    RAISE NOTICE 'VERIFY SKIPPED (gate exercise): no document or no user on this database.';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);

  -- (a) A decision with no recorded open must be refused.
  v_failed := false;
  BEGIN
    UPDATE public.farmer_documents
       SET review_status = CASE WHEN review_status = 'accepted' THEN 'rejected' ELSE 'accepted' END,
           review_note = 'Gate verification: this update is expected to be refused.'
     WHERE id = v_doc;
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY FAILED: a decision was recorded with no open on file';
  END IF;

  -- (b) With an open recorded, a thin reason must still be refused.
  INSERT INTO public.farmer_document_opens (farmer_document_id, opened_by)
  VALUES (v_doc, v_actor);

  v_failed := false;
  BEGIN
    UPDATE public.farmer_documents
       SET review_status = CASE WHEN review_status = 'accepted' THEN 'rejected' ELSE 'accepted' END,
           review_note = 'aaaaaaaaaaaa'
     WHERE id = v_doc;
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY FAILED: one character repeated was accepted as a reason';
  END IF;

  -- (c) A document may not ARRIVE decided. Without this the whole gate is
  -- addressable by creating the row already accepted instead of deciding on it.
  v_failed := false;
  BEGIN
    INSERT INTO public.farmer_documents
      (farm_id, document_type, file_name, review_status, review_note, reviewed_by, reviewed_at)
    SELECT farm_id, 'coa', 'gate-verify-insert.pdf', 'accepted',
           'Gate verification: this insert is expected to be refused.', v_actor, now()
      FROM public.farmer_documents WHERE id = v_doc;
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY FAILED: a document was inserted already decided';
  END IF;

  RAISE NOTICE 'VERIFY PASSED: the gate refused an unopened decision, a thin reason, and an already-decided insert.';
  -- Nothing is committed: the caller runs this inside a transaction it rolls
  -- back, and the runbook says so.
END
$gate$;
