-- =============================================================================
-- Migration 24 — VERIFY (Evidence Request & Resolution Workflow)
--
-- Production-safe: the whole script runs inside ONE transaction that ends in
-- ROLLBACK, so every fixture it creates is discarded. It contains no COMMIT.
--
-- These are BEHAVIOURAL checks, not catalog spot-checks: each section builds a
-- real fixture and proves the database actually refuses the thing the contract
-- says it must refuse. A section that cannot build its fixture RAISES rather
-- than silently passing, so the script can never pass vacuously.
--
-- Run:  psql "<connection>" -v ON_ERROR_STOP=1 -f 24_EVIDENCE_REQUEST_RESOLUTION_VERIFY.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- VERIFY A — every migration-24 object exists with the required security shape.
-- -----------------------------------------------------------------------------
DO $verify_a$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
  tables text[] := ARRAY['evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history'];
  fns text[] := ARRAY[
    'can_operationally_access_farm','create_evidence_request',
    'get_or_create_evidence_response_draft','save_evidence_response_draft',
    'submit_evidence_response','request_evidence_clarification',
    'resolve_evidence_request','reject_evidence_response','cancel_evidence_request',
    'reserve_evidence_attachment','finalize_evidence_attachment',
    'remove_draft_evidence_attachment','link_existing_evidence_document'];
  rls_off text[] := ARRAY[]::text[];
  insecure text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = f)
    THEN missing := missing || ('function ' || f); END IF;
  END LOOP;
  IF array_length(missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: missing object(s): %', array_to_string(missing, ', ');
  END IF;

  -- RLS must be enabled on all four tables.
  SELECT array_agg(c.relname::text) INTO rls_off
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY(tables) AND c.relrowsecurity = false;
  IF rls_off IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: RLS not enabled on: %', array_to_string(rls_off, ', ');
  END IF;

  -- Every RPC must be SECURITY DEFINER with an explicit search_path.
  SELECT array_agg(p.proname::text) INTO insecure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY(fns)
    AND (p.prosecdef = false OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF insecure IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY A FAILED: not SECURITY DEFINER with search_path: %',
      array_to_string(insecure, ', ');
  END IF;

  RAISE NOTICE 'VERIFY A PASSED: all migration-24 objects exist, RLS on, RPCs are SECURITY DEFINER with search_path.';
END
$verify_a$;

-- -----------------------------------------------------------------------------
-- VERIFY B — anon and authenticated hold NO direct write privilege. Every
-- mutation must go through an RPC.
-- -----------------------------------------------------------------------------
DO $verify_b$
DECLARE
  leaks text[] := ARRAY[]::text[];
  r record;
BEGIN
  FOR r IN
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history')
      AND grantee IN ('anon','authenticated','PUBLIC')
      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
  LOOP
    leaks := leaks || format('%s: %s has %s', r.table_name, r.grantee, r.privilege_type);
  END LOOP;

  IF array_length(leaks,1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY B FAILED: direct write privilege leaked: %',
      array_to_string(leaks, ' | ');
  END IF;

  -- anon must not even read.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee='anon'
      AND table_name IN ('evidence_requests','evidence_request_responses',
                         'evidence_request_attachments','evidence_request_history')
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: anon holds a privilege on an evidence table';
  END IF;

  -- There must be NO INSERT/UPDATE/DELETE policy at all on the workflow tables.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('evidence_requests','evidence_request_responses',
                        'evidence_request_attachments','evidence_request_history')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'VERIFY B FAILED: a non-SELECT policy exists on an evidence table';
  END IF;

  RAISE NOTICE 'VERIFY B PASSED: no direct DML grants or policies; anon has no access.';
END
$verify_b$;

-- -----------------------------------------------------------------------------
-- VERIFY C — scope, target and category integrity are enforced by the database,
-- using a REAL fixture (non-vacuous: the control insert must succeed first).
-- -----------------------------------------------------------------------------
DO $verify_c$
DECLARE
  farm_a      uuid;
  farm_b      uuid;
  profile_a   uuid;
  batch_a     uuid;
  actor       uuid;
  req_id      uuid;
  ok          boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: no auth.users row available to act as creator';
  END IF;

  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_a;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_b;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_a) RETURNING id INTO profile_a;
  INSERT INTO public.inventory_batches (id, farm_id, created_by)
    VALUES (gen_random_uuid(), farm_a, actor) RETURNING id INTO batch_a;

  -- C1 CONTROL: a correctly scoped farm-level request must be insertable.
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_a, 'farm_profile', profile_a, 'farm_license',
          'Licence copy', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;
  IF req_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY C FAILED: control insert produced no row (test would be vacuous)';
  END IF;

  -- C2: farm_id that does not own the target must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_b, 'farm_profile', profile_a, 'farm_license',
            'Cross-farm', 'This request deliberately points at another farm profile.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: mismatched farm_id was accepted'; END IF;

  -- C3: two targets at once must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, inventory_batch_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, batch_a, 'farm_license',
            'Two targets', 'This request deliberately carries both target ids at once.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request with two targets was accepted'; END IF;

  -- C4: no target at all must be rejected.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', 'farm_license',
            'No target', 'This request deliberately carries no target id at all.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request with no target was accepted'; END IF;

  -- C5: category/target matrix — 'coa' is batch-only, so a farm target fails.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, 'coa',
            'COA on farm', 'A COA category must never be valid for a farm-profile target.', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: coa accepted on a farm_profile target'; END IF;

  -- C6: title/explanation length floors are enforced.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_requests
      (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
    VALUES (farm_a, 'farm_profile', profile_a, 'farm_license', 'ab', 'too short', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: short title/explanation accepted'; END IF;

  -- C7: core fields are immutable after creation.
  ok := false;
  BEGIN
    UPDATE public.evidence_requests SET title = 'Renamed' WHERE id = req_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: request title was mutable after creation'; END IF;

  -- C8: requests cannot be deleted.
  ok := false;
  BEGIN
    DELETE FROM public.evidence_requests WHERE id = req_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY C FAILED: a request was deletable'; END IF;

  RAISE NOTICE 'VERIFY C PASSED: scope, target, category, length, immutability and no-delete all enforced.';
END
$verify_c$;

-- -----------------------------------------------------------------------------
-- VERIFY D — history is append-only and a submitted response is immutable.
-- -----------------------------------------------------------------------------
DO $verify_d$
DECLARE
  farm_id_v   uuid;
  profile_v   uuid;
  actor       uuid;
  req_id      uuid;
  resp_id     uuid;
  hist_id     uuid;
  ok          boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_identity',
          'Identity', 'Please provide the current farm identity documentation set.', actor)
  RETURNING id INTO req_id;

  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role, event_type)
  VALUES (req_id, NULL, 'open', actor, 'ddp_admin', 'request_created')
  RETURNING id INTO hist_id;
  IF hist_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY D FAILED: control history insert produced no row (test would be vacuous)';
  END IF;

  -- D1: history UPDATE denied.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET note = 'tampered' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: history was updatable'; END IF;

  -- D2: history DELETE denied.
  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_history WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: history was deletable'; END IF;

  -- D3: a non-creation event must carry previous_status.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_history
      (request_id, previous_status, next_status, actor_user_id, actor_role, event_type, note)
    VALUES (req_id, NULL, 'resolved', actor, 'ddp_admin', 'request_resolved', 'a valid resolution note');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: non-creation event accepted without previous_status'; END IF;

  -- D4: terminal events require a note of 10-2000 characters.
  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_history
      (request_id, previous_status, next_status, actor_user_id, actor_role, event_type, note)
    VALUES (req_id, 'farmer_submitted', 'resolved', actor, 'ddp_admin', 'request_resolved', 'short');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: terminal event accepted without a valid note'; END IF;

  -- D5: a submitted response is immutable and undeletable.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, response_text, created_by_user_id, submitted_at)
  VALUES (req_id, 1, 'submitted', 'evidence text', actor, now())
  RETURNING id INTO resp_id;

  ok := false;
  BEGIN
    UPDATE public.evidence_request_responses SET response_text = 'edited' WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a submitted response was editable'; END IF;

  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_responses WHERE id = resp_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a submitted response was deletable'; END IF;

  -- D6: only one draft may exist per request.
  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id)
  VALUES (req_id, 2, 'draft', actor);

  ok := false;
  BEGIN
    INSERT INTO public.evidence_request_responses
      (request_id, response_number, state, created_by_user_id)
    VALUES (req_id, 3, 'draft', actor);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY D FAILED: a second draft was accepted for one request'; END IF;

  RAISE NOTICE 'VERIFY D PASSED: history append-only, submitted responses immutable, single-draft enforced.';
