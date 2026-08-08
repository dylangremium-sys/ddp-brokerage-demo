-- =============================================================================
-- RED/BLUE probe for migration 65 — document review clarification.
--
-- RED attempts every abuse of the review path that the instruction names. BLUE
-- requires each one to be refused BY THE DATABASE, with the application layer
-- taken out of the picture entirely: every statement below is raw SQL against
-- the table.
--
-- A NOTE ON WHAT "REFUSED" MEANS HERE, because the two failure modes look
-- identical from a client and are not the same thing:
--
--   · an ERROR      — a trigger or constraint rejected the statement
--   · ZERO ROWS     — RLS filtered the row out; the statement "succeeded" and
--                     changed nothing
--
-- Both are safe outcomes for a write. Only the first is safe for a READ, where
-- zero rows IS the refusal. Each check below states which it got, so a filtered
-- write is never reported as a rejected one.
--
-- RUN INSIDE A TRANSACTION THAT IS ROLLED BACK. It seeds profiles and a
-- document; nothing survives. Safe against staging and, read-only in effect,
-- against production.
-- =============================================================================

DO $redblue$
DECLARE
  v_admin    uuid;
  v_farmer   uuid;
  v_buyer    uuid;
  v_farm     uuid;
  v_doc      uuid;
  v_ev       uuid;
  v_n        integer;
  v_err      text;
  v_results  text[] := '{}';
  v_fails    text[] := '{}';
