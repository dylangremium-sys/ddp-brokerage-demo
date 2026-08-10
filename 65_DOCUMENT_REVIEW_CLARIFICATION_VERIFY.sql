-- =============================================================================
-- 65_DOCUMENT_REVIEW_CLARIFICATION_VERIFY.sql
--
-- Proves an administrator can record a reasoned non-decision, and that every
-- route to changing a document's review state leaves an attributed, reasoned,
-- immutable event behind.
--
-- Section B is the point: it drives a real 'awaiting_clarification' transition
-- as an authenticated actor and requires exactly ONE history event naming that
-- actor, carrying the note, and recording the status it came from. Everything
-- else exists to stop B passing for the wrong reason —
--
--   A  the objects exist and are built the way the migration says
--   C  no transition of ANY kind survives a NULL auth.uid(), return-to-queue
--      included, which is the property migration 64 gave accept/reject only
--   D  a blank or whitespace-only note is refused for all three decisions
--   E  returning to the queue needs its own reason, clears the attribution, and
--      PRESERVES the events already recorded
--   F  the history refuses UPDATE, DELETE and TRUNCATE as a superuser
--   G  an unrelated UPDATE writes no event and restamps nothing
--   H  a note cannot be edited without a transition
--   I  the trigger functions are not directly EXECUTEable and no role holds
--      INSERT on the history
--
-- HOW THE FIXTURE IS REMOVED. It is not. It cannot be: the history is
-- append-only by trigger and the document is referenced ON DELETE RESTRICT, so
-- a VERIFY that could clean up after itself would be proving the guards do not
-- work. Instead every fixture statement runs inside one plpgsql subtransaction
-- that is deliberately aborted at the end by a sentinel exception. NOTICEs
-- already emitted survive the abort — they are not transactional — so the PASS
-- lines the harness parses are all still reported, while the rows are gone.
-- =============================================================================

DO $verify$
DECLARE
  c_sentinel  constant text := 'VERIFY65_FIXTURE_ROLLBACK';

  -- Two real reviewers, RESOLVED from auth.users rather than hardcoded.
  -- The first draft pinned the harness substrate's two seeded UUIDs and passed
  -- there; run against staging it failed on farmer_documents_reviewed_by_fkey,
  -- because a real database has real users and not those. A VERIFY that only
  -- works on the fixture substrate is not verifying the migration.
  v_actor_a   uuid;
  v_actor_b   uuid;

  v_problems  text[] := '{}';
  v_id        uuid;
  v_secdef    boolean;
  v_path      text;
  v_refused   boolean;
  v_status    text;
  v_note      text;
  v_at        timestamptz;
  v_by        uuid;
  v_events    integer;
  v_prev      text;
  v_new       text;
  v_first_ev  uuid;