END
$verify_d$;

-- -----------------------------------------------------------------------------
-- VERIFY E — the authorization helper fails closed.
-- -----------------------------------------------------------------------------
DO $verify_e$
DECLARE
  farm_id_v uuid;
  actor     uuid;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;

  -- With no authenticated session, auth.uid() is NULL: access must be false.
  IF public.can_operationally_access_farm(farm_id_v) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: helper granted access with no authenticated session';
  END IF;
  IF public.can_operationally_access_farm(NULL) THEN
    RAISE EXCEPTION 'VERIFY E FAILED: helper granted access for a NULL farm id';
  END IF;

  RAISE NOTICE 'VERIFY E PASSED: can_operationally_access_farm() fails closed for anonymous and NULL input.';
END
$verify_e$;

-- -----------------------------------------------------------------------------
-- VERIFY F — migrations 21 and 23 are untouched by migration 24.
-- -----------------------------------------------------------------------------
DO $verify_f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'profiles_role_check'
                   AND pg_get_constraintdef(oid) LIKE '%pending%') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 21 pending role constraint is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_new_user') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 21 handle_new_user() is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'issue_buyer_pack_snapshot') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: migration 23 issue_buyer_pack_snapshot() is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_operational_farmer_access') THEN
    RAISE EXCEPTION 'VERIFY F FAILED: has_operational_farmer_access() is missing';
  END IF;

  RAISE NOTICE 'VERIFY F PASSED: migration 21 and migration 23 objects remain intact.';
