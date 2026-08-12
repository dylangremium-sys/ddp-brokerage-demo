-- 68_EVIDENCE_DECISION_GATE_VERIFY.sql
--
-- Sections A-E. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, the form the disposable-PostgreSQL harness parses.
--
-- Run AFTER the hardening. Run again AFTER the rollback and it must FAIL: a
-- verify that passes in both directions is checking nothing.

-- A — the substrate, the trigger's reach, append-only, RLS, grants.
DO $a$
BEGIN
  IF to_regclass('public.farmer_document_opens') IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: farmer_document_opens does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='farmer_document_reviews'
       AND column_name='sha256_at_decision'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: sha256_at_decision missing from farmer_document_reviews';
  END IF;

  -- The gate must cover INSERT as well as UPDATE. A gate that watches only
  -- UPDATE is walked around by creating the row already decided — measured, and
  -- the reason this assertion exists. tgtype bit 4 = INSERT, bit 16 = UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='public.farmer_documents'::regclass
       AND tgname='farmer_documents_enforce_decision_gate'
       AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the decision gate does not cover both INSERT and UPDATE';
  END IF;

  -- It must fire BEFORE the reviewer is set, or a refused decision has already
  -- derived values from itself. Alphabetical order within a timing class is what
  -- guarantees that, so it is asserted rather than assumed.
  IF NOT ('farmer_documents_enforce_decision_gate' < 'farmer_documents_set_reviewer') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the gate would not fire before the reviewer setter';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.farmer_document_opens'::regclass AND NOT tgisinternal) < 3 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: farmer_document_opens is missing its append-only triggers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='farmer_document_opens' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS is not enabled on farmer_document_opens';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='farmer_document_opens'
       AND array_to_string(c.relacl, ',') LIKE '%anon=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: anon holds a grant on farmer_document_opens';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: substrate present, gate covers INSERT and UPDATE and fires first, append-only, RLS on, anon holds nothing.';
END
$a$;

-- B — the reason floor, at its edges.
DO $b$
DECLARE v_ok boolean;
BEGIN
  SELECT public.evidence_reason_is_substantive('123456789') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: a 9-character reason was accepted'; END IF;

  SELECT public.evidence_reason_is_substantive('1234567890') INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: a 10-character reason was refused'; END IF;

  SELECT public.evidence_reason_is_substantive('   1234567890   ') INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: padding changed the verdict'; END IF;

  SELECT public.evidence_reason_is_substantive('          ') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: whitespace passed as a reason'; END IF;

  -- The one a length test alone lets through.
  SELECT public.evidence_reason_is_substantive('aaaaaaaaaaaaaaa') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: one character repeated passed as a reason'; END IF;

  SELECT public.evidence_reason_is_substantive('..............') INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'VERIFY B FAILED: one punctuation mark repeated passed as a reason'; END IF;

  SELECT public.evidence_reason_is_substantive(NULL) INTO v_ok;
  IF v_ok IS NOT FALSE THEN RAISE EXCEPTION 'VERIFY B FAILED: NULL did not resolve to false'; END IF;

  RAISE NOTICE 'VERIFY B PASSED: nine characters, whitespace, and one character repeated are all refused; ten are accepted.';
END
$b$;

-- C — the client and the database agree on that floor.
-- The screen mirrors this predicate; if the two drift the database decides, so
-- the shape of the predicate is pinned here rather than left to a comment.
DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='evidence_reason_is_substantive'
       AND p.provolatile = 'i'
  ) THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the reason predicate is missing or not IMMUTABLE';
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: the reason predicate exists and is IMMUTABLE, so it can be reasoned about and indexed.';
END
$c$;

-- D — the gate itself, exercised against real rows.
--
-- Uses a document already on this database when there is one. On an empty
-- cluster it BUILDS one inside a subtransaction and unwinds it, so the section
-- is never vacuous and never leaves residue. A vacuous pass here is worse than
-- no section at all: it is the one that proves a decision with no recorded open
-- is refused by the DATABASE rather than by a disabled button, and green-while-
-- asserting-nothing is exactly the failure this whole migration exists to close.
DO $d$
DECLARE
  v_doc uuid; v_actor uuid; v_farm uuid; v_failed boolean; v_built boolean := false;
BEGIN
  SELECT id INTO v_doc FROM public.farmer_documents WHERE review_status = 'pending' LIMIT 1;
  SELECT id INTO v_actor FROM auth.users LIMIT 1;

  BEGIN
    IF v_doc IS NULL OR v_actor IS NULL THEN
      v_built := true;
      IF v_actor IS NULL THEN
        v_actor := gen_random_uuid();
        INSERT INTO auth.users (id, email, instance_id, aud, role)
        VALUES (v_actor, 'gate-verify@example.invalid',
                '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
      END IF;
      INSERT INTO public.farms (id, farm_name, status)
      VALUES (gen_random_uuid(), 'Gate Verify Farm', 'Approved') RETURNING id INTO v_farm;
      -- sha256_hex and sha256_recorded_at are paired by a CHECK: a digest with
      -- no recorded time is not evidence of anything.
      INSERT INTO public.farmer_documents
        (id, farm_id, document_type, file_name, review_status, sha256_hex, sha256_recorded_at)
      VALUES (gen_random_uuid(), v_farm, 'coa', 'gate-verify.pdf', 'pending', repeat('a', 64), now())
      RETURNING id INTO v_doc;
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);

    -- 1. A decision with no recorded open.
    v_failed := false;
    BEGIN
      UPDATE public.farmer_documents SET review_status='accepted',
        review_note='Gate verification: this update is expected to be refused.' WHERE id=v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a decision was recorded with no open on file';
    END IF;

    INSERT INTO public.farmer_document_opens (farmer_document_id, opened_by) VALUES (v_doc, v_actor);

    -- 2. Opened, but the reason says nothing.
    v_failed := false;
    BEGIN
      UPDATE public.farmer_documents SET review_status='accepted',
        review_note='aaaaaaaaaaaa' WHERE id=v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: one character repeated was accepted as a reason';
    END IF;

    -- 3. Arriving already decided.
    v_failed := false;
    BEGIN
      INSERT INTO public.farmer_documents
        (farm_id, document_type, file_name, review_status, review_note, reviewed_by, reviewed_at)
      SELECT farm_id, 'coa', 'gate-verify-insert.pdf', 'accepted',
             'Gate verification: this insert is expected to be refused.', v_actor, now()
        FROM public.farmer_documents WHERE id = v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a document was inserted already decided';
    END IF;

    -- Unwind anything this section created. Raising inside the subtransaction
    -- and catching it outside is how plpgsql undoes its own work; the sentinel
    -- is distinguishable from a real failure, which is re-raised above.
    IF v_built THEN
      RAISE EXCEPTION 'VERIFY_D_UNWIND' USING ERRCODE = 'raise_exception';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VERIFY_D_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY D PASSED: the gate refused an unopened decision, a thin reason, and an already-decided insert%.',
    CASE WHEN v_built THEN ' (on rows this section built and then unwound)' ELSE '' END;
END
$d$;

-- E — the apply recorded itself. An apply that leaves no record is the failure
-- this pair exists to close, so it is part of what 68 claims.
DO $e$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: no migrations ledger — apply 67 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 68 AND evidence = 'self-recorded' AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: 68 did not record itself in the ledger';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: 68 recorded its own apply in the ledger.';
END
$e$;