BEGIN
  -- ── A. The objects exist and are built as declared ────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.farmer_documents'::regclass
      AND conname = 'farmer_documents_review_status_check'
      AND pg_get_constraintdef(oid) LIKE '%awaiting_clarification%'
  ) THEN
    v_problems := v_problems || 'the review_status vocabulary does not admit awaiting_clarification';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.farmer_documents'::regclass
      AND attname = 'review_note' AND NOT attisdropped
  ) THEN
    v_problems := v_problems || 'farmer_documents has no review_note column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.farmer_documents'::regclass
      AND conname = 'review_decision_requires_note'
  ) THEN
    v_problems := v_problems || 'review_decision_requires_note is missing';
  END IF;

  IF to_regclass('public.farmer_document_reviews') IS NULL THEN
    v_problems := v_problems || 'the farmer_document_reviews history table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'farmer_documents'
      AND t.tgname = 'farmer_documents_write_review_event'
  ) THEN
    v_problems := v_problems || 'the review-event trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'farmer_document_reviews'
      AND t.tgname = 'farmer_document_reviews_no_update_delete'
  ) THEN
    v_problems := v_problems || 'the history no-update-delete guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'farmer_document_reviews'
      AND t.tgname = 'farmer_document_reviews_no_truncate'
  ) THEN
    v_problems := v_problems || 'the history no-truncate guard is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.farmer_document_reviews'::regclass) THEN
    v_problems := v_problems || 'row level security is not enabled on farmer_document_reviews';
  END IF;

  -- The history must have no INSERT route for an application role: its only
  -- writer is the SECURITY DEFINER trigger.
  IF has_table_privilege('authenticated', 'public.farmer_document_reviews', 'INSERT')
     OR has_table_privilege('anon', 'public.farmer_document_reviews', 'INSERT')
     OR has_table_privilege('service_role', 'public.farmer_document_reviews', 'INSERT') THEN
    v_problems := v_problems || 'an application role holds INSERT on the append-only history';
  END IF;

  FOR v_note IN
    SELECT unnest(ARRAY['fn_farmer_document_review_event', 'prevent_farmer_document_review_mutation', 'fn_farmer_documents_set_reviewer'])
  LOOP
    SELECT p.prosecdef, array_to_string(p.proconfig, ',') INTO v_secdef, v_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_note;

    IF v_secdef IS NULL THEN
      v_problems := v_problems || format('%s does not exist', v_note);
    ELSE
      IF NOT v_secdef THEN
        v_problems := v_problems || format('%s lost SECURITY DEFINER', v_note);
      END IF;
      IF v_path IS NULL OR v_path NOT LIKE '%search_path=public, pg_temp%' THEN
        v_problems := v_problems || format('%s has an unpinned search_path (%s)', v_note, coalesce(v_path, 'NULL'));
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: the vocabulary, the note, the history table, its guards, its RLS and all three functions are present and correctly built.';

  -- Two distinct real users are needed: E proves a SECOND administrator's return
  -- to the queue leaves the FIRST one's event untouched, which one actor cannot
  -- demonstrate.
  SELECT id INTO v_actor_a FROM auth.users ORDER BY id LIMIT 1;
  SELECT id INTO v_actor_b FROM auth.users WHERE id <> v_actor_a ORDER BY id LIMIT 1;

  IF v_actor_a IS NULL OR v_actor_b IS NULL THEN
    RAISE EXCEPTION
      'VERIFY 65 PRECONDITION FAILED: two auth.users rows are required to prove that one '
      'administrator cannot alter another''s recorded event; found %.',
      (SELECT count(*) FROM auth.users);
  END IF;

  -- ── Everything below runs in an aborted subtransaction. See the header. ───
  BEGIN
    INSERT INTO public.farmer_documents (document_type, file_name, review_status)
    VALUES ('coa', 'v65-verify.pdf', 'pending')
    RETURNING id INTO v_id;

    -- ── C. No transition survives a NULL auth.uid() ─────────────────────────
    -- No session is set here, so auth.uid() is NULL and this runs with the full
    -- rights of the migration role. Each of the three decisions, and the return
    -- to the queue, must be refused. Return-to-queue is the new one: under 64
    -- alone it was the one transition that needed no human.
    PERFORM set_config('request.jwt.claim.sub', '', true);

    FOREACH v_new IN ARRAY ARRAY['awaiting_clarification', 'accepted', 'rejected'] LOOP
      v_refused := false;
      BEGIN
        UPDATE public.farmer_documents
        SET review_status = v_new, review_note = 'a reason that should not save it'
        WHERE id = v_id;
      EXCEPTION WHEN OTHERS THEN
        v_refused := true;
      END;

      IF NOT v_refused THEN
        RAISE EXCEPTION
          'VERIFY C FAILED: a document reached % with auth.uid() NULL. A decision can still be '
          'recorded with no record of who made it.', v_new;
      END IF;
    END LOOP;

    SELECT review_status INTO v_status FROM public.farmer_documents WHERE id = v_id;
    IF v_status <> 'pending' THEN
      RAISE EXCEPTION 'VERIFY C FAILED: the document moved to % even though every UPDATE raised.', v_status;
    END IF;
    RAISE NOTICE 'VERIFY C PASSED: all three decisions are refused when no authenticated human is present.';

    -- ── D. A blank or whitespace-only note is refused ───────────────────────
    PERFORM set_config('request.jwt.claim.sub', v_actor_a::text, true);

    FOREACH v_new IN ARRAY ARRAY['awaiting_clarification', 'accepted', 'rejected'] LOOP
      FOREACH v_note IN ARRAY ARRAY['', '   ', E'\t\n  '] LOOP
        v_refused := false;
        BEGIN
          UPDATE public.farmer_documents
          SET review_status = v_new, review_note = v_note
          WHERE id = v_id;
        EXCEPTION WHEN OTHERS THEN
          v_refused := true;
        END;

        IF NOT v_refused THEN
          -- RAISE understands only %, so the literal is quoted before it is passed.
          RAISE EXCEPTION
            'VERIFY D FAILED: % was recorded with a blank note (%). A decision with no stated '
            'reason is exactly what this migration exists to prevent. Note that default btrim() '
            'strips SPACES ONLY, so a tab- or newline-only note passes a btrim-based test.',
            v_new, quote_literal(v_note);
        END IF;
      END LOOP;
    END LOOP;
    RAISE NOTICE 'VERIFY D PASSED: empty and whitespace-only notes are refused for all three decisions.';

    -- ── B. THE POINT — a reasoned non-decision, attributed, with one event ──
    UPDATE public.farmer_documents
    SET review_status = 'awaiting_clarification',
        review_note   = 'Laboratory report reviewed. The evidence does not establish a defensible association between this report and a specific inventory batch.'
    WHERE id = v_id;

    SELECT review_status, review_note, reviewed_at, reviewed_by
      INTO v_status, v_note, v_at, v_by
    FROM public.farmer_documents WHERE id = v_id;

    IF v_status <> 'awaiting_clarification' THEN
      RAISE EXCEPTION 'VERIFY B FAILED: the document is % rather than awaiting_clarification.', v_status;
    END IF;
    IF v_by IS DISTINCT FROM v_actor_a OR v_at IS NULL THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: awaiting_clarification was recorded without naming its reviewer (by=%, at=%). '
        'An unattributed non-decision is no better than the absent state it replaces.', v_by, v_at;
    END IF;
    IF coalesce(v_note, '') !~ '[^[:space:]]' THEN
      RAISE EXCEPTION 'VERIFY B FAILED: the document carries no review note.';
    END IF;

    SELECT count(*) INTO v_events
    FROM public.farmer_document_reviews WHERE farmer_document_id = v_id;
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: one transition produced % history events. Exactly one is the contract; '
        'zero means the trail is silent and more than one means it is unreliable.', v_events;
    END IF;

    SELECT id, previous_status, new_status, reviewed_by
      INTO v_first_ev, v_prev, v_new, v_by
    FROM public.farmer_document_reviews WHERE farmer_document_id = v_id;

    IF v_prev <> 'pending' OR v_new <> 'awaiting_clarification' OR v_by IS DISTINCT FROM v_actor_a THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: the event records % -> % by %, which is not the transition that happened.',
        v_prev, v_new, v_by;
    END IF;
    RAISE NOTICE 'VERIFY B PASSED: an administrator recorded a reasoned awaiting_clarification decision, attributed to them, with exactly one history event.';

    -- ── G. An unrelated UPDATE writes no event and restamps nothing ─────────
    UPDATE public.farmer_documents SET lab_name = 'Some Lab' WHERE id = v_id;

    SELECT count(*) INTO v_events
    FROM public.farmer_document_reviews WHERE farmer_document_id = v_id;
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'VERIFY G FAILED: an UPDATE that did not touch review_status produced a history event '
        '(% events). Every unrelated write would then manufacture a decision.', v_events;
    END IF;

    SELECT reviewed_by INTO v_by FROM public.farmer_documents WHERE id = v_id;
    IF v_by IS DISTINCT FROM v_actor_a THEN
      RAISE EXCEPTION 'VERIFY G FAILED: an unrelated UPDATE restamped the reviewer to %.', v_by;
    END IF;
    RAISE NOTICE 'VERIFY G PASSED: an unrelated UPDATE writes no event and does not restamp the reviewer.';

    -- ── H. A note cannot be edited without a transition ─────────────────────
    v_refused := false;
    BEGIN
      UPDATE public.farmer_documents SET review_note = 'quietly rewritten' WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION
        'VERIFY H FAILED: the note on a decided document was rewritten with no transition and no '
        'event. Current state would then disagree with the history that explains it.';
    END IF;
    RAISE NOTICE 'VERIFY H PASSED: a review note cannot be edited without a transition.';

    -- ── E. Return-to-queue: reasoned, attributed, and non-destructive ───────
    -- First prove it needs its own reason.
    v_refused := false;
    BEGIN
      UPDATE public.farmer_documents
      SET review_status = 'pending', review_note = '   '
      WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'VERIFY E FAILED: a document was returned to the queue with a blank reason.';
    END IF;

    -- Now a real return, by a DIFFERENT actor, and check the trail.
    PERFORM set_config('request.jwt.claim.sub', v_actor_b::text, true);

    UPDATE public.farmer_documents
    SET review_status = 'pending',
        review_note   = 'Returned to the queue: the farmer has been asked to confirm the batch.'
    WHERE id = v_id;

    SELECT review_status, reviewed_at, reviewed_by INTO v_status, v_at, v_by
    FROM public.farmer_documents WHERE id = v_id;
    IF v_status <> 'pending' OR v_at IS NOT NULL OR v_by IS NOT NULL THEN
      RAISE EXCEPTION
        'VERIFY E FAILED: a pending document still carries a reviewer or a review time (by=%, at=%).',
        v_by, v_at;
    END IF;

    SELECT count(*) INTO v_events
    FROM public.farmer_document_reviews WHERE farmer_document_id = v_id;
    IF v_events <> 2 THEN
      RAISE EXCEPTION
        'VERIFY E FAILED: after a return to the queue the document has % history events, not 2. '
        'Clearing the current attribution must not disturb what was already recorded.', v_events;
    END IF;

    -- The FIRST event must be untouched — same id, still naming actor A.
    SELECT reviewed_by INTO v_by
    FROM public.farmer_document_reviews WHERE id = v_first_ev;
    IF v_by IS DISTINCT FROM v_actor_a THEN
      RAISE EXCEPTION
        'VERIFY E FAILED: the earlier event no longer names the administrator who made it (now %). '
        'A trail that can be rewritten by a later action is not a trail.', v_by;
    END IF;

    SELECT previous_status, new_status, reviewed_by INTO v_prev, v_new, v_by
    FROM public.farmer_document_reviews
    WHERE farmer_document_id = v_id AND id <> v_first_ev;
    IF v_prev <> 'awaiting_clarification' OR v_new <> 'pending' OR v_by IS DISTINCT FROM v_actor_b THEN
      RAISE EXCEPTION
        'VERIFY E FAILED: the return event records % -> % by %, which is not what happened.',
        v_prev, v_new, v_by;
    END IF;
    RAISE NOTICE 'VERIFY E PASSED: returning to the queue needs its own reason, names who did it, clears the current attribution and preserves every earlier event.';

    -- ── F. The history is append-only, as a superuser ───────────────────────
    -- Running as the most privileged role available is the point: a rule that
    -- only binds the application layer is a convention.
    v_refused := false;
    BEGIN
      UPDATE public.farmer_document_reviews SET review_note = 'rewritten' WHERE id = v_first_ev;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'VERIFY F FAILED: a history row was UPDATEd by a superuser.';
    END IF;

    v_refused := false;
    BEGIN
      DELETE FROM public.farmer_document_reviews WHERE id = v_first_ev;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'VERIFY F FAILED: a history row was DELETEd by a superuser.';
    END IF;

    v_refused := false;
    BEGIN
      TRUNCATE public.farmer_document_reviews;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION
        'VERIFY F FAILED: the history was TRUNCATEd. A row-level guard alone never fires for '
        'TRUNCATE, so the whole trail is emptiable in one statement.';
    END IF;

    -- And the document itself cannot be deleted out from under its history.
    v_refused := false;
    BEGIN
      DELETE FROM public.farmer_documents WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION
        'VERIFY F FAILED: a document with review history was deleted. Deleting the subject is a '
        'delete path through an append-only table.';
    END IF;
    RAISE NOTICE 'VERIFY F PASSED: UPDATE, DELETE and TRUNCATE on the history are all refused, as is deleting a document that has any.';

    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION '%', c_sentinel;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> c_sentinel THEN
        RAISE;
      END IF;
  END;

  -- ── I. The trigger functions are not directly EXECUTEable ────────────────
  IF has_function_privilege('anon', 'public.fn_farmer_document_review_event()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_farmer_document_review_event()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.prevent_farmer_document_review_mutation()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.prevent_farmer_document_review_mutation()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_farmer_documents_set_reviewer()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_farmer_documents_set_reviewer()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'VERIFY I FAILED: a SECURITY DEFINER trigger function is directly EXECUTEable. A trigger '
      'function is invoked by the trigger mechanism, which never checks EXECUTE, so any grant here '
      'is a definer-rights entry point bought for nothing.';
  END IF;
  RAISE NOTICE 'VERIFY I PASSED: none of the three trigger functions is directly EXECUTEable by anon or authenticated.';

  -- Confirm the abort actually took the fixture with it.
  IF EXISTS (SELECT 1 FROM public.farmer_documents WHERE file_name = 'v65-verify.pdf') THEN
    RAISE EXCEPTION 'VERIFY 65 FAILED: the fixture document survived the subtransaction abort.';
  END IF;

  RAISE NOTICE 'VERIFY 65 COMPLETE: 9 sections passed, fixture rolled back.';
END
$verify$;