END
$verify_f$;

-- -----------------------------------------------------------------------------
-- VERIFY G — a draft attachment can be removed, and its history event survives
-- with attachment_id nulled. Proves the ON DELETE SET NULL interpretation:
-- history is preserved, only the pointer is cleared, and no other history
-- mutation is possible.
-- -----------------------------------------------------------------------------
DO $verify_g$
DECLARE
  farm_id_v uuid;
  profile_v uuid;
  actor     uuid;
  req_id    uuid;
  resp_id   uuid;
  att_id    uuid;
  hist_id   uuid;
  h         public.evidence_request_history%ROWTYPE;
  before_h  public.evidence_request_history%ROWTYPE;
  ok        boolean;
BEGIN
  SELECT id INTO actor FROM auth.users LIMIT 1;
  INSERT INTO public.farms (id, created_by) VALUES (gen_random_uuid(), actor) RETURNING id INTO farm_id_v;
  INSERT INTO public.farm_profiles (id, farm_id) VALUES (gen_random_uuid(), farm_id_v) RETURNING id INTO profile_v;
  INSERT INTO public.evidence_requests
    (farm_id, target_type, farm_profile_id, category, title, explanation, created_by_user_id)
  VALUES (farm_id_v, 'farm_profile', profile_v, 'farm_license',
          'Licence', 'Please upload the current cultivation licence document.', actor)
  RETURNING id INTO req_id;

  INSERT INTO public.evidence_request_responses
    (request_id, response_number, state, created_by_user_id)
  VALUES (req_id, 1, 'draft', actor) RETURNING id INTO resp_id;

  -- A READY upload: exactly the case the old ON DELETE RESTRICT made unremovable.
  INSERT INTO public.evidence_request_attachments
    (request_id, response_id, origin, storage_bucket, storage_object_path,
     upload_state, original_filename, mime_type, size_bytes, sha256_hex,
     created_by_user_id, finalized_at)
  VALUES (req_id, resp_id, 'request_upload', 'evidence-request-files',
          farm_id_v || '/' || req_id || '/' || resp_id || '/x/licence.pdf',
          'ready', 'licence.pdf', 'application/pdf', 1024,
          repeat('a', 64), actor, now())
  RETURNING id INTO att_id;

  INSERT INTO public.evidence_request_history
    (request_id, previous_status, next_status, actor_user_id, actor_role,
     event_type, response_id, attachment_id)
  VALUES (req_id, 'open', 'open', actor, 'farmer',
          'attachment_uploaded', resp_id, att_id)
  RETURNING id INTO hist_id;

  SELECT * INTO before_h FROM public.evidence_request_history WHERE id = hist_id;
  IF before_h.attachment_id IS NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: fixture history event has no attachment_id (test would be vacuous)';
  END IF;

  -- G1: a ready draft attachment must now be deletable (ON DELETE SET NULL).
  DELETE FROM public.evidence_request_attachments WHERE id = att_id;
  IF EXISTS (SELECT 1 FROM public.evidence_request_attachments WHERE id = att_id) THEN
    RAISE EXCEPTION 'VERIFY G FAILED: ready draft attachment was not deleted';
  END IF;

  -- G2: the history event must still exist, with ONLY attachment_id cleared.
  SELECT * INTO h FROM public.evidence_request_history WHERE id = hist_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFY G FAILED: history event disappeared when its attachment was removed';
  END IF;
  IF h.attachment_id IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY G FAILED: attachment_id was not nulled by the referential action';
  END IF;
  IF h.event_type      IS DISTINCT FROM before_h.event_type
     OR h.actor_user_id IS DISTINCT FROM before_h.actor_user_id
     OR h.actor_role    IS DISTINCT FROM before_h.actor_role
     OR h.created_at    IS DISTINCT FROM before_h.created_at
     OR h.request_id    IS DISTINCT FROM before_h.request_id
     OR h.response_id   IS DISTINCT FROM before_h.response_id
     OR h.previous_status IS DISTINCT FROM before_h.previous_status
     OR h.next_status   IS DISTINCT FROM before_h.next_status
     OR h.event_data    IS DISTINCT FROM before_h.event_data
  THEN
    RAISE EXCEPTION 'VERIFY G FAILED: the history event was altered beyond nulling attachment_id';
  END IF;

  -- G3: no OTHER history mutation is permitted — the narrow exemption must not
  -- have opened general UPDATE access.
  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET note = 'tampered' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history note became updatable'; END IF;

  ok := false;
  BEGIN
    UPDATE public.evidence_request_history SET event_type = 'request_resolved' WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history event_type became updatable'; END IF;

  ok := false;
  BEGIN
    DELETE FROM public.evidence_request_history WHERE id = hist_id;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'VERIFY G FAILED: history became deletable'; END IF;

  RAISE NOTICE 'VERIFY G PASSED: ready draft attachment removable; history preserved with attachment_id nulled; no other history mutation permitted.';
END
$verify_g$;

ROLLBACK;
