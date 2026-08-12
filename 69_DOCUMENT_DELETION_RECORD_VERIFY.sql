-- ============================================================================
-- 69 — VERIFY
-- ============================================================================
--
-- Sections A–E. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, so a section that is skipped is not mistaken for one that passed.
--
-- A  the record's shape, including the deliberate ABSENCE of a foreign key
-- B  all four triggers, one of which exists only because TRUNCATE bypasses rows
-- C  no client role may execute the new functions
-- D  BEHAVIOURAL — the refusals AND the permitted case, on rows it builds
-- E  the apply recorded itself in the ledger
--
-- Section D builds its own user, farm and document and unwinds them. It never
-- touches a document that was already here: it has to DELETE something to prove
-- anything, and deleting a real document to test the deletion gate would be an
-- absurd way to find out it works.
-- ============================================================================

-- A — the record that has to outlive the row it describes.
DO $a$
DECLARE n int;
BEGIN
  IF to_regclass('public.farmer_document_deletions') IS NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: farmer_document_deletions does not exist';
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='farmer_document_deletions';
  -- 12: id, farmer_document_id, farm_id, document_type, file_name, file_url,
  -- sha256_hex, review_status_at_deletion, uploaded_at, deleted_at, deleted_by,
  -- reason. Pinned so a column cannot be added or dropped without someone
  -- deciding that the record's shape has changed.
  IF n <> 12 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: expected 12 columns on the deletion record, found %', n;
  END IF;

  -- The digest must be kept, or a file recovered from a backup cannot be
  -- matched against what was removed.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='farmer_document_deletions'
                    AND column_name='sha256_hex') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: the deletion record does not keep the digest';
  END IF;

  -- A foreign key here would make the record die with its subject.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid='public.farmer_document_deletions'::regclass
                AND contype='f' AND confrelid='public.farmer_documents'::regclass) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: a foreign key to farmer_documents would make the record impossible to keep';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.farmer_document_deletions'::regclass
                    AND conname='farmer_document_deletions_reason_is_substantive') THEN
    RAISE EXCEPTION 'VERIFY A FAILED: no substantive-reason CHECK on the deletion record';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.farmer_document_deletions'::regclass) THEN
    RAISE EXCEPTION 'VERIFY A FAILED: row level security is not enabled on the deletion record';
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: the deletion record exists, keeps the digest, has no foreign key to the row it outlives, enforces a reason, and has RLS on.';
END
$a$;

-- B — the triggers, including the one that exists solely because TRUNCATE
-- bypasses every row trigger above it.
DO $b$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgname IN ('farmer_documents_record_deletion',
                      'farmer_documents_no_truncate',
                      'farmer_document_deletions_no_update_delete',
                      'farmer_document_deletions_no_truncate');
  IF n <> 4 THEN
    RAISE EXCEPTION 'VERIFY B FAILED: expected 4 enabled triggers, found %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname='farmer_documents_record_deletion'
       AND pg_get_triggerdef(t.oid) ~ 'BEFORE DELETE') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: the deletion record is not written BEFORE DELETE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname='farmer_documents_no_truncate'
       AND pg_get_triggerdef(t.oid) ~ 'BEFORE TRUNCATE') THEN
    RAISE EXCEPTION 'VERIFY B FAILED: nothing guards TRUNCATE, which bypasses every row trigger';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: the deletion is recorded BEFORE DELETE, the record is append-only, and TRUNCATE is guarded separately because it would bypass all of it.';
END
$b$;

-- C — a client role that could execute these could write or suppress records.
DO $c$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.proname || ' → ' || coalesce(array_to_string(p.proacl,' | '),'DEFAULT (PUBLIC)'), '; ')
    INTO bad
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('record_document_deletion','refuse_document_truncate',
                       'refuse_document_deletion_mutation')
     AND (p.proacl IS NULL
          OR array_to_string(p.proacl,',') ~ '(anon|authenticated|service_role)=X');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: executable by a client role — %', bad;
  END IF;
  RAISE NOTICE 'VERIFY C PASSED: none of the three functions is executable by anon, authenticated or service_role.';
END
$c$;

-- D — the gate, exercised against real rows this section builds and unwinds.
--
-- Structural checks can prove a trigger exists. Only this can prove it refuses,
-- and — just as important — that it still ALLOWS a properly stated deletion. A
-- gate that blocks everything is not the requirement. A gate that lets nothing
-- through unrecorded is.
DO $d$
DECLARE
  v_user uuid := gen_random_uuid();
  v_farm uuid;
  v_doc  uuid;
  v_failed boolean;
  v_recorded boolean;
  v_gone boolean;
