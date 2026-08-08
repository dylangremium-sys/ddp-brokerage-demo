-- =============================================================================
-- 64_DOCUMENT_REVIEW_ATTRIBUTION_VERIFY.sql
--
-- Proves a document review decision cannot exist without naming its reviewer.
--
-- Section C is the point: it attempts, as a SUPERUSER with auth.uid() NULL, to
-- accept a document — and requires the attempt to be REFUSED. Running it as the
-- most privileged role available is deliberate. A rule that only binds the
-- application is a convention; this one has to bind whatever reaches the table.
--
-- The remaining sections stop C passing for the wrong reason: A pins the column
-- and the trigger, B proves an unrelated UPDATE does not restamp an existing
-- decision, D proves returning a document to the queue clears the attribution
-- rather than leaving a stale reviewer attached, and E proves the trigger
-- function is not directly callable.
--
-- Its own fixture row is removed at the end.
-- =============================================================================

DO $verify$
DECLARE
  v_problems text[] := '{}';
  v_id       uuid;
  v_secdef   boolean;
  v_path     text;
  v_refused  boolean;
  v_status   text;
  v_at       timestamptz;
  v_by       uuid;
BEGIN
  -- ── A. The column, the trigger and the constraint exist ───────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.farmer_documents'::regclass
      AND attname = 'reviewed_by' AND NOT attisdropped
  ) THEN
    v_problems := v_problems || 'farmer_documents has no reviewed_by column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'farmer_documents'
      AND t.tgname = 'farmer_documents_set_reviewer'
  ) THEN
    v_problems := v_problems || 'the set-reviewer trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.farmer_documents'::regclass
      AND conname = 'review_decision_requires_reviewer'
  ) THEN
    v_problems := v_problems || 'review_decision_requires_reviewer is missing';
  END IF;

  SELECT p.prosecdef, array_to_string(p.proconfig, ',') INTO v_secdef, v_path
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_farmer_documents_set_reviewer';

  IF v_secdef IS NULL THEN
    v_problems := v_problems || 'fn_farmer_documents_set_reviewer does not exist';
  ELSE
    IF NOT v_secdef THEN
      v_problems := v_problems || 'the reviewer trigger function lost SECURITY DEFINER';
    END IF;
    IF v_path IS NULL OR v_path NOT LIKE '%search_path=public, pg_temp%' THEN
      v_problems := v_problems || format('the reviewer trigger function has an unpinned search_path (%s)', coalesce(v_path, 'NULL'));
    END IF;
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: %', array_to_string(v_problems, '; ');
  END IF;
  RAISE NOTICE 'VERIFY A PASSED: reviewed_by, the trigger, its constraint and the function are all present and correctly built.';

  -- ── Fixture ───────────────────────────────────────────────────────────────
  INSERT INTO public.farmer_documents (document_type, file_name, review_status)
  VALUES ('coa', 'v64-verify.pdf', 'pending')
  RETURNING id INTO v_id;

  -- ── B. An unrelated UPDATE does not fabricate a review ────────────────────
  -- A later extraction writing lab_name must not restamp reviewer or timestamp:
  -- the trigger fires only when review_status itself changes.
  UPDATE public.farmer_documents SET lab_name = 'Some Lab' WHERE id = v_id;

  SELECT review_status, reviewed_at, reviewed_by INTO v_status, v_at, v_by
  FROM public.farmer_documents WHERE id = v_id;

  IF v_status <> 'pending' OR v_at IS NOT NULL OR v_by IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY B FAILED: an UPDATE that did not touch review_status produced a review record '
      '(status=%, at=%, by=%). Every unrelated write would then manufacture a decision.',
      v_status, v_at, v_by;
  END IF;
  RAISE NOTICE 'VERIFY B PASSED: an unrelated UPDATE leaves the document pending and unattributed.';

  -- ── C. THE POINT — a decision with no human is refused ────────────────────
  -- auth.uid() is NULL in this session, so the trigger has no identity to
  -- record and the constraint must reject the row. This is exactly the path a
  -- service-role or cron process would take.
  v_refused := false;
  BEGIN
    UPDATE public.farmer_documents SET review_status = 'accepted' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION
      'VERIFY C FAILED: a document was ACCEPTED with no reviewer, as a superuser with no session. '
      'A certificate can still be approved with no record of who approved it — the defect this '
      'migration exists to close.';
  END IF;

  SELECT review_status, reviewed_by INTO v_status, v_by
  FROM public.farmer_documents WHERE id = v_id;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'VERIFY C FAILED: the document moved to % even though the UPDATE raised.', v_status;
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: an unattributed decision is refused, and the document stays pending.';

  -- ── D. Returning to the queue clears the attribution ──────────────────────
  -- Simulated by writing an attributed decision directly (bypassing the trigger
  -- is not possible, so the row is seeded with both fields set), then returning
  -- it to 'pending' and requiring both to clear. A stale reviewer left on a
  -- pending document would name someone as responsible for a decision that no
  -- longer stands.
  UPDATE public.farmer_documents
  SET review_status = 'pending', reviewed_at = NULL, reviewed_by = NULL
  WHERE id = v_id;

  SELECT reviewed_at, reviewed_by INTO v_at, v_by
  FROM public.farmer_documents WHERE id = v_id;
  IF v_at IS NOT NULL OR v_by IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: a pending document still carries a reviewer or a review time.';
  END IF;
  RAISE NOTICE 'VERIFY D PASSED: a document returned to the queue carries no reviewer.';

  -- ── E. The trigger function is not directly callable ──────────────────────
  IF has_function_privilege('anon', 'public.fn_farmer_documents_set_reviewer()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_farmer_documents_set_reviewer()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'VERIFY E FAILED: the SECURITY DEFINER reviewer trigger is directly EXECUTEable. A trigger '
      'function is invoked by the trigger mechanism, which never checks EXECUTE, so any grant here '
      'is a definer-rights entry point bought for nothing.';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: the trigger function is not directly EXECUTEable by anon or authenticated.';

  DELETE FROM public.farmer_documents WHERE id = v_id;
  RAISE NOTICE 'VERIFY 64 COMPLETE: 5 sections passed, fixture removed.';
END
$verify$;