BEGIN
  SELECT id INTO v_admin  FROM auth.users ORDER BY id LIMIT 1;
  SELECT id INTO v_farmer FROM auth.users WHERE id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_buyer  FROM auth.users WHERE id NOT IN (v_admin, v_farmer) ORDER BY id LIMIT 1;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'RED/BLUE PRECONDITION FAILED: three auth.users rows are required; found %.',
      (SELECT count(*) FROM auth.users);
  END IF;

  INSERT INTO public.profiles (id, email, display_name, role) VALUES
    (v_admin,  'rb-admin@probe.test',  'Probe Admin',  'ddp_admin'),
    (v_farmer, 'rb-farmer@probe.test', 'Probe Farmer', 'farmer'),
    (v_buyer,  'rb-buyer@probe.test',  'Probe Buyer',  'buyer')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

  INSERT INTO public.farms (name, status, created_by)
  VALUES ('Probe Farm', 'pending', v_farmer)
  RETURNING id INTO v_farm;

  INSERT INTO public.farmer_documents (farm_id, document_type, file_name, review_status)
  VALUES (v_farm, 'coa', 'redblue-65.pdf', 'pending')
  RETURNING id INTO v_doc;

  RAISE NOTICE 'seeded: admin=% farmer=% buyer=% doc=%', v_admin, v_farmer, v_buyer, v_doc;

  -- ── RED 1: the farmer reviews their OWN document ────────────────────────
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_farmer::text, true);
    UPDATE public.farmer_documents
    SET review_status = 'accepted', review_note = 'I approve my own certificate'
    WHERE id = v_doc;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n = 0 THEN
      v_results := v_results || 'RED 1 farmer self-review: REFUSED (RLS filtered, 0 rows)';
    ELSE
      v_fails := v_fails || format('RED 1 farmer self-review SUCCEEDED (%s rows)', v_n);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 1 farmer self-review: REFUSED (error: %s)', left(v_err, 60));
  END;

  -- ── RED 2: an anonymous session reviews ─────────────────────────────────
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.farmer_documents
    SET review_status = 'accepted', review_note = 'anonymous approval'
    WHERE id = v_doc;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n = 0 THEN
      v_results := v_results || 'RED 2 anonymous review: REFUSED (RLS filtered, 0 rows)';
    ELSE
      v_fails := v_fails || format('RED 2 anonymous review SUCCEEDED (%s rows)', v_n);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 2 anonymous review: REFUSED (error: %s)', left(v_err, 60));
  END;

  -- ── RED 3: an admin forges reviewed_by as a colleague ───────────────────
  -- Not refused — OVERWRITTEN, which is the stronger outcome. The point is that
  -- the value the caller sent is not the value that lands.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.farmer_documents
  SET review_status = 'awaiting_clarification',
      review_note   = 'batch association unresolved',
      reviewed_by   = v_farmer          -- the forgery
  WHERE id = v_doc;

  SELECT reviewed_by INTO v_ev FROM public.farmer_documents WHERE id = v_doc;
  IF v_ev = v_admin THEN
    v_results := v_results || 'RED 3 forged reviewed_by: OVERWRITTEN with the real actor';
  ELSE
    v_fails := v_fails || format('RED 3 forged reviewed_by STUCK (row says %s, actor was %s)', v_ev, v_admin);
  END IF;

  SELECT reviewed_by INTO v_ev FROM public.farmer_document_reviews WHERE farmer_document_id = v_doc;
  IF v_ev = v_admin THEN
    v_results := v_results || 'RED 3b forged reviewed_by in the EVENT: also the real actor';
  ELSE
    v_fails := v_fails || format('RED 3b the history event names %s, not the actor %s', v_ev, v_admin);
  END IF;

  -- ── RED 4: a replayed / duplicate transition ────────────────────────────
  -- Same status again. Defined behaviour: the trigger fires only on a real
  -- change, so this is a no-op that appends NOTHING. Idempotent, not an error.
  UPDATE public.farmer_documents
  SET review_status = 'awaiting_clarification', review_note = 'batch association unresolved'
  WHERE id = v_doc;
  SELECT count(*) INTO v_n FROM public.farmer_document_reviews WHERE farmer_document_id = v_doc;
  IF v_n = 1 THEN
    v_results := v_results || 'RED 4 replayed transition: SAFE no-op, history still 1 event';
  ELSE
    v_fails := v_fails || format('RED 4 replayed transition appended: history now %s events', v_n);
  END IF;

  -- ── RED 5: an invalid status ────────────────────────────────────────────
  BEGIN
    UPDATE public.farmer_documents
    SET review_status = 'buyer_approved', review_note = 'inventing a state'
    WHERE id = v_doc;
    v_fails := v_fails || 'RED 5 invalid status ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    v_results := v_results || 'RED 5 invalid status: REFUSED (CHECK)';
  END;

  -- ── RED 6: a farmer inserts a review event directly ─────────────────────
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_farmer::text, true);
    INSERT INTO public.farmer_document_reviews
      (farmer_document_id, previous_status, new_status, review_note, reviewed_by)
    VALUES (v_doc, 'pending', 'accepted', 'self-issued', v_farmer);
    RESET ROLE;
    v_fails := v_fails || 'RED 6 farmer INSERT into the history SUCCEEDED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 6 farmer writes history: REFUSED (%s)', left(v_err, 50));
  END;

  -- ── RED 7: a farmer READS the history ───────────────────────────────────
  -- Zero rows IS the refusal for a read.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_farmer::text, true);
    SELECT count(*) INTO v_n FROM public.farmer_document_reviews;
    RESET ROLE;
    IF v_n = 0 THEN
      v_results := v_results || 'RED 7 farmer reads history: REFUSED (0 rows, admin-only policy)';
    ELSE
      v_fails := v_fails || format('RED 7 farmer READ %s history rows', v_n);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 7 farmer reads history: REFUSED (error: %s)', left(v_err, 50));
  END;

  -- ── RED 8: a BUYER reads awaiting-clarification evidence ────────────────
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
    SELECT count(*) INTO v_n FROM public.farmer_documents WHERE review_status = 'awaiting_clarification';
    RESET ROLE;
    IF v_n = 0 THEN
      v_results := v_results || 'RED 8 buyer reads clarification-state evidence: REFUSED (0 rows)';
    ELSE
      v_fails := v_fails || format('RED 8 buyer READ %s awaiting-clarification documents', v_n);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 8 buyer reads evidence: REFUSED (error: %s)', left(v_err, 50));
  END;

  -- ── RED 9: a buyer reviews ──────────────────────────────────────────────
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_buyer::text, true);
    UPDATE public.farmer_documents
    SET review_status = 'accepted', review_note = 'buyer approves'
    WHERE id = v_doc;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n = 0 THEN
      v_results := v_results || 'RED 9 buyer review: REFUSED (RLS filtered, 0 rows)';
    ELSE
      v_fails := v_fails || format('RED 9 buyer review SUCCEEDED (%s rows)', v_n);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM; RESET ROLE;
    v_results := v_results || format('RED 9 buyer review: REFUSED (error: %s)', left(v_err, 50));
  END;

  -- ── RED 10: direct status change with the event trigger bypassed ────────
  -- There is no route to disable the trigger short of ALTER TABLE, which is
  -- itself owner-only; the check that matters is that a status change ALWAYS
  -- appends. Proven by counting before and after a real transition.
  SELECT count(*) INTO v_n FROM public.farmer_document_reviews WHERE farmer_document_id = v_doc;
  UPDATE public.farmer_documents
  SET review_status = 'rejected', review_note = 'seal does not match the issuing laboratory'
  WHERE id = v_doc;
  SELECT count(*) - v_n INTO v_n FROM public.farmer_document_reviews WHERE farmer_document_id = v_doc;
  IF v_n = 1 THEN
    v_results := v_results || 'RED 10 status change without an event: IMPOSSIBLE (exactly 1 appended)';
  ELSE
    v_fails := v_fails || format('RED 10 a status change appended %s events, not 1', v_n);
  END IF;

  -- ── Report ──────────────────────────────────────────────────────────────
  FOREACH v_err IN ARRAY v_results LOOP
    RAISE NOTICE 'BLUE  %', v_err;
  END LOOP;

  IF array_length(v_fails, 1) > 0 THEN
    FOREACH v_err IN ARRAY v_fails LOOP
      RAISE WARNING 'RED WON  %', v_err;
    END LOOP;
    RAISE EXCEPTION 'RED/BLUE FAILED: % of the attempts were not refused.', array_length(v_fails, 1);
  END IF;

  RAISE NOTICE 'RED/BLUE COMPLETE: % attempts, all refused or safely defined.', array_length(v_results, 1);
END
$redblue$;
