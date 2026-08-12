-- ============================================================================
-- 70 — VERIFY
-- ============================================================================
--
-- Sections A–F. Each raises on failure and prints "VERIFY <letter> PASSED" on
-- success, so a section that is skipped is never mistaken for one that passed.
--
-- A  STRUCTURAL — the auditor policies exist, and nothing that blocks them is
--                 still scoped to PUBLIC
-- B  BEHAVIOURAL — become each auditing role and actually read a row
-- C  BEHAVIOURAL — the application path still works and still binds
-- D  BEHAVIOURAL — the auditing roles can read and CANNOT write
-- E  the apply recorded itself in the ledger
-- F  the standing condition the string comparison depends on
--
-- WHY B IS NOT "the SELECT did not error". Granting EXECUTE on is_ddp_admin()
-- to the auditing role would ALSO stop the error — and return zero rows for
-- ever after. A VERIFY that asserted "no exception" would have passed that
-- broken fix cheerfully. B asserts a specific row is VISIBLE, which is the only
-- claim this migration actually makes.
--
-- WHY C EXISTS AT ALL. 70 re-scopes seven live policies and reproduces their
-- predicates by hand. The failure mode that would sail past sections A and B is
-- an auditor who reads perfectly while the application has been broken or
-- widened underneath. C drives the admin path, the non-admin path and the
-- farm-member path against real rows.
--
-- Sections B, C and D build their own users, farms, documents and records and
-- unwind them via a caught exception, so nothing they create survives. They
-- never touch a pre-existing row.
-- ============================================================================

-- A — structural. Cheap, and it catches the gross error where a policy was
-- named wrongly or a re-scope was missed altogether.
DO $a$
DECLARE
  tables text[] := ARRAY['farmer_document_opens', 'farmer_document_reviews',
                         'farmer_document_deletions', 'status_history',
                         'compliance_audit_log'];
  n       int;
  stragglers text;
BEGIN
  -- The five auditor policies, each permissive, SELECT-only, and applied to
  -- PUBLIC — it must be PUBLIC, because `TO ddp_ro` cannot be created on a
  -- cluster where that role does not exist.
  SELECT count(*) INTO n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = ANY (tables)
     AND policyname LIKE '%: auditor read'
     AND permissive = 'PERMISSIVE'
     AND cmd = 'SELECT'
     AND roles::text = '{public}'
     AND qual LIKE '%ddp_ro%'
     AND qual LIKE '%ddp_audit_reader%';
  IF n <> 5 THEN
    RAISE EXCEPTION 'VERIFY A FAILED: expected 5 auditor read policies naming both auditing roles, found %', n;
  END IF;

  -- The discriminator. Any OTHER policy on these tables that is planned for a
  -- SELECT (FOR SELECT or FOR ALL) and still applies to PUBLIC will be planned
  -- for the auditing roles too, its functions will be permission-checked, and
  -- the read will error no matter how correct the auditor policy is. This is
  -- exactly how a "fix" that added only a permissive policy would look.
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname)
    INTO stragglers
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = ANY (tables)
     AND cmd IN ('SELECT', 'ALL')
     AND roles::text = '{public}'
     AND policyname NOT LIKE '%: auditor read';
  IF stragglers IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY A FAILED: these policies are still applied to PUBLIC and will be planned for the auditing roles — %',
      stragglers;
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: five auditor read policies exist on PUBLIC, and no other SELECT-planned policy on these tables still applies to PUBLIC.';
END
$a$;

-- B — behavioural. Become each auditing role and read.
DO $b$
DECLARE
  v_admin uuid := gen_random_uuid();
  v_farm  uuid;
  v_doc   uuid;
  v_role  text;
  n       bigint;