BEGIN
  BEGIN
    -- Only (id, email): the disposable substrate's auth.users has exactly
    -- id, email and raw_user_meta_data. Naming instance_id/aud/role here would
    -- pass against hosted Supabase and fail on a minimal cluster — the wrong
    -- way round for a test, and how this section failed on its first run.
    INSERT INTO auth.users (id, email)
    VALUES (v_user, 'deletion-verify@example.invalid');

    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Deletion Verify Farm', 'Approved') RETURNING id INTO v_farm;

    -- Only columns every cluster is guaranteed to have. Demanding sha256_hex
    -- here would pass on staging and fail on a minimal cluster, which is the
    -- wrong way round for a test.
    INSERT INTO public.farmer_documents (id, farm_id, document_type, file_name, review_status)
    VALUES (gen_random_uuid(), v_farm, 'coa', 'deletion-verify.pdf', 'pending')
    RETURNING id INTO v_doc;

    -- 1. No authenticated actor.
    v_failed := false;
    BEGIN
      PERFORM set_config('ddp.deletion_reason', 'A properly stated reason for removal.', true);
      DELETE FROM public.farmer_documents WHERE id = v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a document was deleted with no authenticated actor';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

    -- 2. Authenticated, but no reason stated at all.
    v_failed := false;
    BEGIN
      PERFORM set_config('ddp.deletion_reason', '', true);
      DELETE FROM public.farmer_documents WHERE id = v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a document was deleted with no stated reason';
    END IF;

    -- 3. A reason that says nothing.
    v_failed := false;
    BEGIN
      PERFORM set_config('ddp.deletion_reason', 'xxxxxxxxxxxx', true);
      DELETE FROM public.farmer_documents WHERE id = v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: one character repeated was accepted as a reason for deletion';
    END IF;

    -- 4. TRUNCATE, which bypasses all three refusals above.
    --
    -- CASCADE, deliberately. A plain TRUNCATE is already refused by PostgreSQL
    -- itself, because farmer_document_reviews holds a foreign key into this
    -- table — so testing the plain form proves nothing about this migration and
    -- would credit somebody else's refusal to our trigger. CASCADE clears that
    -- objection and reaches the guard, which is the only thing standing between
    -- one statement and every document disappearing unrecorded.
    --
    -- The refusal is matched on OUR message for the same reason: any exception
    -- would otherwise count as a pass.
    v_failed := false;
    BEGIN
      EXECUTE 'TRUNCATE public.farmer_documents CASCADE';
    EXCEPTION WHEN others THEN
      IF SQLERRM ~ 'cannot be truncated' THEN
        v_failed := true;
      ELSE
        RAISE EXCEPTION 'VERIFY D FAILED: TRUNCATE CASCADE was refused, but not by this migration — %', SQLERRM;
      END IF;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: TRUNCATE CASCADE removed every document and recorded nothing';
    END IF;

    -- 5. Named actor, real reason: allowed, and recorded.
    PERFORM set_config('ddp.deletion_reason',
                       'Fixture document removed by 69 VERIFY section D.', true);
    DELETE FROM public.farmer_documents WHERE id = v_doc;

    SELECT EXISTS (
      SELECT 1 FROM public.farmer_document_deletions
       WHERE farmer_document_id = v_doc
         AND deleted_by = v_user
         AND review_status_at_deletion = 'pending'
         AND reason = 'Fixture document removed by 69 VERIFY section D.'
    ) INTO v_recorded;
    IF NOT v_recorded THEN
      RAISE EXCEPTION 'VERIFY D FAILED: the document was deleted and no record of it was written';
    END IF;

    SELECT NOT EXISTS (SELECT 1 FROM public.farmer_documents WHERE id = v_doc) INTO v_gone;
    IF NOT v_gone THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a permitted deletion did not actually delete';
    END IF;

    -- 6. The record cannot be rewritten afterwards.
    v_failed := false;
    BEGIN
      UPDATE public.farmer_document_deletions SET reason='rewritten' WHERE farmer_document_id=v_doc;
    EXCEPTION WHEN check_violation THEN v_failed := true; END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: a deletion record was rewritten after the fact';
    END IF;

    RAISE EXCEPTION 'VERIFY_D_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VERIFY_D_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY D PASSED: deletion refused without an actor, without a reason, on a reason that says nothing, and by TRUNCATE; allowed and recorded when properly stated; and the record could not be rewritten (on rows this section built and then unwound).';
END
$d$;

-- E — an apply that leaves no record is the failure 67 exists to close, so it
-- is part of what 69 claims.
DO $e$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: no migrations ledger — apply 67 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 69 AND evidence = 'self-recorded' AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: 69 did not record itself in the ledger';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: 69 recorded its own apply in the ledger.';
END
$e$;