BEGIN
  BEGIN
    -- Only (id, email): the disposable substrate's auth.users has exactly id,
    -- email and raw_user_meta_data. Naming instance_id/aud/role here would pass
    -- against hosted Supabase and fail on a minimal cluster — the wrong way
    -- round for a test.
    INSERT INTO auth.users (id, email)
    VALUES (v_admin, 'auditor-verify-b@example.invalid');

    INSERT INTO public.profiles (id, email, display_name, role)
    VALUES (v_admin, 'auditor-verify-b@example.invalid', 'Auditor Verify B', 'ddp_admin')
    ON CONFLICT (id) DO UPDATE SET role = 'ddp_admin';

    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Auditor Verify Farm B', 'Approved') RETURNING id INTO v_farm;

    INSERT INTO public.farmer_documents (id, farm_id, document_type, file_name, review_status)
    VALUES (gen_random_uuid(), v_farm, 'coa', 'auditor-verify-b.pdf', 'pending')
    RETURNING id INTO v_doc;

    -- opened_by is set from the session by 68's trigger and refuses a NULL
    -- actor, so the claim has to be in place before the open is recorded.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    INSERT INTO public.farmer_document_opens (farmer_document_id) VALUES (v_doc);

    INSERT INTO public.farmer_document_reviews
      (farmer_document_id, previous_status, new_status, review_note, reviewed_by)
    VALUES (v_doc, 'pending', 'accepted', 'Probe row written by 70 VERIFY section B.', v_admin);

    INSERT INTO public.farmer_document_deletions
      (farmer_document_id, farm_id, deleted_by, reason)
    VALUES (v_doc, v_farm, v_admin, 'Probe row written by 70 VERIFY section B.');

    INSERT INTO public.status_history (entity_type, entity_id, old_status, new_status, note)
    VALUES ('farm', v_farm, 'Pending', 'Approved', 'Probe row written by 70 VERIFY section B.');

    INSERT INTO public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id)
    VALUES ('admin', v_admin, 'alert_created', 'farm', v_farm::text);

    PERFORM set_config('request.jwt.claim.sub', '', true);

    FOREACH v_role IN ARRAY ARRAY['ddp_ro', 'ddp_audit_reader'] LOOP
      -- SET LOCAL so the role cannot outlive this transaction even if the
      -- unwind below were ever removed. Dynamic SQL throughout, so each read is
      -- planned afresh under the role that is actually reading it.
      EXECUTE format('SET LOCAL ROLE %I', v_role);

      EXECUTE 'SELECT count(*) FROM public.farmer_document_opens WHERE farmer_document_id = $1'
        INTO n USING v_doc;
      IF n <> 1 THEN
        RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of farmer_document_opens, expected 1', v_role, n;
      END IF;

      EXECUTE 'SELECT count(*) FROM public.farmer_document_reviews WHERE farmer_document_id = $1'
        INTO n USING v_doc;
      IF n <> 1 THEN
        RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of farmer_document_reviews, expected 1', v_role, n;
      END IF;

      EXECUTE 'SELECT count(*) FROM public.farmer_document_deletions WHERE farmer_document_id = $1'
        INTO n USING v_doc;
      IF n <> 1 THEN
        RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of farmer_document_deletions, expected 1', v_role, n;
      END IF;

      EXECUTE 'SELECT count(*) FROM public.status_history WHERE entity_id = $1'
        INTO n USING v_farm;
      IF n <> 1 THEN
        RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of status_history, expected 1', v_role, n;
      END IF;

      EXECUTE 'SELECT count(*) FROM public.compliance_audit_log WHERE entity_id = $1'
        INTO n USING v_farm::text;
      IF n <> 1 THEN
        RAISE EXCEPTION 'VERIFY B FAILED: % saw % row(s) of compliance_audit_log, expected 1', v_role, n;
      END IF;

      RESET ROLE;
    END LOOP;

    RAISE EXCEPTION 'VERIFY_B_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'VERIFY B FAILED: an auditing role was REFUSED, not merely filtered — %. This is the defect 70 exists to close.',
        SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM <> 'VERIFY_B_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY B PASSED: ddp_ro and ddp_audit_reader each read the probe row from all five evidence tables — opens, reviews, deletions, status_history and compliance_audit_log (on rows this section built and then unwound).';
END
$b$;

-- C — behavioural. The application path is unchanged, in both directions: an
-- admin still sees everything, a non-admin still sees nothing, and a farm
-- member still sees their own farm's history and only their own.
DO $c$
DECLARE
  v_admin  uuid := gen_random_uuid();
  v_farmer uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();
  v_farm   uuid;
  v_farm2  uuid;
  v_doc    uuid;
  n        bigint;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (v_admin,  'auditor-verify-c-admin@example.invalid'),
      (v_farmer, 'auditor-verify-c-farmer@example.invalid'),
      (v_other,  'auditor-verify-c-other@example.invalid');

    INSERT INTO public.profiles (id, email, display_name, role) VALUES
      (v_admin,  'auditor-verify-c-admin@example.invalid',  'Verify C Admin',  'ddp_admin'),
      (v_farmer, 'auditor-verify-c-farmer@example.invalid', 'Verify C Farmer', 'farmer'),
      (v_other,  'auditor-verify-c-other@example.invalid',  'Verify C Other',  'pending')
    ON CONFLICT (id) DO UPDATE SET role = excluded.role;

    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Verify C Farm', 'Approved') RETURNING id INTO v_farm;
    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Verify C Other Farm', 'Approved') RETURNING id INTO v_farm2;

    INSERT INTO public.farm_memberships (farm_id, user_id, role)
    VALUES (v_farm, v_farmer, 'owner');

    INSERT INTO public.farmer_documents (id, farm_id, document_type, file_name, review_status)
    VALUES (gen_random_uuid(), v_farm, 'coa', 'auditor-verify-c.pdf', 'pending')
    RETURNING id INTO v_doc;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    INSERT INTO public.farmer_document_opens (farmer_document_id) VALUES (v_doc);
    INSERT INTO public.farmer_document_reviews
      (farmer_document_id, previous_status, new_status, review_note, reviewed_by)
    VALUES (v_doc, 'pending', 'accepted', 'Probe row written by 70 VERIFY section C.', v_admin);
    INSERT INTO public.farmer_document_deletions
      (farmer_document_id, farm_id, deleted_by, reason)
    VALUES (v_doc, v_farm, v_admin, 'Probe row written by 70 VERIFY section C.');
    INSERT INTO public.compliance_audit_log (actor_type, actor_id, action, entity_type, entity_id)
    VALUES ('admin', v_admin, 'alert_created', 'farm', v_farm::text);

    -- One history row per farm, so "sees their own" can be distinguished from
    -- "sees everything".
    INSERT INTO public.status_history (entity_type, entity_id, old_status, new_status, note)
    VALUES ('farm', v_farm,  'Pending', 'Approved', 'Probe row written by 70 VERIFY section C.'),
           ('farm', v_farm2, 'Pending', 'Approved', 'Probe row written by 70 VERIFY section C.');

    -- 1. THE ADMIN STILL READS EVERYTHING. If a re-created predicate were
    --    mangled, this is where it shows.
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    EXECUTE 'SELECT count(*) FROM public.farmer_document_opens WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read farmer_document_opens (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.farmer_document_reviews WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read farmer_document_reviews (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.farmer_document_deletions WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read farmer_document_deletions (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.compliance_audit_log WHERE entity_id = $1' INTO n USING v_farm::text;
    IF n <> 1 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read compliance_audit_log (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.status_history WHERE entity_id IN ($1, $2)' INTO n USING v_farm, v_farm2;
    IF n <> 2 THEN RAISE EXCEPTION 'VERIFY C FAILED: an admin can no longer read status_history (saw % of 2)', n; END IF;

    -- 2. A NON-ADMIN STILL SEES NOTHING. Re-scoping must not have widened
    --    anything: this proves the admin gate still binds rather than merely
    --    still existing.
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);

    EXECUTE 'SELECT count(*) FROM public.farmer_document_opens WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin read farmer_document_opens (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.farmer_document_reviews WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin read farmer_document_reviews (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.farmer_document_deletions WHERE farmer_document_id = $1' INTO n USING v_doc;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin read farmer_document_deletions (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.compliance_audit_log WHERE entity_id = $1' INTO n USING v_farm::text;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin read compliance_audit_log (saw %)', n; END IF;

    EXECUTE 'SELECT count(*) FROM public.status_history WHERE entity_id IN ($1, $2)' INTO n USING v_farm, v_farm2;
    IF n <> 0 THEN RAISE EXCEPTION 'VERIFY C FAILED: a non-admin read status_history (saw %)', n; END IF;

    -- 3. A FARM MEMBER STILL SEES THEIR OWN FARM'S HISTORY, AND ONLY THEIRS.
    --    "status_history: farmer select own" is the most intricate predicate 70
    --    re-creates, and the one most likely to be quietly mangled.
    PERFORM set_config('request.jwt.claim.sub', v_farmer::text, true);

    EXECUTE 'SELECT count(*) FROM public.status_history WHERE entity_id = $1' INTO n USING v_farm;
    IF n <> 1 THEN
      RAISE EXCEPTION 'VERIFY C FAILED: a farm member can no longer see their own farm''s status history (saw %)', n;
    END IF;

    EXECUTE 'SELECT count(*) FROM public.status_history WHERE entity_id = $1' INTO n USING v_farm2;
    IF n <> 0 THEN
      RAISE EXCEPTION 'VERIFY C FAILED: a farm member saw another farm''s status history (saw %)', n;
    END IF;

    RESET ROLE;

    RAISE EXCEPTION 'VERIFY_C_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'VERIFY C FAILED: the application path was refused outright — %', SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM <> 'VERIFY_C_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY C PASSED: an admin still reads all five tables, a non-admin still reads none of them, and a farm member still sees their own farm''s status history and not another farm''s.';
END
$c$;

-- D — behavioural. The auditing role reads. It must not write. A read-only role
-- that can write is not a read-only role, and this migration would be the
-- obvious suspect if that ever became true.
DO $d$
DECLARE
  v_farm   uuid;
  v_failed boolean;
BEGIN
  BEGIN
    INSERT INTO public.farms (id, farm_name, status)
    VALUES (gen_random_uuid(), 'Verify D Farm', 'Approved') RETURNING id INTO v_farm;

    INSERT INTO public.status_history (entity_type, entity_id, old_status, new_status, note)
    VALUES ('farm', v_farm, 'Pending', 'Approved', 'Probe row written by 70 VERIFY section D.');

    EXECUTE 'SET LOCAL ROLE ddp_ro';

    v_failed := false;
    BEGIN
      EXECUTE format(
        'INSERT INTO public.status_history (entity_type, entity_id, new_status) VALUES (''farm'', %L, ''Forged'')',
        v_farm);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: the auditing role INSERTed into status_history';
    END IF;

    v_failed := false;
    BEGIN
      EXECUTE format('UPDATE public.status_history SET new_status = ''Forged'' WHERE entity_id = %L', v_farm);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: the auditing role UPDATEd status_history';
    END IF;

    v_failed := false;
    BEGIN
      EXECUTE format('DELETE FROM public.status_history WHERE entity_id = %L', v_farm);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'VERIFY D FAILED: the auditing role DELETEd from status_history';
    END IF;

    RESET ROLE;

    RAISE EXCEPTION 'VERIFY_D_UNWIND' USING ERRCODE = 'raise_exception';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VERIFY_D_UNWIND' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'VERIFY D PASSED: the auditing role could not INSERT, UPDATE or DELETE — the read it gained is a read and nothing more.';
END
$d$;

-- E — an apply that leaves no record is the failure 67 exists to close.
DO $e$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VERIFY E FAILED: no migrations ledger — apply 67 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE number = 70 AND evidence = 'self-recorded' AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: 70 did not record its own apply in the ledger';
  END IF;
  RAISE NOTICE 'VERIFY E PASSED: 70 recorded its own apply in the ledger.';
END
$e$;

-- F — the standing condition the whole predicate rests on.
--
-- `current_user = 'ddp_ro'` is safe only while nothing else can cause
-- current_user to be that name. A SECURITY DEFINER function OWNED by an
-- auditing role would do exactly that: every caller of it would run as the
-- auditing role and could read the evidence chain through it. Measured as zero
-- on production on 2026-08-12. Asserted here so it cannot drift back.
DO $f$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname || ' owned by ' || pg_get_userbyid(p.proowner), ', ')
    INTO bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND pg_get_userbyid(p.proowner) IN ('ddp_ro', 'ddp_audit_reader');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY F FAILED: a SECURITY DEFINER function is owned by an auditing role, so any caller runs as that role and inherits its read of the evidence chain — %',
      bad;
  END IF;
  RAISE NOTICE 'VERIFY F PASSED: neither auditing role owns a SECURITY DEFINER function, so current_user cannot be either name except by authenticating as it or by SET ROLE from a superuser.';
END
$f$;
